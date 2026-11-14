import { z } from "zod";
import type { Tx } from "./db.ts";
import { callXencrm, send } from "./channels.ts";
import { POLICY_KINDS, paramSchemas } from "./policies.ts";
import { hashToken, newToken } from "./tokens.ts";

export type Role = "lector" | "operador" | "admin";
export const ROLES = ["lector", "operador", "admin"] as const;

/** Quien llama y cuando: el agente ya identificado por la pasarela. */
export interface Ctx {
  tenantId: string;
  agentId: string;
  userId: string;
  now: Date;
  /** La llamada corre porque una persona la aprobo en la consola. */
  approved?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  /** Rol minimo que puede usarla, salvo permiso fino que diga otra cosa. */
  minRole: Role;
  /** Cambia datos. Las politicas de escritura solo alcanzan a estas. */
  write: boolean;
  /** Administra agentes y politicas. Queda fuera del motor de politicas para que nunca bloquee su propio arreglo. */
  governance?: boolean;
  /** En una herramienta de gobierno: llamadas que se ejecutan sin esperar a una persona. */
  immediate?(args: any): boolean;
  /** Como deshace una persona esta accion desde la consola. Sin esto, la accion no se puede revertir. */
  undo?: {
    /** Estado previo que hace falta para deshacer. Se lee antes de ejecutar. */
    before?(tx: Tx, args: any): Promise<unknown>;
    /** Deshace la accion. Lanza con la causa si otros registros dependen de este. */
    revert(tx: Tx, snap: { args: any; result: any; before: any }): Promise<void>;
  };
  /** Campos del resultado que no se guardan en el libro de auditoria. */
  secret?: string[];
  input: z.ZodRawShape;
  run(tx: Tx, ctx: Ctx, args: any): Promise<unknown>;
}

const uuid = z.string().uuid();

/** Una llamada a herramienta del modo agentico de XENCRM: de que lado, cual, con que datos y por quien. */
const xencrmCall = {
  side: z.enum(["cliente", "equipo"]), tool: z.string().min(1).max(80), args: z.record(z.string(), z.unknown()).default({}),
  by: z.string().max(120).optional(), contact: z.string().max(200).optional(),
};

/** Impide borrar un registro del que cuelgan otros: hay que revertir primero los que dependen de el. */
async function noDependents(tx: Tx, what: string, refs: [table: string, column: string][], id: string): Promise<void> {
  for (const [table, column] of refs) {
    const r = await tx.query<{ n: number }>(`select count(*)::int as n from ${table} where ${column} = $1`, [id]);
    if (r.rows[0]!.n > 0) throw new Error(`${what} tiene ${r.rows[0]!.n} registros en ${table}; revierte esos primero`);
  }
}

