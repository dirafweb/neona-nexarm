import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { verifyChain } from "../src/audit.ts";
import { setTransports, type Outbound } from "../src/channels.ts";
import { openDb, withTenant } from "../src/db.ts";
import { seed } from "../src/seed.ts";
import { createApp } from "../src/server.ts";

// Canales de mentira: guardan lo que saldria. whatsapp queda sin configurar a proposito.
const sent: Outbound[] = [];
let providerDown = false;
setTransports({
  correo: async (m) => {
    if (providerDown) throw new Error("el proveedor respondio 503");
    sent.push(m);
    return { id: `correo_${sent.length}` };
  },
});

const db = await openDb();
const nexarm = await seed(db, "Nexarm", undefined, { ventas: true });
const otro = await seed(db, "Cliente Demo", "Usuario Demo");
const http = createApp(db).listen(0, "127.0.0.1");
await new Promise((r) => http.once("listening", r));
const base = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}`);

async function connect(token: string) {
  const client = new Client({ name: "prueba", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
type Res = { outcome: string; data?: any; reason?: string; policy?: string; approvalId?: string; auditSeq: number };
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse((res.content as { text: string }[])[0]!.text) as Res;
}
async function done(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await call(client, name, args);
  assert.equal(res.outcome, "ejecutado", `${name}: ${res.reason}`);
  return res;
}
async function web(path: string, opts: { form?: Record<string, string>; cookie?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.form) { headers.origin = base.origin; headers["content-type"] = "application/x-www-form-urlencoded"; }
  const res = await fetch(new URL(path, base), {
    method: opts.form ? "POST" : "GET", headers, redirect: "manual",
    body: opts.form ? new URLSearchParams(opts.form).toString() : undefined,
  });
  return { status: res.status, location: res.headers.get("location") ?? "", headers: res.headers, text: await res.text() };
}
async function signIn(who: { usuario: string; clave: string }) {
  const res = await web("/login", { form: who });
  assert.equal(res.status, 302, res.text);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
const rows = <T>(sql: string, params: unknown[] = []) =>
  withTenant(db, nexarm.tenantId, async (tx) => (await tx.query<T>(sql, params)).rows);
const count = async (sql: string, params: unknown[] = []) => (await rows(sql, params)).length;

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const eathan = await signIn(nexarm.consola);
const prospeccion = await connect(nexarm.tokens["prospeccion"]!);
const calificacion = await connect(nexarm.tokens["calificacion"]!);
const seguimiento = await connect(nexarm.tokens["seguimiento"]!);
const revertWeb = (seq: number, cookie = eathan) => web(`/libro/${seq}/revertir`, { cookie, form: {} });
const stages: Record<string, string> = Object.fromEntries(
  (await done(prospeccion, "pipeline_list")).data.pipelines[0].stages.map((s: any) => [s.name, s.id]));

await check("una persona revierte una accion de un agente y queda en el libro; solo una vez", async () => {
  const created = await done(prospeccion, "contact_create", { name: "Contacto equivocado" });
  assert.match((await web("/", { cookie: eathan })).text, new RegExp(`/libro/${created.auditSeq}/revertir`));
  assert.equal((await revertWeb(created.auditSeq)).status, 200);
  assert.equal(await count("select 1 from contacts where id = $1", [created.data.id]), 0);
  const entry = (await rows<any>("select agent_name, actor, args from audit_log where tool = 'revert'"))[0];
  assert.deepEqual([entry.agent_name, entry.actor, entry.args.accion], ["Eathan Jimenez", "humano", created.auditSeq]);
  const again = await revertWeb(created.auditSeq);
  assert.equal(again.status, 409);
  assert.match(again.text, /ya fue revertida/);
});

await check("revertir no esta al alcance de un agente, ni de otro cliente, ni de quien no tiene sesion", async () => {
  const created = await done(prospeccion, "contact_create", { name: "Queda" });
  const names = (await prospeccion.listTools()).tools.map((t) => t.name);
  assert.ok(!names.some((n) => /revert|undo|pausa|pause/.test(n)), names.join(","));
  assert.equal((await revertWeb(created.auditSeq, "")).location, "/login");
  const ajeno = await revertWeb(created.auditSeq, await signIn(otro.consola));
  assert.equal(ajeno.status, 409);
  assert.equal(await count("select 1 from contacts where id = $1", [created.data.id]), 1);
});

await check("los cambios de un registro se revierten del mas reciente al mas antiguo, y vuelve el valor anterior", async () => {
  const created = await done(prospeccion, "contact_create", { name: "Laura", phone: "111", notes: "nota original" });
  const id = created.data.id;
  const first = await done(calificacion, "contact_update", { id, phone: "222" });
  const second = await done(calificacion, "contact_update", { id, phone: "333", notes: "nota nueva" });
  const early = await revertWeb(first.auditSeq);
  assert.equal(early.status, 409);
  assert.match(early.text, new RegExp(`revierte primero la acci(o|ó)n #${second.auditSeq}`));
  assert.equal((await revertWeb(created.auditSeq)).status, 409);
  assert.equal((await revertWeb(second.auditSeq)).status, 200);
  assert.deepEqual((await rows("select phone, notes from contacts where id = $1", [id]))[0], { phone: "222", notes: "nota original" });
  assert.equal((await revertWeb(first.auditSeq)).status, 200);
  assert.equal((await revertWeb(created.auditSeq)).status, 200);
  assert.equal(await count("select 1 from contacts where id = $1", [id]), 0);
});

