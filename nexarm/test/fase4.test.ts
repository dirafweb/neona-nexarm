import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb, withTenant } from "../src/db.ts";
import { seed } from "../src/seed.ts";
import { createApp } from "../src/server.ts";
import { verifyChain } from "../src/audit.ts";
import { SALES_AGENTS } from "../src/sales/agents.ts";
import OpenAI from "openai";
import { pickProvider, runAgent } from "../src/sales/run.ts";

const db = await openDb();
const nexarm = await seed(db, "Nexarm", undefined, { ventas: true });
const http = createApp(db).listen(0, "127.0.0.1");
await new Promise((r) => http.once("listening", r));
const mcpUrl = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);

// Modelo de mentira: responde un guion y guarda lo que recibe. Asi la prueba ejerce el SDK real sin gastar ni depender de la red.
let script: { content: unknown[]; stop_reason: string }[] = [];
let openaiScript: any[] = [];
const requests: any[] = [];
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    requests.push(JSON.parse(body));
    res.setHeader("content-type", "application/json");
    if (req.url!.includes("chat/completions")) {
      const message = openaiScript.shift() ?? { role: "assistant", content: "sin guion" };
      res.end(JSON.stringify({
        id: `chatcmpl_${requests.length}`, object: "chat.completion", created: 0, model: "modelo-de-prueba",
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
      }));
      return;
    }
    const next = script.shift() ?? { content: [{ type: "text", text: "sin guion" }], stop_reason: "end_turn" };
    res.end(JSON.stringify({
      id: `msg_${requests.length}`, type: "message", role: "assistant", model: "claude-opus-5-5", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 }, ...next,
    }));
  });
}).listen(0, "127.0.0.1");
await new Promise((r) => fake.once("listening", r));
const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
const anthropic = new Anthropic({ apiKey: "prueba", baseURL: fakeUrl, maxRetries: 0 });
const openai = new OpenAI({ apiKey: "prueba", baseURL: fakeUrl, maxRetries: 0 });

let n = 0;
const use = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: `toolu_${++n}`, name, input });
const say = (text: string) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });
const agentNamed = (name: string) => SALES_AGENTS.find((a) => a.name === name)!;
const run = (name: string, task: string) =>
  runAgent({ agent: agentNamed(name), token: nexarm.tokens[name]!, task, mcpUrl, anthropic, provider: "anthropic" });
const rows = <T>(sql: string, params: unknown[] = []) =>
  withTenant(db, nexarm.tenantId, async (tx) => (await tx.query<T>(sql, params)).rows);

