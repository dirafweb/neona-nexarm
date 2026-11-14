import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db.ts";
import { seed } from "../src/seed.ts";
import { createApp } from "../src/server.ts";
import { verifyChain } from "../src/audit.ts";

const db = await openDb();
const nexarm = await seed(db, "Nexarm");
const otro = await seed(db, "Cliente Demo", "Usuario Demo");
// Estas pruebas cubren el gobierno directo por agente; la aprobacion humana se prueba en la fase 3.
await db.query("update tenants set governance_approval = false");
const http = createApp(db).listen(0, "127.0.0.1");
await new Promise((r) => http.once("listening", r));
const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);

async function connect(token: string) {
  const client = new Client({ name: "prueba", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse((res.content as { text: string }[])[0]!.text) as { outcome: string; data?: any; reason?: string; auditSeq: number };
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
let contactId = "";

await check("sin token el servidor responde 401", async () => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
});

await check("el servidor MCP expone las herramientas del CRM", async () => {
  const names = (await ventas.listTools()).tools.map((t) => t.name);
  for (const n of ["contact_create", "deal_create", "deal_move_stage", "audit_query"]) assert.ok(names.includes(n), n);
});

await check("criterio de la fase 1: un agente crea contacto y trato, y ambos quedan en el libro", async () => {
  const contact = await call(ventas, "contact_create", { name: "Ana Prueba", email: "ana@example.com" });
  assert.equal(contact.outcome, "ejecutado");
  contactId = contact.data.id;
  const deal = await call(ventas, "deal_create", { title: "Nexarm para Ana", pipeline_id: nexarm.pipelineId, contact_id: contactId, amount: 1200 });
  assert.equal(deal.outcome, "ejecutado");

  const audit = await call(supervisor, "audit_query", { agent_name: "agente-ventas" });
  const byTool = new Map<string, any>(audit.data.entries.map((e: any) => [e.tool, e]));
  for (const tool of ["contact_create", "deal_create"]) {
    const e = byTool.get(tool);
    assert.ok(e, `falta ${tool} en el libro`);
    assert.equal(e.agent_name, "agente-ventas");
    assert.equal(e.outcome, "ejecutado");
    assert.ok(e.user_id && e.at && e.hash);
  }
  assert.equal(byTool.get("contact_create").args.email, "ana@example.com");
  assert.equal(byTool.get("deal_create").args.amount, 1200);
});

await check("el trato entra en la primera etapa y se puede mover", async () => {
  const pipelines = await call(observador, "pipeline_list");
  const stages = pipelines.data.pipelines[0].stages;
  const deals = await call(observador, "deal_list");
  assert.equal(deals.data.deals[0].stage, "Prospecto");
  const moved = await call(ventas, "deal_move_stage", { id: deals.data.deals[0].id, stage_id: stages[1].id });
  assert.equal(moved.data.stage, "Calificado");
});

await check("un agente lector no puede escribir, y el intento queda registrado", async () => {
  const res = await call(observador, "contact_create", { name: "No Debe Existir" });
  assert.equal(res.outcome, "denegado");
  const found = await call(observador, "contact_search", { query: "No Debe Existir" });
  assert.equal(found.data.contacts.length, 0);
  const audit = await call(supervisor, "audit_query", { outcome: "denegado" });
  assert.equal(audit.data.entries[0].agent_name, "observador");
});

await check("solo el rol admin lee el libro de auditoria", async () => {
  assert.equal((await call(ventas, "audit_query")).outcome, "denegado");
});

await check("una accion que falla no deja datos a medias, y el error queda registrado", async () => {
  const other = await call(await connect(otro.tokens["agente-ventas"]!), "pipeline_list");
  const foreignStage = other.data.pipelines[0].stages[0].id;
  const res = await call(ventas, "deal_create", { title: "Etapa ajena", pipeline_id: nexarm.pipelineId, stage_id: foreignStage });
  assert.equal(res.outcome, "error");
  const deals = await call(observador, "deal_list");
  assert.ok(!deals.data.deals.some((d: any) => d.title === "Etapa ajena"));
});

await check("aislamiento: el agente de otro cliente no ve ni toca los datos de Nexarm", async () => {
  const ajeno = await connect(otro.tokens["agente-ventas"]!);
  assert.equal((await call(ajeno, "contact_search", { query: "Ana" })).data.contacts.length, 0);
  assert.equal((await call(ajeno, "contact_update", { id: contactId, name: "Robado" })).outcome, "error");
  const adminAjeno = await connect(otro.tokens["supervisor"]!);
  const audit = await call(adminAjeno, "audit_query", {});
  assert.ok(audit.data.entries.every((e: any) => e.agent_name !== "observador" || e.tool !== "contact_create"));
  assert.equal((await call(ventas, "contact_search", { query: "Ana" })).data.contacts[0].name, "Ana Prueba");
});

await check("el libro no se puede editar ni borrar", async () => {
  await assert.rejects(db.query("update audit_log set outcome = 'ejecutado' where outcome = 'denegado'"), /solo agregar/);
  await assert.rejects(db.query("delete from audit_log"), /solo agregar/);
  await assert.rejects(db.query("truncate audit_log"), /solo agregar/);
});

await check("la cadena de hashes esta integra, y detecta una alteracion forzada", async () => {
  const before = await verifyChain(db, nexarm.tenantId);
  assert.ok(before.ok && before.entries >= 5, JSON.stringify(before));
  assert.ok((await verifyChain(db, otro.tenantId)).ok);
  await db.exec("alter table audit_log disable trigger audit_log_no_update");
  await db.query("update audit_log set args = '{\"name\":\"Alterado\"}' where tenant_id = $1 and tool = 'contact_create' and outcome = 'ejecutado'", [nexarm.tenantId]);
  await db.exec("alter table audit_log enable trigger audit_log_no_update");
  const after = await verifyChain(db, nexarm.tenantId);
  assert.equal(after.ok, false);
});

console.log(`\n${passed} comprobaciones pasaron`);
http.close();
await db.close();
process.exit(0);
