import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db.ts";
import { seed } from "../src/seed.ts";
import { createApp } from "../src/server.ts";
import { verifyChain } from "../src/audit.ts";

// Miercoles 10:00 en Bogota. Las pruebas mueven este reloj.
const MIERCOLES = new Date("2026-11-11T15:00:00Z");
const DOMINGO = new Date("2026-11-15T15:00:00Z");
let clock = MIERCOLES;
const minutes = (n: number) => new Date(clock.getTime() + n * 60_000);

const db = await openDb();
const nexarm = await seed(db, "Nexarm");
const otro = await seed(db, "Cliente Demo", "Usuario Demo");
// Estas pruebas cubren el gobierno directo por agente; la aprobacion humana se prueba en la fase 3.
await db.query("update tenants set governance_approval = false");
const http = createApp(db, () => clock).listen(0, "127.0.0.1");
await new Promise((r) => http.once("listening", r));
const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);

async function connect(token: string) {
  const client = new Client({ name: "prueba", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse((res.content as { text: string }[])[0]!.text) as
    { outcome: string; data?: any; reason?: string; policy?: string; auditSeq: number };
}
async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await call(client, name, args);
  assert.equal(res.outcome, "ejecutado", `${name}: ${res.reason}`);
  return res.data;
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const ventas = await connect(nexarm.tokens["agente-ventas"]!);
const supervisor = await connect(nexarm.tokens["supervisor"]!);
const observador = await connect(nexarm.tokens["observador"]!);
const agents: Record<string, string> = Object.fromEntries(
  (await ok(supervisor, "agent_list")).agents.map((a: any) => [a.name, a.id]));

let soporteToken = "";

await check("solo un admin administra agentes y politicas", async () => {
  const args = { name: "x", kind: "monto_maximo", params: { maximo: 1 } };
  assert.equal((await call(ventas, "policy_set", args)).outcome, "denegado");
  assert.equal((await call(observador, "agent_list")).outcome, "denegado");
});

await check("un admin crea un agente; el token sirve y no queda escrito en el libro", async () => {
  const created = await ok(supervisor, "agent_create", { name: "agente-soporte", role: "lector" });
  assert.match(created.token, /^nxa_/);
  agents["agente-soporte"] = created.id;
  soporteToken = created.token;
  const soporte = await connect(created.token);
  assert.equal((await call(soporte, "contact_search")).outcome, "ejecutado");
  const audit = await ok(supervisor, "audit_query", { tool: "agent_create" });
  assert.equal(audit.entries[0].detail.result.token, "[secreto]");
  const everything = await db.query<{ t: string }>("select (args::text || detail::text) as t from audit_log");
  assert.ok(everything.rows.every((r) => !r.t.includes(created.token)));
});

await check("permiso fino: permitir una herramienta por encima del rol", async () => {
  assert.equal((await call(observador, "contact_create", { name: "Luis" })).outcome, "denegado");
  await ok(supervisor, "agent_grant_set", { agent_id: agents["observador"], tool: "contact_create", effect: "permitir" });
  assert.equal((await call(observador, "contact_create", { name: "Luis" })).outcome, "ejecutado");
  assert.equal((await call(observador, "deal_create", { title: "x", pipeline_id: nexarm.pipelineId })).outcome, "denegado");
  await ok(supervisor, "agent_grant_set", { agent_id: agents["observador"], tool: "contact_create", effect: "heredar" });
  assert.equal((await call(observador, "contact_create", { name: "Luis" })).outcome, "denegado");
});

await check("permiso fino: denegar una herramienta que el rol si permite", async () => {
  await ok(supervisor, "agent_grant_set", { agent_id: agents["agente-ventas"], tool: "deal_move_stage", effect: "denegar" });
  const deal = await ok(ventas, "deal_create", { title: "Trato base", pipeline_id: nexarm.pipelineId });
  const stages = (await ok(ventas, "pipeline_list")).pipelines[0].stages;
  const res = await call(ventas, "deal_move_stage", { id: deal.id, stage_id: stages[1].id });
  assert.equal(res.outcome, "denegado");
  assert.match(res.reason!, /permiso fino/);
  await ok(supervisor, "agent_grant_set", { agent_id: agents["agente-ventas"], tool: "deal_move_stage", effect: "heredar" });
  assert.equal((await call(ventas, "deal_move_stage", { id: deal.id, stage_id: stages[1].id })).outcome, "ejecutado");
});

await check("un agente no cambia sus propios permisos ni se suspende a si mismo", async () => {
  const grant = await call(supervisor, "agent_grant_set", { agent_id: agents["supervisor"], tool: "deal_create", effect: "denegar" });
  assert.equal(grant.outcome, "error");
  assert.equal((await call(supervisor, "agent_suspend", { id: agents["supervisor"], suspended: true })).outcome, "error");
});

await check("politica de monto maximo: bloquea por encima del tope y deja pasar por debajo", async () => {
  await ok(supervisor, "policy_set", { name: "tope-trato", kind: "monto_maximo", params: { maximo: 5000 }, tool: "deal_create" });
  const over = await call(ventas, "deal_create", { title: "Grande", pipeline_id: nexarm.pipelineId, amount: 6000 });
  assert.equal(over.outcome, "denegado");
  assert.equal(over.policy, "tope-trato");
  assert.equal((await call(ventas, "deal_create", { title: "Normal", pipeline_id: nexarm.pipelineId, amount: 4000 })).outcome, "ejecutado");
  const deals = (await ok(ventas, "deal_list")).deals.map((d: any) => d.title);
  assert.ok(deals.includes("Normal") && !deals.includes("Grande"));
  const denied = await ok(supervisor, "audit_query", { outcome: "denegado", tool: "deal_create" });
  assert.equal(denied.entries[0].detail.policy, "tope-trato");
});

await check("politica de frecuencia: corta al llegar al limite y libera al pasar la ventana", async () => {
  await ok(supervisor, "policy_set", {
    name: "ritmo-contactos", kind: "limite_frecuencia", params: { maximo: 3, ventana_minutos: 60 },
    agent_id: agents["agente-ventas"], tool: "contact_create",
  });
  for (const n of [1, 2, 3]) await ok(ventas, "contact_create", { name: `Contacto ${n}` });
  const fourth = await call(ventas, "contact_create", { name: "Contacto 4" });
  assert.equal(fourth.outcome, "denegado");
  assert.equal(fourth.policy, "ritmo-contactos");
  assert.equal((await call(ventas, "company_create", { name: "Otra herramienta" })).outcome, "ejecutado");
  clock = minutes(61);
  assert.equal((await call(ventas, "contact_create", { name: "Contacto 4" })).outcome, "ejecutado");
  clock = MIERCOLES;
  await ok(supervisor, "policy_set", {
    name: "ritmo-contactos", kind: "limite_frecuencia", params: { maximo: 3, ventana_minutos: 60 }, enabled: false,
  });
});

await check("politica de horario: fuera de la franja no se escribe, pero si se lee", async () => {
  await ok(supervisor, "policy_set", {
    name: "horario-laboral", kind: "horario",
    params: { zona: "America/Bogota", dias: [1, 2, 3, 4, 5], desde: "08:00", hasta: "18:00" },
  });
  assert.equal((await call(ventas, "company_create", { name: "En horario" })).outcome, "ejecutado");
  clock = DOMINGO;
  const sunday = await call(ventas, "company_create", { name: "Domingo" });
  assert.equal(sunday.outcome, "denegado");
  assert.equal(sunday.policy, "horario-laboral");
  assert.equal((await call(ventas, "contact_search")).outcome, "ejecutado");
  clock = new Date("2026-11-12T02:00:00Z"); // miercoles 21:00 en Bogota
  assert.equal((await call(ventas, "company_create", { name: "De noche" })).outcome, "denegado");
  assert.equal((await call(supervisor, "policy_list")).outcome, "ejecutado");
  await ok(supervisor, "policy_set", {
    name: "horario-laboral", kind: "horario",
    params: { zona: "America/Bogota", dias: [1, 2, 3, 4, 5], desde: "08:00", hasta: "18:00" }, enabled: false,
  });
  clock = MIERCOLES;
});

await check("campos restringidos: el agente no los ve ni los escribe, y el libro tampoco los guarda", async () => {
  await ok(ventas, "contact_create", { name: "Marta Datos", email: "marta@example.com", phone: "3001234567" });
  await ok(supervisor, "policy_set", {
    name: "sin-telefono", kind: "campos_restringidos", params: { campos: ["phone"] }, agent_id: agents["observador"],
  });
  const seen = (await ok(observador, "contact_search", { query: "Marta" })).contacts[0];
  assert.equal(seen.phone, "[restringido]");
  assert.equal(seen.email, "marta@example.com");
  assert.equal((await ok(ventas, "contact_search", { query: "Marta" })).contacts[0].phone, "3001234567");
  const audit = await ok(supervisor, "audit_query", { agent_name: "observador", tool: "contact_search" });
  assert.equal(audit.entries[0].detail.result.contacts[0].phone, "[restringido]");
  assert.deepEqual(audit.entries[0].detail.campos_restringidos, ["phone"]);

  await ok(supervisor, "agent_grant_set", { agent_id: agents["observador"], tool: "contact_create", effect: "permitir" });
  const write = await call(observador, "contact_create", { name: "Con telefono", phone: "3000000000" });
  assert.equal(write.outcome, "denegado");
  assert.equal(write.policy, "sin-telefono");
});

await check("una politica mal definida se rechaza", async () => {
  const badZone = await call(supervisor, "policy_set", {
    name: "mala", kind: "horario", params: { zona: "Marte/Olimpo", dias: [1], desde: "08:00", hasta: "18:00" },
  });
  assert.equal(badZone.outcome, "error");
  assert.equal((await call(supervisor, "policy_set", { name: "mala", kind: "monto_maximo", params: { maximo: -5 } })).outcome, "error");
  assert.equal((await call(supervisor, "policy_set", { name: "mala", kind: "monto_maximo", params: { maximo: 5 }, tool: "no_existe" })).outcome, "error");
  assert.ok(!(await ok(supervisor, "policy_list")).policies.some((p: any) => p.name === "mala"));
});

await check("suspender un agente lo detiene de inmediato, y reactivarlo lo devuelve", async () => {
  await ok(supervisor, "agent_suspend", { id: agents["agente-ventas"], suspended: true });
  const res = await call(ventas, "contact_search");
  assert.equal(res.outcome, "denegado");
  assert.match(res.reason!, /suspendido/);
  await ok(supervisor, "agent_suspend", { id: agents["agente-ventas"], suspended: false });
  assert.equal((await call(ventas, "contact_search")).outcome, "ejecutado");
});

await check("una credencial vencida deja de servir", async () => {
  const temp = await ok(supervisor, "agent_create", { name: "agente-temporal", role: "lector", expires_in_days: 1 });
  const client = await connect(temp.token);
  assert.equal((await call(client, "contact_search")).outcome, "ejecutado");
  clock = minutes(60 * 25);
  const res = await call(client, "contact_search");
  assert.equal(res.outcome, "denegado");
  assert.match(res.reason!, /vencida/);
  clock = MIERCOLES;
});

await check("rotar el token invalida el anterior", async () => {
  const rotated = await ok(supervisor, "agent_rotate_token", { id: agents["agente-soporte"] });
  const audit = await ok(supervisor, "audit_query", { tool: "agent_rotate_token" });
  assert.equal(audit.entries[0].detail.result.token, "[secreto]");
  assert.equal((await call(await connect(rotated.token), "contact_search")).outcome, "ejecutado");
  const stale = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${soporteToken}` }, body: "{}",
  });
  assert.equal(stale.status, 401);
});

await check("aislamiento: las politicas y agentes de un cliente no alcanzan a otro", async () => {
  const ajeno = await connect(otro.tokens["agente-ventas"]!);
  const adminAjeno = await connect(otro.tokens["supervisor"]!);
  assert.equal((await call(ajeno, "deal_create", { title: "Sin tope", pipeline_id: otro.pipelineId, amount: 90000 })).outcome, "ejecutado");
  assert.equal((await ok(adminAjeno, "policy_list")).policies.length, 0);
  assert.equal((await ok(adminAjeno, "agent_list")).agents.length, 3);
  assert.equal((await call(adminAjeno, "agent_suspend", { id: agents["agente-ventas"], suspended: true })).outcome, "error");
  assert.equal((await call(adminAjeno, "policy_set", {
    name: "ajena", kind: "monto_maximo", params: { maximo: 1 }, agent_id: agents["agente-ventas"],
  })).outcome, "error");
  assert.equal((await call(ventas, "contact_search")).outcome, "ejecutado");
});

await check("la cadena de hashes sigue integra en los dos clientes", async () => {
  const chain = await verifyChain(db, nexarm.tenantId);
  assert.ok(chain.ok && chain.entries > 40, JSON.stringify(chain));
  assert.ok((await verifyChain(db, otro.tenantId)).ok);
});

console.log(`\n${passed} comprobaciones pasaron`);
http.close();
await db.close();
process.exit(0);