export const tools: Tool[] = [
  {
    name: "contact_create",
    description: "Crea un contacto en el CRM.",
    minRole: "operador",
    write: true,
    undo: {
      async revert(tx, s) {
        await noDependents(tx, "este contacto", [["deals", "contact_id"], ["activities", "contact_id"]], s.result.id);
        await tx.query("delete from contacts where id = $1", [s.result.id]);
      },
    },
    input: {
      name: z.string().min(1), email: z.string().email().optional(), phone: z.string().optional(),
      company_id: uuid.optional(), notes: z.string().optional(),
    },
    async run(tx, { tenantId }, a) {
      const r = await tx.query(
        `insert into contacts (tenant_id, name, email, phone, company_id, notes) values ($1,$2,$3,$4,$5,$6)
         returning id, name, email, phone, company_id`,
        [tenantId, a.name, a.email ?? null, a.phone ?? null, a.company_id ?? null, a.notes ?? null]);
      return r.rows[0];
    },
  },
  {
    name: "contact_update",
    description: "Actualiza campos de un contacto existente.",
    minRole: "operador",
    write: true,
    undo: {
      async before(tx, a) {
        return (await tx.query("select name, email, phone, notes, do_not_contact from contacts where id = $1", [a.id])).rows[0] ?? null;
      },
      async revert(tx, s) {
        await tx.query(
          "update contacts set name = $2, email = $3, phone = $4, notes = $5, do_not_contact = $6, updated_at = now() where id = $1",
          [s.args.id, s.before.name, s.before.email, s.before.phone, s.before.notes, s.before.do_not_contact]);
      },
    },
    input: {
      id: uuid, name: z.string().min(1).optional(), email: z.string().email().optional(),
      phone: z.string().optional(), notes: z.string().optional(),
      do_not_contact: z.boolean().optional().describe("true cuando el contacto pide no recibir mas mensajes"),
    },
    async run(tx, _ctx, a) {
      const r = await tx.query(
        `update contacts set name = coalesce($2, name), email = coalesce($3, email), phone = coalesce($4, phone),
           notes = coalesce($5, notes), do_not_contact = coalesce($6, do_not_contact), updated_at = now()
         where id = $1 returning id, name, email, phone, do_not_contact`,
        [a.id, a.name ?? null, a.email ?? null, a.phone ?? null, a.notes ?? null, a.do_not_contact ?? null]);
      if (!r.rows[0]) throw new Error("contacto no encontrado");
      return r.rows[0];
    },
  },
  {
    name: "contact_search",
    description: "Busca contactos por nombre, correo o telefono.",
    minRole: "lector",
    write: false,
    input: { query: z.string().default(""), limit: z.number().int().min(1).max(100).default(20) },
    async run(tx, _ctx, a) {
      const r = await tx.query(
        `select id, name, email, phone, company_id from contacts
         where $1 = '' or name ilike '%'||$1||'%' or email ilike '%'||$1||'%' or phone ilike '%'||$1||'%'
         order by created_at desc limit $2`, [a.query, a.limit]);
      return { contacts: r.rows };
    },
  },
  {
    name: "company_create",
    description: "Crea una empresa.",
    minRole: "operador",
    write: true,
    undo: {
      async revert(tx, s) {
        await noDependents(tx, "esta empresa", [["contacts", "company_id"], ["deals", "company_id"]], s.result.id);
        await tx.query("delete from companies where id = $1", [s.result.id]);
      },
    },
    input: { name: z.string().min(1), domain: z.string().optional() },
    async run(tx, { tenantId }, a) {
      const r = await tx.query(
        "insert into companies (tenant_id, name, domain) values ($1,$2,$3) returning id, name, domain",
        [tenantId, a.name, a.domain ?? null]);
      return r.rows[0];
    },
  },
  {
    name: "pipeline_list",
    description: "Lista los embudos de venta con sus etapas en orden.",
    minRole: "lector",
    write: false,
    input: {},
    async run(tx) {
      const r = await tx.query(
        `select p.id, p.name,
           (select json_agg(json_build_object('id', s.id, 'name', s.name, 'position', s.position) order by s.position)
              from stages s where s.pipeline_id = p.id) as stages
         from pipelines p order by p.name`);
      return { pipelines: r.rows };
    },
  },
  {
    name: "deal_create",
    description: "Crea un trato en un embudo. Si no se indica etapa, entra en la primera.",
    minRole: "operador",
    write: true,
    undo: {
      async revert(tx, s) {
        await noDependents(tx, "este trato", [["activities", "deal_id"]], s.result.id);
        await tx.query("delete from deals where id = $1", [s.result.id]);
      },
    },
    input: {
      title: z.string().min(1), pipeline_id: uuid, stage_id: uuid.optional(), contact_id: uuid.optional(),
      company_id: uuid.optional(), amount: z.number().nonnegative().optional(), currency: z.string().length(3).default("USD"),
    },
    async run(tx, { tenantId }, a) {
      const stage = a.stage_id
        ? await tx.query<{ id: string }>("select id from stages where pipeline_id = $1 and id = $2", [a.pipeline_id, a.stage_id])
        : await tx.query<{ id: string }>("select id from stages where pipeline_id = $1 order by position limit 1", [a.pipeline_id]);
      if (!stage.rows[0]) throw new Error("la etapa no pertenece a ese embudo");
      const r = await tx.query(
        `insert into deals (tenant_id, pipeline_id, stage_id, contact_id, company_id, title, amount, currency)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, title, stage_id, contact_id, amount, currency`,
        [tenantId, a.pipeline_id, stage.rows[0].id, a.contact_id ?? null, a.company_id ?? null, a.title,
         a.amount ?? null, a.currency]);
      return r.rows[0];
    },
  },
  {
    name: "deal_move_stage",
    description: "Mueve un trato a otra etapa de su mismo embudo.",
    minRole: "operador",
    write: true,
    undo: {
      async before(tx, a) {
        return (await tx.query("select stage_id from deals where id = $1", [a.id])).rows[0] ?? null;
      },
      async revert(tx, s) {
        await tx.query("update deals set stage_id = $2, updated_at = now() where id = $1", [s.args.id, s.before.stage_id]);
      },
    },
    input: { id: uuid, stage_id: uuid },
    async run(tx, _ctx, a) {
      const r = await tx.query(
        `update deals d set stage_id = s.id, updated_at = now() from stages s
         where d.id = $1 and s.id = $2 and s.pipeline_id = d.pipeline_id
         returning d.id, d.title, s.name as stage`, [a.id, a.stage_id]);
      if (!r.rows[0]) throw new Error("trato no encontrado, o la etapa es de otro embudo");
      return r.rows[0];
    },
  },
  {
    name: "deal_list",
    description: "Lista tratos, opcionalmente de un embudo.",
    minRole: "lector",
    write: false,
    input: { pipeline_id: uuid.optional(), limit: z.number().int().min(1).max(100).default(50) },
    async run(tx, _ctx, a) {
      const r = await tx.query(
        `select d.id, d.title, d.amount, d.currency, s.name as stage, c.name as contact
         from deals d join stages s on s.id = d.stage_id left join contacts c on c.id = d.contact_id
         where $1::uuid is null or d.pipeline_id = $1 order by d.created_at desc limit $2`,
        [a.pipeline_id ?? null, a.limit]);
      return { deals: r.rows };
    },
  },
  {
    name: "activity_log",
    description: "Registra una nota, llamada, correo, reunion o mensaje sobre un contacto o un trato.",
    minRole: "operador",
    write: true,
    undo: {
      async revert(tx, s) {
        await tx.query("delete from activities where id = $1", [s.result.id]);
      },
    },
    input: {
      kind: z.enum(["nota", "llamada", "correo", "reunion", "mensaje"]), body: z.string().min(1),
      contact_id: uuid.optional(), deal_id: uuid.optional(),
    },
    async run(tx, { tenantId }, a) {
      if (!a.contact_id && !a.deal_id) throw new Error("indica contact_id o deal_id");
      const r = await tx.query(
        "insert into activities (tenant_id, kind, body, contact_id, deal_id) values ($1,$2,$3,$4,$5) returning id, kind, created_at",
        [tenantId, a.kind, a.body, a.contact_id ?? null, a.deal_id ?? null]);
      return r.rows[0];
    },
  },
  {
    name: "message_send",
    description:
      "Envia un mensaje a un contacto por correo o WhatsApp y lo deja en su historial. El destino sale siempre de la ficha " +
      "del contacto. No se puede deshacer.",
    minRole: "operador",
    write: true,
    input: {
      channel: z.enum(["correo", "whatsapp"]), contact_id: uuid, body: z.string().min(1).max(4000),
      subject: z.string().min(1).max(200).optional().describe("obligatorio en correo"), deal_id: uuid.optional(),
    },
    async run(tx, { tenantId }, a) {
      const c = (await tx.query<{ name: string; email: string | null; phone: string | null; do_not_contact: boolean }>(
        "select name, email, phone, do_not_contact from contacts where id = $1", [a.contact_id])).rows[0];
      if (!c) throw new Error("contacto no encontrado");
      if (c.do_not_contact) throw new Error("el contacto pidio no ser contactado");
      const to = a.channel === "correo" ? c.email : c.phone;
      if (!to) throw new Error(`el contacto no tiene ${a.channel === "correo" ? "correo" : "telefono"}`);
      if (a.channel === "correo" && !a.subject) throw new Error("un correo necesita subject");
      const text = a.channel === "correo" ? `Asunto: ${a.subject}\n\n${a.body}` : a.body;
      const act = await tx.query<{ id: string }>(
        "insert into activities (tenant_id, kind, body, contact_id, deal_id) values ($1,$2,$3,$4,$5) returning id",
        [tenantId, a.channel === "correo" ? "correo" : "mensaje", `ENVIADO por ${a.channel} a ${to}\n${text}`, a.contact_id, a.deal_id ?? null]);
      // El envio va al final: si el proveedor falla, la transaccion se deshace y no queda una actividad de algo que no salio.
      const sent = await send({ channel: a.channel, to, name: c.name, subject: a.subject, body: a.body });
      return { activity_id: act.rows[0]!.id, channel: a.channel, to, contact: c.name, provider_id: sent.id };
    },
  },
  {
    name: "message_receive",
    description:
      "Registra un mensaje que escribio un contacto por un canal de entrada. Busca al contacto por correo o telefono, " +
      "lo crea si es nuevo y deja el mensaje en su historial. Una misma entrega no se registra dos veces.",
    minRole: "operador",
    write: true,
    input: {
      channel: z.enum(["correo", "whatsapp", "chat"]), external_id: z.string().min(1).max(200),
      body: z.string().min(1).max(8000), name: z.string().min(1).max(200).optional(),
      email: z.string().email().optional(), phone: z.string().min(5).max(40).optional(),
      subject: z.string().max(300).optional(), origin: z.string().max(300).optional(),
    },
    async run(tx, { tenantId }, a) {
      if (!a.email && !a.phone) throw new Error("indica email o phone del remitente");
      const seen = (await tx.query<{ id: string; contact_id: string }>(
        "select id, contact_id from activities where external_id = $1", [a.external_id])).rows[0];
      if (seen) return { duplicate: true, activity_id: seen.id, contact_id: seen.contact_id, contact_created: false };
      const known = (await tx.query<{ id: string }>(
        `select id from contacts
         where ($1::text is not null and lower(email) = lower($1))
            or ($2::text is not null and regexp_replace(coalesce(phone, ''), '\\D', '', 'g') = $2)
         order by created_at limit 1`, [a.email ?? null, a.phone?.replace(/\D/g, "") ?? null])).rows[0];
      const contactId = known?.id ?? (await tx.query<{ id: string }>(
        "insert into contacts (tenant_id, name, email, phone) values ($1,$2,$3,$4) returning id",
        [tenantId, a.name ?? a.email ?? a.phone, a.email ?? null, a.phone ?? null])).rows[0]!.id;
      const head = [`RECIBIDO por ${a.channel} de ${a.email ?? a.phone}`, a.origin && `Origen: ${a.origin}`, a.subject && `Asunto: ${a.subject}`];
      const act = await tx.query<{ id: string }>(
        "insert into activities (tenant_id, kind, body, contact_id, external_id) values ($1,$2,$3,$4,$5) returning id",
        [tenantId, a.channel === "correo" ? "correo" : "mensaje", `${head.filter(Boolean).join("\n")}\n\n${a.body}`, contactId, a.external_id]);
      return { duplicate: false, activity_id: act.rows[0]!.id, contact_id: contactId, contact_created: !known };
    },
  },
  {
    name: "xencrm_read",
    description:
      "Autoriza y registra una consulta del modo agentico de XENCRM (su asistente con clientes o su copiloto del equipo). " +
      "XENCRM la ejecuta solo si esta llamada sale ejecutada.",
    minRole: "operador",
    write: false,
    input: xencrmCall,
    async run() {
      return { authorized: true, runs_in: "xencrm" };
    },
  },
  {
    name: "xencrm_act",
    description:
      "Autoriza y registra una accion del modo agentico de XENCRM: segura (la hace XENCRM al salir ejecutada) o propuesta " +
      "(queda para una persona). Si una politica exige aprobacion, al aprobarla Nexarm ejecuta la ruta en XENCRM.",
    minRole: "operador",
    write: true,
    input: {
      ...xencrmCall, effect: z.enum(["seguro", "propuesto"]),
      route: z.object({
        method: z.enum(["POST", "PATCH", "PUT", "DELETE"]),
        path: z.string().min(1).max(400).regex(/^[A-Za-z0-9_\-/%.:@~]+$/).refine((p) => !p.includes(".."), "ruta invalida"),
        body: z.unknown().optional(),
      }).optional(),
    },
    async run(_tx, ctx, a) {
      if (!ctx.approved) return { authorized: true, runs_in: "xencrm" };
      if (!a.route) throw new Error("XENCRM no dio la ruta de esta accion: Nexarm no puede ejecutarla. Pidela de nuevo al asistente");
      return { authorized: true, runs_in: "nexarm", xencrm: await callXencrm(a.route) };
    },
  },
  {
    name: "activity_list",
    description: "Lee el historial de actividades de un contacto o de un trato, de la mas reciente a la mas antigua.",
    minRole: "lector",
    write: false,
    input: { contact_id: uuid.optional(), deal_id: uuid.optional(), limit: z.number().int().min(1).max(100).default(30) },
    async run(tx, _ctx, a) {
      if (!a.contact_id && !a.deal_id) throw new Error("indica contact_id o deal_id");
      const r = await tx.query(
        `select id, kind, body, contact_id, deal_id, created_at from activities
         where ($1::uuid is null or contact_id = $1) and ($2::uuid is null or deal_id = $2)
         order by created_at desc, id limit $3`, [a.contact_id ?? null, a.deal_id ?? null, a.limit]);
      return { activities: r.rows };
    },
  },
  {
    name: "audit_query",
    description: "Lee el libro de auditoria: que agente hizo que, con que datos y cuando.",
    minRole: "admin",
    write: false,
    input: {
      agent_name: z.string().optional(), tool: z.string().optional(),
      outcome: z.enum(["ejecutado", "denegado", "error"]).optional(), limit: z.number().int().min(1).max(200).default(50),
    },
    async run(tx, _ctx, a) {
      const r = await tx.query(
        `select seq, at, agent_name, user_id, tool, args, outcome, detail, hash from audit_log
         where ($1::text is null or agent_name = $1) and ($2::text is null or tool = $2) and ($3::text is null or outcome = $3)
         order by seq desc limit $4`,
        [a.agent_name ?? null, a.tool ?? null, a.outcome ?? null, a.limit]);
      return { entries: r.rows };
    },
  },
  {
    name: "agent_list",
    description: "Lista los agentes del cliente con su rol, estado, vencimiento y permisos finos.",
    minRole: "admin",
    write: false,
    governance: true,
    input: {},
    async run(tx) {
      const r = await tx.query(
        `select a.id, a.name, a.role, a.suspended, a.expires_at,
           coalesce((select json_agg(json_build_object('tool', g.tool, 'effect', g.effect) order by g.tool)
                     from agent_grants g where g.agent_id = a.id), '[]'::json) as grants
         from agents a order by a.name`);
      return { agents: r.rows };
    },
  },
  {
    name: "agent_create",
    description: "Crea un agente con un rol y devuelve su token una sola vez. Actua en nombre del mismo usuario que quien lo crea.",
    minRole: "admin",
    write: true,
    governance: true,
    secret: ["token"],
    input: { name: z.string().min(1), role: z.enum(ROLES), expires_in_days: z.number().int().positive().max(365).optional() },
    async run(tx, ctx, a) {
      const token = newToken();
      const expiresAt = a.expires_in_days ? new Date(ctx.now.getTime() + a.expires_in_days * 86_400_000).toISOString() : null;
      const r = await tx.query(
        `insert into agents (tenant_id, name, role, on_behalf_of, token_hash, expires_at) values ($1,$2,$3,$4,$5,$6)
         returning id, name, role, expires_at`,
        [ctx.tenantId, a.name, a.role, ctx.userId, hashToken(token), expiresAt]);
      return { ...(r.rows[0] as object), token };
    },
  },
  {
    name: "agent_rotate_token",
    description: "Invalida el token de un agente y devuelve uno nuevo una sola vez.",
    minRole: "admin",
    write: true,
    governance: true,
    secret: ["token"],
    input: { id: uuid, expires_in_days: z.number().int().positive().max(365).optional() },
    async run(tx, ctx, a) {
      const token = newToken();
      const expiresAt = a.expires_in_days ? new Date(ctx.now.getTime() + a.expires_in_days * 86_400_000).toISOString() : null;
      const r = await tx.query(
        "update agents set token_hash = $2, expires_at = $3 where id = $1 returning id, name, expires_at",
        [a.id, hashToken(token), expiresAt]);
      if (!r.rows[0]) throw new Error("agente no encontrado");
      return { ...(r.rows[0] as object), token };
    },
  },
  {
    name: "agent_suspend",
    description: "Suspende o reactiva un agente. Un agente suspendido no ejecuta nada.",
    minRole: "admin",
    write: true,
    governance: true,
    input: { id: uuid, suspended: z.boolean() },
    // Frenar es urgente y seguro; reactivar espera aprobacion.
    immediate: (a) => a.suspended === true,
    async run(tx, ctx, a) {
      if (a.id === ctx.agentId) throw new Error("un agente no puede suspenderse a si mismo");
      const r = await tx.query("update agents set suspended = $2 where id = $1 returning id, name, suspended", [a.id, a.suspended]);
      if (!r.rows[0]) throw new Error("agente no encontrado");
      return r.rows[0];
    },
  },
  {
    name: "agent_grant_set",
    description: "Permiso fino: permite o deniega una herramienta a un agente por encima de su rol. Con heredar vuelve al rol.",
    minRole: "admin",
    write: true,
    governance: true,
    input: { agent_id: uuid, tool: z.string().min(1), effect: z.enum(["permitir", "denegar", "heredar"]) },
    async run(tx, ctx, a) {
      if (!tools.some((t) => t.name === a.tool)) throw new Error("herramienta desconocida");
      if (a.agent_id === ctx.agentId) throw new Error("un agente no puede cambiar sus propios permisos");
      const agent = await tx.query("select id from agents where id = $1", [a.agent_id]);
      if (!agent.rows[0]) throw new Error("agente no encontrado");
      if (a.effect === "heredar") {
        await tx.query("delete from agent_grants where agent_id = $1 and tool = $2", [a.agent_id, a.tool]);
      } else {
        await tx.query(
          `insert into agent_grants (agent_id, tenant_id, tool, effect) values ($1,$2,$3,$4)
           on conflict (agent_id, tool) do update set effect = excluded.effect`,
          [a.agent_id, ctx.tenantId, a.tool, a.effect]);
      }
      return { agent_id: a.agent_id, tool: a.tool, effect: a.effect };
    },
  },
  {
    name: "policy_set",
    description:
      "Crea o actualiza una politica por nombre. Tipos: monto_maximo {campo, maximo}; limite_frecuencia {maximo, ventana_minutos}; " +
      "horario {zona, dias (0 = domingo), desde, hasta}; campos_restringidos {campos}; requiere_aprobacion {campo, desde, vence_horas}. Sin agent_id o sin tool aplica a todos.",
    minRole: "admin",
    write: true,
    governance: true,
    input: {
      name: z.string().min(1), kind: z.enum(POLICY_KINDS), params: z.record(z.string(), z.unknown()),
      agent_id: uuid.optional(), tool: z.string().optional(), applies_to: z.enum(["escritura", "todas"]).optional(),
      enabled: z.boolean().default(true),
    },
    async run(tx, ctx, a) {
      const params = paramSchemas[a.kind as keyof typeof paramSchemas].safeParse(a.params);
      if (!params.success) throw new Error(params.error.issues.map((i) => `params.${i.path.join(".")}: ${i.message}`).join("; "));
      if (a.tool && !tools.some((t) => t.name === a.tool)) throw new Error("herramienta desconocida");
      if (a.agent_id && !(await tx.query("select id from agents where id = $1", [a.agent_id])).rows[0]) throw new Error("agente no encontrado");
      const appliesTo = a.applies_to ?? (a.kind === "campos_restringidos" ? "todas" : "escritura");
      const r = await tx.query(
        `insert into policies (tenant_id, name, kind, params, agent_id, tool, applies_to, enabled) values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (tenant_id, name) do update set kind = excluded.kind, params = excluded.params, agent_id = excluded.agent_id,
           tool = excluded.tool, applies_to = excluded.applies_to, enabled = excluded.enabled
         returning id, name, kind, params, agent_id, tool, applies_to, enabled`,
        [ctx.tenantId, a.name, a.kind, JSON.stringify(params.data), a.agent_id ?? null, a.tool ?? null, appliesTo, a.enabled]);
      return r.rows[0];
    },
  },
  {
    name: "policy_list",
    description: "Lista las politicas del cliente.",
    minRole: "admin",
    write: false,
    governance: true,
    input: {},
    async run(tx) {
      const r = await tx.query("select id, name, kind, params, agent_id, tool, applies_to, enabled from policies order by name");
      return { policies: r.rows };
    },
  },
  {
    name: "approval_status",
    description: "Consulta una aprobacion que este agente dejo pendiente: estado, decision y resultado si ya se ejecuto.",
    minRole: "lector",
    write: false,
    governance: true,
    input: { id: uuid },
    async run(tx, ctx, a) {
      const r = await tx.query(
        `select id, tool, reason, policy, requested_at, expires_at, decided_at, note, result,
           case when status = 'pendiente' and expires_at <= $3 then 'vencida' else status end as status
         from approvals where id = $1 and agent_id = $2`, [a.id, ctx.agentId, ctx.now.toISOString()]);
      if (!r.rows[0]) throw new Error("aprobacion no encontrada");
      return r.rows[0];
    },
  },
];
