import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { INTAKE_AGENT } from "./chatwoot.ts";
import { XENCRM_AGENT, XENCRM_AGENTIC } from "./xencrm.ts";
import { openDb, type Db } from "./db.ts";
import { hashPassword } from "./humans.ts";
import { SALES_AGENTS } from "./sales/agents.ts";
import { hashToken, newToken } from "./tokens.ts";
import { tools, type Role } from "./tools.ts";

const STAGES = ["Prospecto", "Calificado", "Demo", "Propuesta", "Ganado", "Perdido"];
const AGENTS: [string, Role][] = [["agente-ventas", "operador"], ["supervisor", "admin"], ["observador", "lector"]];

/** Limites con los que arranca la venta propia. Se cambian despues por MCP con aprobacion de una persona. */
const SALES_POLICIES: { name: string; kind: string; params: object; tool: string | null }[] = [
  { name: "tratos-grandes", kind: "requiere_aprobacion", params: { campo: "amount", desde: 10000, vence_horas: 24 }, tool: "deal_create" },
  { name: "ritmo-de-escritura", kind: "limite_frecuencia", params: { maximo: 60, ventana_minutos: 60 }, tool: null },
  { name: "mensajes-con-aprobacion", kind: "requiere_aprobacion", params: { campo: "amount", vence_horas: 48 }, tool: "message_send" },
  { name: "tope-de-mensajes", kind: "limite_frecuencia", params: { maximo: 20, ventana_minutos: 1440 }, tool: "message_send" },
];

export interface Seeded {
  tenantId: string;
  pipelineId: string;
  /** Solo de los agentes creados en esta corrida: el token de uno existente no se puede recuperar. */
  tokens: Record<string, string>;
  /** clave llega vacia si el usuario ya tenia una. */
  consola: { usuario: string; clave: string };
}

/**
 * Crea lo que falte de un cliente: usuario supervisor, embudo de venta y agentes. No rota credenciales existentes.
 * Con ventas, agrega los agentes de venta propios y el de entrada, con sus permisos finos y las politicas de arranque.
 */
export async function seed(db: Db, tenantName = "Nexarm", userName = "Eathan Jimenez", opts: { ventas?: boolean } = {}): Promise<Seeded> {
  const tenantId = (await db.query<{ id: string }>(
    "insert into tenants (name) values ($1) on conflict (name) do update set name = excluded.name returning id", [tenantName])).rows[0]!.id;
  const existing = await db.query<{ id: string; password_hash: string | null }>(
    "select id, password_hash from users where tenant_id = $1 and name = $2", [tenantId, userName]);
  const userId = existing.rows[0]?.id ?? (await db.query<{ id: string }>(
    "insert into users (tenant_id, name) values ($1, $2) returning id", [tenantId, userName])).rows[0]!.id;
  const usuario = userName.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  let clave = "";
  if (!existing.rows[0]?.password_hash) {
    clave = randomBytes(12).toString("base64url");
    await db.query("update users set role = 'supervisor', login = $2, password_hash = $3 where id = $1", [userId, usuario, hashPassword(clave)]);
  }
  const pipelineId = (await db.query<{ id: string }>(
    `insert into pipelines (tenant_id, name) values ($1, $2)
     on conflict (tenant_id, name) do update set name = excluded.name returning id`, [tenantId, `Venta de ${tenantName}`])).rows[0]!.id;
  for (const [i, name] of STAGES.entries()) {
    await db.query(
      "insert into stages (tenant_id, pipeline_id, name, position) values ($1,$2,$3,$4) on conflict (pipeline_id, name) do nothing",
      [tenantId, pipelineId, name, i + 1]);
  }

  const tokens: Record<string, string> = {};
  const createAgent = async (name: string, role: Role): Promise<string | null> => {
    const token = newToken();
    const r = await db.query<{ id: string }>(
      `insert into agents (tenant_id, name, role, on_behalf_of, token_hash) values ($1,$2,$3,$4,$5)
       on conflict (tenant_id, name) do nothing returning id`, [tenantId, name, role, userId, hashToken(token)]);
    if (r.rows[0]) tokens[name] = token;
    return r.rows[0]?.id ?? null;
  };
  for (const [name, role] of AGENTS) await createAgent(name, role);

  if (opts.ventas) {
    // Minimo privilegio: a cada agente de venta se le deniega toda herramienta de operador que su trabajo no usa.
    const operatorTools = tools.filter((t) => t.minRole !== "admin").map((t) => t.name);
    // Los agentes de entrada solo registran lo que llega de Chatwoot y de XENCRM.
    const intakes = [INTAKE_AGENT, XENCRM_AGENT].map((name) => ({ name, role: "operador" as Role, tools: ["message_receive"] }));
    // El modo agentico de XENCRM solo pide permiso para sus propias herramientas.
    const agentic = { name: XENCRM_AGENTIC, role: "operador" as Role, tools: ["xencrm_read", "xencrm_act"] };
    for (const agent of [...SALES_AGENTS, ...intakes, agentic]) {
      const id = await createAgent(agent.name, agent.role) ?? (await db.query<{ id: string }>(
        "select id from agents where tenant_id = $1 and name = $2", [tenantId, agent.name])).rows[0]!.id;
      // Tambien en agentes que ya existian: una herramienta nueva nace denegada para quien no la usa.
      for (const tool of operatorTools.filter((t) => !agent.tools.includes(t))) {
        await db.query(
          "insert into agent_grants (agent_id, tenant_id, tool, effect) values ($1,$2,$3,'denegar') on conflict (agent_id, tool) do nothing",
          [id, tenantId, tool]);
      }
    }
    for (const p of SALES_POLICIES) {
      await db.query(
        "insert into policies (tenant_id, name, kind, params, tool) values ($1,$2,$3,$4,$5) on conflict (tenant_id, name) do nothing",
        [tenantId, p.name, p.kind, JSON.stringify(p.params), p.tool]);
    }
  }
  return { tenantId, pipelineId, tokens, consola: { usuario, clave } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const file = ".tokens.local.json";
  const db = await openDb(process.env.NEXARM_DATA ?? "./data/pg");
  const out = await seed(db, undefined, undefined, { ventas: true });
  await db.close();
  const prev: Partial<Seeded> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const merged: Seeded = {
    ...out,
    tokens: { ...prev.tokens, ...out.tokens },
    consola: { usuario: out.consola.usuario, clave: out.consola.clave || prev.consola?.clave || "" },
  };
  writeFileSync(file, JSON.stringify(merged, null, 2));
  const created = Object.keys(out.tokens);
  console.log(`Cliente cero listo. ${created.length ? `Agentes nuevos: ${created.join(", ")}.` : "Sin agentes nuevos."} Credenciales en ${file}`);
}