async function connect(token: string) {
  const client = new Client({ name: "prueba", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse((res.content as { text: string }[])[0]!.text) as { outcome: string; data?: any; reason?: string };
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

await check("prospeccion registra un prospecto por la pasarela y el trato grande queda para una persona", async () => {
  script = [
    { content: [use("contact_search", { query: "laura@acme.test" })], stop_reason: "tool_use" },
    { content: [use("company_create", { name: "Acme" }), use("contact_create", { name: "Laura Gómez", email: "laura@acme.test" })], stop_reason: "tool_use" },
    { content: [use("deal_create", { title: "Acme · Nexarm", pipeline_id: nexarm.pipelineId, amount: 25000 })], stop_reason: "tool_use" },
    say("Contacto y empresa creados. El trato de 25.000 espera aprobación."),
  ];
  const out = await run("prospeccion", "Nuevo prospecto: Laura Gómez, de Acme, laura@acme.test. Presupuesto 25.000 USD.");
  assert.match(out.report, /espera aprobación/);
  assert.equal(out.stopReason, "end_turn");
  assert.equal((await rows("select 1 from contacts where email = 'laura@acme.test'")).length, 1);
  assert.equal((await rows("select 1 from deals")).length, 0);
  const pending = await rows<{ tool: string; policy: string }>("select tool, policy from approvals where status = 'pendiente'");
  assert.deepEqual(pending, [{ tool: "deal_create", policy: "tratos-grandes" }]);
  assert.match(JSON.stringify(requests.at(-1).messages.at(-1)), /pendiente/);
});

await check("el modelo recibe solo las herramientas de su trabajo, su encargo y el modelo acordado", async () => {
  const first = requests[0];
  assert.equal(first.model, "claude-opus-5-5");
  assert.deepEqual(first.tools.map((t: any) => t.name).sort(), [...agentNamed("prospeccion").tools].sort());
  assert.match(first.system, /Eres prospeccion/);
  assert.match(first.system, /nunca "certificado"/);
  assert.equal(first.fallbacks, "default");
});

await check("cada accion del agente queda en el libro con su nombre", async () => {
  const log = await rows<{ tool: string; outcome: string }>(
    "select tool, outcome from audit_log where agent_name = 'prospeccion' order by seq");
  assert.deepEqual(log.map((e) => `${e.tool}:${e.outcome}`),
    ["contact_search:ejecutado", "company_create:ejecutado", "contact_create:ejecutado", "deal_create:pendiente"]);
});

let dealId = "";
await check("minimo privilegio en la pasarela: cada agente de venta solo hace lo de su trabajo", async () => {
  const prospeccion = await connect(nexarm.tokens["prospeccion"]!);
  const calificacion = await connect(nexarm.tokens["calificacion"]!);
  const seguimiento = await connect(nexarm.tokens["seguimiento"]!);
  const deal = await call(prospeccion, "deal_create", { title: "Trato chico", pipeline_id: nexarm.pipelineId, amount: 4000 });
  assert.equal(deal.outcome, "ejecutado", `${deal.reason}`);
  dealId = deal.data.id;
  assert.match((await call(calificacion, "deal_create", { title: "x", pipeline_id: nexarm.pipelineId })).reason!, /permiso fino/);
  assert.match((await call(seguimiento, "contact_create", { name: "x" })).reason!, /permiso fino/);
  assert.match((await call(prospeccion, "deal_move_stage", { id: dealId, stage_id: dealId })).reason!, /permiso fino/);
  assert.equal((await call(seguimiento, "policy_list")).outcome, "denegado");
});

await check("seguimiento lee el historial y deja el borrador del siguiente mensaje", async () => {
  script = [
    { content: [use("deal_list", {})], stop_reason: "tool_use" },
    { content: [use("activity_log", { kind: "nota", body: "Pidió una demo para el jueves.", deal_id: dealId })], stop_reason: "tool_use" },
    { content: [use("activity_log", { kind: "mensaje", body: "BORRADOR: Hola, confirmo la demo del jueves.", deal_id: dealId })], stop_reason: "tool_use" },
    { content: [use("activity_list", { deal_id: dealId })], stop_reason: "tool_use" },
    say("Dejé un borrador en el trato."),
  ];
  const out = await run("seguimiento", "Revisa el trato chico.");
  assert.match(out.report, /borrador/);
  const history = JSON.stringify(requests.at(-1).messages.at(-1));
  assert.ok(history.indexOf("BORRADOR") < history.indexOf("Pidió una demo"), "el historial no llega del mas reciente al mas antiguo");
  assert.equal((await rows("select 1 from activities where deal_id = $1", [dealId])).length, 2);
});

await check("con un modelo de OpenAI el agente pasa por la misma pasarela, con las mismas reglas", async () => {
  const fn = (name: string, args: object) =>
    ({ id: `call_${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
  openaiScript = [
    { role: "assistant", content: null, tool_calls: [
      fn("activity_log", { kind: "nota", body: "Tiene presupuesto y fecha.", deal_id: dealId }),
      fn("deal_create", { title: "x", pipeline_id: nexarm.pipelineId }),
    ] },
    { role: "assistant", content: "Nota registrada. Crear tratos me fue denegado." },
  ];
  const out = await runAgent({
    agent: agentNamed("calificacion"), token: nexarm.tokens["calificacion"]!, task: "Califica el trato chico.", mcpUrl,
    provider: "openai", openai, openaiModel: "modelo-de-prueba",
  });
  assert.match(out.report, /denegado/);
  const sent = requests.at(-2);
  assert.equal(sent.model, "modelo-de-prueba");
  assert.deepEqual(sent.tools.map((t: any) => t.function.name).sort(), [...agentNamed("calificacion").tools].sort());
  assert.match(sent.messages[0].content, /Eres calificacion/);
  assert.match(JSON.stringify(requests.at(-1).messages.at(-1)), /permiso fino/);
  const log = await rows<{ tool: string; outcome: string }>(
    "select tool, outcome from audit_log where agent_name = 'calificacion' order by seq desc limit 2");
  assert.deepEqual(log.map((e) => `${e.tool}:${e.outcome}`), ["deal_create:denegado", "activity_log:ejecutado"]);
});

await check("el proveedor se elige por la clave disponible, o por NEXARM_PROVEEDOR", async () => {
  assert.equal(pickProvider({ OPENAI_API_KEY: "x" }), "openai");
  assert.equal(pickProvider({ OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "y" }), "anthropic");
  assert.equal(pickProvider({ ANTHROPIC_API_KEY: "y", NEXARM_PROVEEDOR: "openai" }), "openai");
  assert.equal(pickProvider({}), "anthropic");
});

await check("volver a sembrar no rota credenciales: los tokens y la clave siguen sirviendo", async () => {
  const again = await seed(db, "Nexarm", undefined, { ventas: true });
  assert.deepEqual(again.tokens, {});
  assert.equal(again.consola.clave, "");
  const prospeccion = await connect(nexarm.tokens["prospeccion"]!);
  assert.equal((await call(prospeccion, "contact_search")).outcome, "ejecutado");
  assert.equal((await rows("select 1 from policies")).length, 4);
});

await check("el libro sigue integro", async () => {
  const chain = await verifyChain(db, nexarm.tenantId);
  assert.ok(chain.ok, `cadena rota en ${chain.brokenAtSeq}`);
});

console.log(`\n${passed} comprobaciones pasaron`);
http.close();
http.closeAllConnections();
fake.close();
fake.closeAllConnections();
await db.close();