let contactId = "";
let dealId = "";
await check("no se borra un registro del que dependen otros; mover de etapa se deshace", async () => {
  const contact = await done(prospeccion, "contact_create", { name: "Marta Ruiz", email: "marta@acme.test" });
  contactId = contact.data.id;
  const deal = await done(prospeccion, "deal_create", { title: "Acme", pipeline_id: nexarm.pipelineId, contact_id: contactId, amount: 5000 });
  dealId = deal.data.id;
  const blocked = await revertWeb(contact.auditSeq);
  assert.equal(blocked.status, 409);
  assert.match(blocked.text, /tiene 1 registros en deals/);
  const moved = await done(calificacion, "deal_move_stage", { id: dealId, stage_id: stages["Calificado"] });
  assert.equal((await revertWeb(moved.auditSeq)).status, 200);
  assert.deepEqual(await rows("select stage_id from deals where id = $1", [dealId]), [{ stage_id: stages["Prospecto"] }]);
});

await check("detener todo frena a cada agente al instante; reanudar los devuelve; queda en el libro", async () => {
  assert.equal((await web("/pausa", { cookie: eathan, form: { detener: "si" } })).status, 302);
  for (const agent of [prospeccion, calificacion, seguimiento]) {
    const res = await call(agent, "contact_search");
    assert.equal(res.outcome, "denegado");
    assert.match(res.reason!, /detenida por una persona/);
  }
  assert.match((await web("/", { cookie: eathan })).text, /Operación detenida/);
  await web("/pausa", { cookie: eathan, form: { detener: "no" } });
  await done(prospeccion, "contact_search");
  assert.equal(await count("select 1 from audit_log where tool = 'tenant_pause' and actor = 'humano'"), 2);
});

let pendingMessage = "";
await check("un mensaje no sale sin una persona: espera aprobacion y la consola muestra a quien va", async () => {
  const res = await call(seguimiento, "message_send", {
    channel: "correo", contact_id: contactId, deal_id: dealId, subject: "Tu demo de Nexarm", body: "Hola Marta, ¿te sirve el jueves?",
    to: "otro@destino.test",
  });
  assert.equal(res.outcome, "pendiente");
  assert.equal(res.policy, "mensajes-con-aprobacion");
  pendingMessage = res.approvalId!;
  assert.equal(sent.length, 0);
  assert.match((await web("/", { cookie: eathan })).text, /Para: <b>Marta Ruiz<\/b> · marta@acme\.test/);
});

