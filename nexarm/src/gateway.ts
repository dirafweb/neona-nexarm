import { z } from "zod";
import type { Db, Tx } from "./db.ts";
import { withTenant } from "./db.ts";
import { appendAudit, type Outcome } from "./audit.ts";
import { evaluatePolicies, PolicyDenied, type ApprovalNeed } from "./policies.ts";
import { hashToken } from "./tokens.ts";
import { tools, type Role, type Tool } from "./tools.ts";

export interface Agent {
  id: string; tenantId: string; name: string; role: Role; userId: string; suspended: boolean; expiresAt: Date | null;
}

/** Persona con sesion en la consola. Solo un supervisor decide aprobaciones. */
export interface Human { id: string; tenantId: string; name: string; role: "miembro" | "supervisor" }

export interface Result {
  outcome: Outcome; data?: unknown; reason?: string; policy?: string; approvalId?: string; auditSeq: number;
}

const rank: Record<Role, number> = { lector: 1, operador: 2, admin: 3 };
const byName = new Map<string, Tool>(tools.map((t) => [t.name, t]));
const writeTools = tools.filter((t) => t.write).map((t) => t.name);
const GOVERNANCE_HOURS = 24;

/** Paso 1, identificar: de un token fijo o de un token OAuth vigente a un agente con cliente, rol y usuario. */
export async function identify(db: Db, token: string, now = new Date()): Promise<Agent | null> {
  const r = await db.query<{
    id: string; tenant_id: string; name: string; role: Role; on_behalf_of: string; suspended: boolean; expires_at: Date | null;
  }>(
    `select id, tenant_id, name, role, on_behalf_of, suspended, expires_at from agents
     where token_hash = $1
        or id = (select agent_id from oauth_tokens where token_hash = $1 and kind = 'acceso' and expires_at > $2)`,
    [hashToken(token), now.toISOString()]);
  const a = r.rows[0];
  return a ? {
    id: a.id, tenantId: a.tenant_id, name: a.name, role: a.role, userId: a.on_behalf_of, suspended: a.suspended,
    expiresAt: a.expires_at && new Date(a.expires_at),
  } : null;
}

/** Sustituye por una marca los campos indicados, a cualquier profundidad. */
function mask(value: unknown, fields: ReadonlySet<string>, mark: string): unknown {
  if (Array.isArray(value)) return value.map((v) => mask(v, fields, mark));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, fields.has(k) && v !== null ? mark : mask(v, fields, mark)]));
}

const auditBase = (agent: Agent, tool: string) =>
  ({ tenantId: agent.tenantId, agentId: agent.id, agentName: agent.name, userId: agent.userId, tool });

/** Ejecuta la herramienta y la registra en la misma transaccion. Devuelve el resultado visible y el que se guarda. */
async function runAndRecord(
  tx: Tx, agent: Agent, tool: Tool, args: Record<string, unknown>, restricted: ReadonlySet<string>, now: Date,
  extra: Record<string, unknown> = {},
): Promise<{ data: unknown; stored: unknown; seq: number }> {
  const before = tool.undo?.before ? await tool.undo.before(tx, args) : null;
  const raw = await tool.run(tx, { tenantId: agent.tenantId, agentId: agent.id, userId: agent.userId, now, approved: "aprobacion" in extra }, args);
  const data = mask(JSON.parse(JSON.stringify(raw ?? null)), restricted, "[restringido]");
  const stored = mask(data, new Set(tool.secret), "[secreto]");
  const { seq } = await appendAudit(tx, {
    ...auditBase(agent, tool.name), args, outcome: "ejecutado",
    detail: { result: stored, campos_restringidos: [...restricted].sort(), ...extra },
  }, now);
  if (tool.undo) {
    await tx.query(
      "insert into undo_snapshots (audit_seq, tenant_id, tool, args, before, result) values ($1,$2,$3,$4,$5,$6)",
      [seq, agent.tenantId, tool.name, JSON.stringify(args), JSON.stringify(before), JSON.stringify(raw ?? null)]);
  }
  return { data, stored, seq };
}

