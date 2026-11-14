import { createHash } from "node:crypto";
import type { Db, Tx } from "./db.ts";
import { withTenant } from "./db.ts";

export type Outcome = "ejecutado" | "denegado" | "error" | "pendiente";

export interface AuditEntry {
  tenantId: string;
  agentId: string;
  agentName: string;
  userId: string;
  tool: string;
  args: unknown;
  outcome: Outcome;
  detail: unknown;
  /** Solo en acciones de una persona desde la consola: agentId y agentName son entonces los del usuario. */
  actor?: "humano";
}

const GENESIS = "0".repeat(64);

/** JSON con claves ordenadas, para que el hash no dependa del orden de escritura. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

function entryHash(prev: string, e: AuditEntry, at: string): string {
  const body = canonical({
    tenant_id: e.tenantId, at, agent_id: e.agentId, agent_name: e.agentName, user_id: e.userId,
    tool: e.tool, args: e.args, outcome: e.outcome, detail: e.detail, actor: e.actor,
  });
  return createHash("sha256").update(prev).update(body).digest("hex");
}

/** Pasa por JSON para que lo que se firma sea exactamente lo que la base devuelve al leer. */
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? {}));

/** Agrega una entrada al libro, encadenada a la ultima del mismo cliente. */
export async function appendAudit(tx: Tx, e: AuditEntry, now = new Date()): Promise<{ seq: number; hash: string }> {
  await tx.query("select pg_advisory_xact_lock(hashtext($1))", [e.tenantId]);
  const last = await tx.query<{ hash: string }>("select hash from audit_log order by seq desc limit 1");
  const prev = last.rows[0]?.hash ?? GENESIS;
  const at = now.toISOString();
  const entry = { ...e, args: plain(e.args), detail: plain(e.detail) };
  const hash = entryHash(prev, entry, at);
  const res = await tx.query<{ seq: number }>(
    `insert into audit_log (tenant_id, at, agent_id, agent_name, user_id, tool, args, outcome, detail, prev_hash, hash, actor)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning seq`,
    [e.tenantId, at, e.agentId, e.agentName, e.userId, e.tool, JSON.stringify(entry.args), e.outcome,
     JSON.stringify(entry.detail), prev, hash, e.actor ?? "agente"],
  );
  return { seq: Number(res.rows[0]!.seq), hash };
}

interface Row {
  seq: number; tenant_id: string; at: Date; agent_id: string; agent_name: string; user_id: string;
  tool: string; args: unknown; outcome: Outcome; detail: unknown; prev_hash: string; hash: string; actor: string;
}

/** Recalcula toda la cadena de un cliente. Devuelve la primera entrada alterada, si la hay. */
export async function verifyChain(db: Db, tenantId: string): Promise<{ ok: boolean; entries: number; brokenAtSeq?: number }> {
  return withTenant(db, tenantId, async (tx) => {
    const { rows } = await tx.query<Row>("select * from audit_log order by seq");
    let prev = GENESIS;
    for (const r of rows) {
      const expected = entryHash(prev, {
        tenantId: r.tenant_id, agentId: r.agent_id, agentName: r.agent_name, userId: r.user_id,
        tool: r.tool, args: r.args, outcome: r.outcome, detail: r.detail, actor: r.actor === "humano" ? "humano" : undefined,
      }, new Date(r.at).toISOString());
      if (r.prev_hash !== prev || r.hash !== expected) return { ok: false, entries: rows.length, brokenAtSeq: Number(r.seq) };
      prev = r.hash;
    }
    return { ok: true, entries: rows.length };
  });
}