await check("al aprobar, sale al destino de la ficha del contacto y queda en su historial", async () => {
  assert.equal((await web(`/aprobaciones/${pendingMessage}`, { cookie: eathan, form: { decision: "aprobar" } })).status, 200);
  assert.deepEqual(sent, [{ channel: "correo", to: "marta@acme.test", name: "Marta Ruiz", subject: "Tu demo de Nexarm", body: "Hola Marta, ¿te sirve el jueves?" }]);
  const history = (await done(seguimiento, "activity_list", { contact_id: contactId })).data.activities;
  assert.equal(history[0].kind, "correo");
  assert.match(history[0].body, /^ENVIADO por correo a marta@acme\.test/);
  const page = await web("/", { cookie: eathan });
  const seq = (await rows<{ seq: number }>("select seq from audit_log where tool = 'message_send' and outcome = 'ejecutado'"))[0]!.seq;
  assert.doesNotMatch(page.text, new RegExp(`/libro/${seq}/revertir`));
  assert.match((await revertWeb(seq)).text, /no se puede revertir/);
});

/** Pide un envio y lo aprueba. Devuelve la pagina de resultado. */
async function sendApproved(args: Record<string, unknown>) {
  const res = await call(seguimiento, "message_send", args);
  assert.equal(res.outcome, "pendiente", `${res.reason}`);
  return web(`/aprobaciones/${res.approvalId}`, { cookie: eathan, form: { decision: "aprobar" } });
}

await check("si el proveedor falla o el canal no existe, no queda rastro de un envio que no ocurrio", async () => {
  const before = await count("select 1 from activities where contact_id = $1", [contactId]);
  providerDown = true;
  const down = await sendApproved({ channel: "correo", contact_id: contactId, subject: "x", body: "y" });
  providerDown = false;
  assert.equal(down.status, 409);
  assert.match(down.text, /503/);
  const missing = await sendApproved({ channel: "whatsapp", contact_id: contactId, body: "y" });
  assert.match(missing.text, /el contacto no tiene telefono/);
  await done(calificacion, "contact_update", { id: contactId, phone: "+57 300 000 0000" });
  const unconfigured = await sendApproved({ channel: "whatsapp", contact_id: contactId, body: "y" });
  assert.match(unconfigured.text, /whatsapp no esta configurado/);
  assert.equal(await count("select 1 from activities where contact_id = $1", [contactId]), before);
  assert.equal(sent.length, 1);
  assert.equal(await count("select 1 from audit_log where tool = 'message_send' and outcome = 'error'"), 3);
});

await check("un contacto que pidio no ser contactado no recibe nada, aunque una persona apruebe", async () => {
  await done(calificacion, "contact_update", { id: contactId, do_not_contact: true });
  const refused = await sendApproved({ channel: "correo", contact_id: contactId, subject: "x", body: "y" });
  assert.equal(refused.status, 409);
  assert.match(refused.text, /pidio no ser contactado/);
  assert.equal(sent.length, 1);
});

await check("calificacion pone puntaje a un prospecto, la consola lo lista y una persona lo revierte", async () => {
  const lead = (await done(prospeccion, "contact_create", { name: "Sara Puntaje", email: "sara@acme.test" })).data.id;
  await assert.rejects(call(calificacion, "contact_qualify", { id: lead, score: 140, reason: "x" }));
  assert.match((await call(prospeccion, "contact_qualify", { id: lead, score: 50, reason: "x" })).reason!, /permiso fino/);
  await done(calificacion, "contact_qualify", { id: lead, score: 50, reason: "Tiene problema y presupuesto" });
  const second = await done(calificacion, "contact_qualify", { id: lead, score: 75, reason: "Ya dijo quien decide" });
  const home = (await web("/", { cookie: eathan })).text;
  assert.match(home, /Sara Puntaje<small>listo para venta<\/small>/);
  assert.match(home, /Ya dijo quien decide/);
  assert.equal((await revertWeb(second.auditSeq)).status, 200);
  assert.deepEqual((await rows("select score, score_reason from contacts where id = $1", [lead]))[0],
    { score: 50, score_reason: "Tiene problema y presupuesto" });
});

await check("solo seguimiento envia mensajes; el libro sigue integro", async () => {
  for (const agent of [prospeccion, calificacion]) {
    assert.match((await call(agent, "message_send", { channel: "correo", contact_id: contactId, subject: "x", body: "y" })).reason!, /permiso fino/);
  }
  for (const t of [nexarm.tenantId, otro.tenantId]) {
    const chain = await verifyChain(db, t);
    assert.ok(chain.ok, `cadena rota en ${chain.brokenAtSeq}`);
  }
});

console.log(`\n${passed} comprobaciones pasaron`);
http.close();
http.closeAllConnections();
await db.close();