/**
 * Unica puerta de entrada al CRM: autoriza, evalua politicas, ejecuta o deja pendiente de una persona, y registra.
 * La accion y su entrada de auditoria van en la misma transaccion: no existe una sin la otra.
 */
export async function execute(db: Db, agent: Agent, toolName: string, rawArgs: unknown, now = new Date()): Promise<Result> {
  const base = auditBase(agent, toolName);
  const record = (outcome: Outcome, args: unknown, detail: unknown) =>
    withTenant(db, agent.tenantId, (tx) => appendAudit(tx, { ...base, args, outcome, detail }, now));
  const deny = async (reason: string, args: unknown = rawArgs ?? {}, policy?: string): Promise<Result> =>
    ({ outcome: "denegado", reason, policy, auditSeq: (await record("denegado", args, { reason, policy })).seq });

  const tool = byName.get(toolName);
  if (!tool) return deny("herramienta desconocida");
  if (agent.suspended) return deny("agente suspendido");
  if (agent.expiresAt && agent.expiresAt <= now) return deny("credencial vencida");

  const state = await withTenant(db, agent.tenantId, (tx) => tx.query<{ paused: boolean; effect: string | null }>(
    `select (select paused from tenants) as paused,
            (select effect from agent_grants where agent_id = $1 and tool = $2) as effect`, [agent.id, toolName]));
  if (state.rows[0]?.paused) return deny("operacion detenida por una persona: ningun agente ejecuta hasta que la reanude");
  const effect = state.rows[0]?.effect;
  if (effect === "denegar") return deny(`permiso fino: ${toolName} denegada a este agente`);
  if (effect !== "permitir" && rank[agent.role] < rank[tool.minRole]) {
    return deny(`el rol ${agent.role} no puede usar ${toolName}; requiere ${tool.minRole}`);
  }

  const parsed = z.object(tool.input).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const reason = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { outcome: "error", reason, auditSeq: (await record("error", rawArgs ?? {}, { reason })).seq };
  }
  const args = parsed.data as Record<string, unknown>;

  try {
    return await withTenant(db, agent.tenantId, async (tx): Promise<Result> => {
      // El candado va antes de evaluar: dos llamadas simultaneas no pueden pasar juntas un limite de frecuencia.
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [agent.tenantId]);
      let restricted = new Set<string>();
      let need: ApprovalNeed | undefined;
      if (!tool.governance) {
        ({ restricted, approval: need } =
          await evaluatePolicies(tx, { agentId: agent.id, tool: toolName, isWrite: tool.write, writeTools, args, now }));
      } else if (tool.write && !tool.immediate?.(args)) {
        const t = await tx.query<{ governance_approval: boolean }>("select governance_approval from tenants");
        if (t.rows[0]?.governance_approval) {
          need = { reason: `${toolName} cambia el gobierno: requiere aprobacion humana`, hours: GOVERNANCE_HOURS };
        }
      }

      if (need) {
        const expires = new Date(now.getTime() + need.hours * 3_600_000).toISOString();
        const ap = await tx.query<{ id: string }>(
          `insert into approvals (tenant_id, agent_id, tool, args, restricted, reason, policy, requested_at, expires_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
          [agent.tenantId, agent.id, toolName, JSON.stringify(args), JSON.stringify([...restricted]), need.reason,
           need.policy ?? null, now.toISOString(), expires]);
        const approvalId = ap.rows[0]!.id;
        const { seq } = await appendAudit(tx, {
          ...base, args, outcome: "pendiente",
          detail: { reason: need.reason, policy: need.policy, aprobacion: approvalId, vence: expires },
        }, now);
        return { outcome: "pendiente", reason: need.reason, policy: need.policy, approvalId, auditSeq: seq };
      }

      const { data, seq } = await runAndRecord(tx, agent, tool, args, restricted, now);
      return { outcome: "ejecutado", data, auditSeq: seq };
    });
  } catch (err) {
    if (err instanceof PolicyDenied) return deny(err.message, args, err.policy);
    const reason = err instanceof Error ? err.message : String(err);
    return { outcome: "error", reason, auditSeq: (await record("error", args, { reason })).seq };
  }
}

export interface Decision { ok: boolean; status?: string; reason?: string; tool?: string; agent?: string; data?: unknown }

interface ApprovalRow {
  id: string; agent_id: string; tool: string; args: Record<string, unknown>; restricted: string[]; status: string; expires_at: Date;
}

/**
 * Una persona aprueba o rechaza una llamada pendiente. Al aprobar, la llamada se ejecuta como el agente que la pidio.
 * La decision, la ejecucion y sus dos entradas de auditoria van en la misma transaccion.
 * Ningun agente llega aqui: no existe herramienta MCP que decida aprobaciones.
 */
export async function decide(
  db: Db, human: Human, approvalId: string, decision: "aprobar" | "rechazar", note: string, now = new Date(),
): Promise<Decision> {
  if (human.role !== "supervisor") return { ok: false, reason: "solo un supervisor decide aprobaciones" };
  const humanEntry = (detail: unknown) => ({
    tenantId: human.tenantId, agentId: human.id, agentName: human.name, userId: human.id, actor: "humano" as const,
    tool: "approval_decide", args: { aprobacion: approvalId, decision, nota: note }, outcome: "ejecutado" as const, detail,
  });
  const load = async (tx: Tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", [human.tenantId]);
    const ap = (await tx.query<ApprovalRow>(
      "select id, agent_id, tool, args, restricted, status, expires_at from approvals where id = $1 for update", [approvalId])).rows[0];
    if (!ap) return null;
    const a = (await tx.query<{ id: string; name: string; role: Role; on_behalf_of: string; suspended: boolean }>(
      "select id, name, role, on_behalf_of, suspended from agents where id = $1", [ap.agent_id])).rows[0]!;
    const agent: Agent = {
      id: a.id, tenantId: human.tenantId, name: a.name, role: a.role, userId: a.on_behalf_of, suspended: a.suspended, expiresAt: null,
    };
    return { ap, agent };
  };
  const close = (tx: Tx, status: string, result: unknown = null, text = note) => tx.query(
    "update approvals set status = $2, decided_by = $3, decided_at = $4, note = $5, result = $6 where id = $1",
    [approvalId, status, human.id, now.toISOString(), text, result === null ? null : JSON.stringify(result)]);

  try {
    return await withTenant(db, human.tenantId, async (tx): Promise<Decision> => {
      const found = await load(tx);
      if (!found) return { ok: false, reason: "aprobacion no encontrada" };
      const { ap, agent } = found;
      const tool = byName.get(ap.tool)!;
      const info = { tool: ap.tool, agent: agent.name };
      if (ap.status !== "pendiente") return { ok: false, reason: `la aprobacion ya esta ${ap.status}`, ...info };
      if (new Date(ap.expires_at) <= now) {
        await close(tx, "vencida", null, "vencio sin decision");
        await appendAudit(tx, { ...auditBase(agent, ap.tool), args: ap.args, outcome: "denegado",
          detail: { reason: "la aprobacion vencio sin decision", aprobacion: ap.id } }, now);
        return { ok: false, status: "vencida", reason: "la aprobacion vencio", ...info };
      }
      if (decision === "rechazar") {
        await close(tx, "rechazada");
        await appendAudit(tx, humanEntry({ ...info, estado: "rechazada" }), now);
        await appendAudit(tx, { ...auditBase(agent, ap.tool), args: ap.args, outcome: "denegado",
          detail: { reason: "rechazada por una persona", aprobacion: ap.id, rechazada_por: human.name, nota: note } }, now);
        return { ok: true, status: "rechazada", ...info };
      }
      if (agent.suspended) return { ok: false, reason: "el agente esta suspendido; reactivalo o rechaza la solicitud", ...info };
      await appendAudit(tx, humanEntry({ ...info, estado: "aprobada" }), now);
      const { data, stored } = await runAndRecord(tx, agent, tool, ap.args, new Set(ap.restricted), now,
        { aprobacion: ap.id, aprobada_por: human.name });
      await close(tx, "aprobada", stored);
      return { ok: true, status: "aprobada", data, ...info };
    });
  } catch (err) {
    // La herramienta fallo al ejecutarse: la transaccion se deshizo. Queda registrado el intento y su causa.
    const reason = err instanceof Error ? err.message : String(err);
    return withTenant(db, human.tenantId, async (tx): Promise<Decision> => {
      const found = await load(tx);
      if (!found || found.ap.status !== "pendiente") return { ok: false, reason };
      const { ap, agent } = found;
      await close(tx, "error", null, reason);
      await appendAudit(tx, humanEntry({ tool: ap.tool, agent: agent.name, estado: "error" }), now);
      await appendAudit(tx, { ...auditBase(agent, ap.tool), args: ap.args, outcome: "error",
        detail: { reason, aprobacion: ap.id, aprobada_por: human.name } }, now);
      return { ok: false, status: "error", reason, tool: ap.tool, agent: agent.name };
    });
  }
}

interface SnapshotRow {
  audit_seq: number; tool: string; args: any; before: any; result: any; reverted_at: Date | null; agent_name: string;
}

/**
 * Una persona deshace una accion ejecutada por un agente. Las acciones sobre un mismo registro se revierten
 * de la mas reciente a la mas antigua, y un registro del que dependen otros no se borra.
 * La reversion queda en el libro como una entrada nueva: la entrada original no se toca.
 */
export async function revert(db: Db, human: Human, seq: number, now = new Date()): Promise<Decision> {
  if (human.role !== "supervisor") return { ok: false, reason: "solo un supervisor revierte acciones" };
  try {
    return await withTenant(db, human.tenantId, async (tx): Promise<Decision> => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [human.tenantId]);
      const snap = (await tx.query<SnapshotRow>(
        `select u.audit_seq, u.tool, u.args, u.before, u.result, u.reverted_at, a.agent_name
         from undo_snapshots u join audit_log a on a.seq = u.audit_seq where u.audit_seq = $1 for update of u`, [seq])).rows[0];
      if (!snap) return { ok: false, reason: "esta accion no se puede revertir" };
      const info = { tool: snap.tool, agent: snap.agent_name };
      if (snap.reverted_at) return { ok: false, reason: "esta accion ya fue revertida", ...info };
      const record = snap.args?.id ?? snap.result?.id;
      const later = await tx.query<{ audit_seq: number; tool: string }>(
        `select audit_seq, tool from undo_snapshots
         where audit_seq > $1 and reverted_at is null and coalesce(args->>'id', result->>'id') = $2 order by audit_seq desc limit 1`,
        [seq, record]);
      if (later.rows[0]) {
        return { ok: false, reason: `el registro cambio despues: revierte primero la accion #${later.rows[0].audit_seq} (${later.rows[0].tool})`, ...info };
      }
      await byName.get(snap.tool)!.undo!.revert(tx, snap);
      await tx.query("update undo_snapshots set reverted_at = $2, reverted_by = $3 where audit_seq = $1", [seq, now.toISOString(), human.id]);
      await appendAudit(tx, {
        tenantId: human.tenantId, agentId: human.id, agentName: human.name, userId: human.id, actor: "humano",
        tool: "revert", args: { accion: seq }, outcome: "ejecutado", detail: { ...info, registro: record },
      }, now);
      return { ok: true, status: "revertida", ...info };
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
