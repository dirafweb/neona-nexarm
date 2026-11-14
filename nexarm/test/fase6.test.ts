import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { verifyChain } from "../src/audit.ts";
import { setTransports, transportsFromEnv } from "../src/channels.ts";
import { INTAKE_AGENT } from "../src/chatwoot.ts";
import { openDb, withTenant } from "../src/db.ts";
import { seed } from "../src/seed.ts";
import { createApp } from "../src/server.ts";

// Chatwoot de mentira: la parte de su API que usa Nexarm, con los mismos caminos y formas de respuesta.
const CW_TOKEN = "cw_token";
const cw = {
  down: false,
  contacts: [] as { id: number; name: string; email?: string; phone_number?: string }[],
  conversations: [] as { id: number; inbox_id: number; contact_id: number; status: string; additional_attributes: Record<string, unknown> }[],
  messages: [] as { id: number; conversation_id: number; content: string; message_type: string }[],
};
const fake = express();
fake.use(express.json());
fake.use((req, res, next) => {
  if (cw.down) { res.status(500).json({ error: "caido" }); return; }
  if (req.headers.api_access_token !== CW_TOKEN) { res.status(401).json({ error: "token invalido" }); return; }
  next();
});
const api = "/api/v1/accounts/1";
fake.get(`${api}/contacts/search`, (req, res) => {
  const q = String(req.query.q).toLowerCase();
  res.json({ payload: cw.contacts.filter((c) => [c.name, c.email, c.phone_number].some((v) => v?.toLowerCase().includes(q))) });
});
fake.post(`${api}/contacts`, (req, res) => {
  const contact = { id: cw.contacts.length + 1, name: req.body.name, email: req.body.email, phone_number: req.body.phone_number };
  cw.contacts.push(contact);
  res.json({ payload: { contact, contact_inbox: { source_id: `src_${contact.id}` } } });
});
fake.get(`${api}/contacts/:id/conversations`, (req, res) => {
  res.json({ payload: cw.conversations.filter((c) => c.contact_id === Number(req.params.id)) });
});
const addMessage = (conversationId: number, body: any) => {
  const message = { id: cw.messages.length + 1, conversation_id: conversationId, content: body.content, message_type: body.message_type ?? "outgoing" };
  cw.messages.push(message);
  return message;
};
fake.post(`${api}/conversations`, (req, res) => {
  const conv = {
    id: cw.conversations.length + 1, inbox_id: req.body.inbox_id, contact_id: req.body.contact_id, status: "open",
    additional_attributes: req.body.additional_attributes ?? {},
  };
  cw.conversations.push(conv);
  if (req.body.message) addMessage(conv.id, req.body.message);
  res.json(conv);
});
fake.post(`${api}/conversations/:id/messages`, (req, res) => { res.json(addMessage(Number(req.params.id), req.body)); });
const cwHttp = fake.listen(0, "127.0.0.1");
await new Promise((r) => cwHttp.once("listening", r));

setTransports(transportsFromEnv({
  CHATWOOT_URL: `http://127.0.0.1:${(cwHttp.address() as AddressInfo).port}/`, CHATWOOT_TOKEN: CW_TOKEN, CHATWOOT_ACCOUNT_ID: "1",
  CHATWOOT_INBOX_CORREO: "7", CHATWOOT_INBOX_WHATSAPP: "8",
}));
const SECRET = "secreto-del-webhook";
process.env.CHATWOOT_WEBHOOK_SECRET = SECRET;
process.env.CHATWOOT_ACCOUNT_ID = "1";

const db = await openDb();
const nexarm = await seed(db, "Nexarm", undefined, { ventas: true });
const http = createApp(db).listen(0, "127.0.0.1");
await new Promise((r) => http.once("listening", r));
const base = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}`);

async function connect(token: string) {
  const client = new Client({ name: "prueba", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
type Res = { outcome: string; data?: any; reason?: string; approvalId?: string; auditSeq: number };
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse((res.content as { text: string }[])[0]!.text) as Res;
}
async function done(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await call(client, name, args);
  assert.equal(res.outcome, "ejecutado", `${name}: ${res.reason}`);
  return res;
}
async function form(path: string, cookie: string, fields: Record<string, string>) {
  return fetch(new URL(path, base), {
    method: "POST", redirect: "manual", body: new URLSearchParams(fields).toString(),
    headers: { cookie, origin: base.origin, "content-type": "application/x-www-form-urlencoded" },
  });
}
const login = await fetch(new URL("/login", base), {
  method: "POST", redirect: "manual", body: new URLSearchParams(nexarm.consola).toString(),
  headers: { origin: base.origin, "content-type": "application/x-www-form-urlencoded" },
});
const eathan = login.headers.get("set-cookie")!.split(";")[0]!;

const rows = <T>(sql: string, params: unknown[] = []) =>
  withTenant(db, nexarm.tenantId, async (tx) => (await tx.query<T>(sql, params)).rows);
const count = async (sql: string, params: unknown[] = []) => (await rows(sql, params)).length;

/** Entrega firmada como la firma Chatwoot. */
async function hook(payload: unknown, opts: { secret?: string; ts?: number } = {}) {
  const body = JSON.stringify(payload);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const res = await fetch(new URL("/chatwoot/webhook", base), {
    method: "POST", body,
    headers: {
      "content-type": "application/json", "x-chatwoot-timestamp": ts,
      "x-chatwoot-signature": `sha256=${createHmac("sha256", opts.secret ?? SECRET).update(`${ts}.${body}`).digest("hex")}`,
    },
  });
  return { status: res.status, json: await res.json() as any };
}
const incoming = (id: number, sender: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
  event: "message_created", id, content: "Hola, quiero una demo de Nexarm.", message_type: "incoming", private: false,
  account: { id: 1, name: "Xentris" }, inbox: { id: 7, name: "Gerencia" },
  conversation: { id: 31, channel: "Channel::Email", additional_attributes: { mail_subject: "Demo" } },
  sender: { id: 5, name: "Laura Gómez", email: null, phone_number: null, ...sender }, ...more,
});

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const prospeccion = await connect(nexarm.tokens["prospeccion"]!);
const seguimiento = await connect(nexarm.tokens["seguimiento"]!);
const marta = (await done(prospeccion, "contact_create", { name: "Marta Ruiz", email: "marta@acme.test" })).data.id as string;
const pedro = (await done(prospeccion, "contact_create", { name: "Pedro Díaz", phone: "+57 300 111 2233" })).data.id as string;

async function sendApproved(args: Record<string, unknown>, status = 200) {
  const res = await call(seguimiento, "message_send", args);
  assert.equal(res.outcome, "pendiente", `${res.reason}`);
  assert.equal((await form(`/aprobaciones/${res.approvalId}`, eathan, { decision: "aprobar" })).status, status);
}
const lastSend = async () => (await rows<{ outcome: string; detail: any }>(
  "select outcome, detail from audit_log where tool = 'message_send' and outcome <> 'pendiente' order by seq desc limit 1"))[0]!;

await check("un correo aprobado sale por la bandeja de Chatwoot: crea el contacto y abre la conversacion con su asunto", async () => {
  await sendApproved({ channel: "correo", contact_id: marta, subject: "Tu demo de Nexarm", body: "Hola Marta, ¿te sirve el jueves?" });
  assert.deepEqual(cw.contacts.map((c) => [c.name, c.email]), [["Marta Ruiz", "marta@acme.test"]]);
  assert.deepEqual(cw.conversations.map((c) => [c.inbox_id, c.additional_attributes.mail_subject]), [[7, "Tu demo de Nexarm"]]);
  assert.deepEqual(cw.messages.map((m) => [m.content, m.message_type]), [["Hola Marta, ¿te sirve el jueves?", "outgoing"]]);
  const sent = await lastSend();
  assert.equal(sent.outcome, "ejecutado");
  assert.equal(sent.detail.result.provider_id, "chatwoot:conversacion:1");
  assert.equal(await count("select 1 from activities where contact_id = $1 and body like 'ENVIADO por correo%'", [marta]), 1);
});

await check("el siguiente mensaje al mismo contacto sigue en su conversacion abierta, sin duplicar el contacto", async () => {
  await sendApproved({ channel: "correo", contact_id: marta, subject: "Otro asunto", body: "Te confirmo la hora." });
  assert.equal(cw.contacts.length, 1);
  assert.equal(cw.conversations.length, 1);
  assert.deepEqual(cw.messages.map((m) => m.conversation_id), [1, 1]);
  assert.equal((await lastSend()).detail.result.provider_id, "chatwoot:conversacion:1:mensaje:2");
});

await check("WhatsApp sale por su bandeja con el telefono en formato internacional", async () => {
  await sendApproved({ channel: "whatsapp", contact_id: pedro, body: "Hola Pedro." });
  assert.equal(cw.contacts[1]!.phone_number, "+573001112233");
  assert.equal(cw.conversations[1]!.inbox_id, 8);
});

await check("si Chatwoot falla, no queda rastro de un envio que no ocurrio", async () => {
  const before = await count("select 1 from activities where contact_id = $1", [marta]);
  cw.down = true;
  await sendApproved({ channel: "correo", contact_id: marta, subject: "x", body: "y" }, 409);
  cw.down = false;
  const failed = await lastSend();
  assert.equal(failed.outcome, "error");
  assert.match(failed.detail.reason, /respondio 500/);
  assert.equal(await count("select 1 from activities where contact_id = $1", [marta]), before);
});

await check("un mensaje entrante de alguien nuevo crea el contacto y queda en su historial, a nombre del agente de entrada", async () => {
  const res = await hook(incoming(101, { email: "laura@acme.test" }));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.contact_created, true);
  const laura = await rows<{ id: string; name: string }>("select id, name from contacts where email = 'laura@acme.test'");
  assert.deepEqual(laura.map((c) => c.name), ["Laura Gómez"]);
  const act = await rows<{ kind: string; body: string }>("select kind, body from activities where contact_id = $1", [laura[0]!.id]);
  assert.equal(act[0]!.kind, "correo");
  assert.match(act[0]!.body, /^RECIBIDO por correo de laura@acme\.test\nOrigen: Chatwoot, bandeja Gerencia, conversacion 31\nAsunto: Demo\n\nHola, quiero una demo/);
  const entry = await rows<{ agent_name: string; outcome: string }>("select agent_name, outcome from audit_log where seq = $1", [res.json.auditSeq]);
  assert.deepEqual(entry, [{ agent_name: INTAKE_AGENT, outcome: "ejecutado" }]);
});

await check("la misma entrega dos veces deja un solo mensaje", async () => {
  const again = await hook(incoming(101, { email: "laura@acme.test" }));
  assert.equal(again.status, 200);
  assert.equal(again.json.data.duplicate, true);
  assert.equal(await count("select 1 from activities where external_id = 'chatwoot:1:101'"), 1);
  assert.equal(await count("select 1 from contacts where email = 'laura@acme.test'"), 1);
});

await check("la respuesta de un contacto conocido entra a su ficha, por correo o por telefono, y el agente de venta la lee", async () => {
  await hook(incoming(102, { email: "MARTA@acme.test" }, { content: "El jueves me sirve." }));
  await hook(incoming(103, { name: "Pedro", phone_number: "+573001112233" },
    { content: "Listo.", conversation: { id: 40, channel: "Channel::Whatsapp" }, inbox: { id: 8, name: "WhatsApp" } }));
  assert.equal(await count("select 1 from contacts"), 3);
  const history = (await done(seguimiento, "activity_list", { contact_id: marta })).data.activities as { body: string }[];
  assert.match(history[0]!.body, /^RECIBIDO por correo de MARTA@acme\.test[\s\S]*El jueves me sirve\.$/);
  const whatsapp = await rows<{ kind: string; body: string }>("select kind, body from activities where contact_id = $1 and external_id is not null", [pedro]);
  assert.equal(whatsapp[0]!.kind, "mensaje");
  assert.match(whatsapp[0]!.body, /^RECIBIDO por whatsapp de \+573001112233/);
});

await check("una entrega mal firmada o vieja no entra, y sin secreto la entrada no existe", async () => {
  const before = await count("select 1 from audit_log");
  assert.equal((await hook(incoming(104, { email: "x@acme.test" }), { secret: "otro" })).status, 401);
  assert.equal((await hook(incoming(104, { email: "x@acme.test" }), { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
  delete process.env.CHATWOOT_WEBHOOK_SECRET;
  assert.equal((await hook(incoming(104, { email: "x@acme.test" }))).status, 503);
  process.env.CHATWOOT_WEBHOOK_SECRET = SECRET;
  assert.equal(await count("select 1 from audit_log"), before);
  assert.equal(await count("select 1 from contacts where email = 'x@acme.test'"), 0);
});

await check("solo entra lo que escribe un contacto identificable de esta cuenta", async () => {
  const before = await count("select 1 from activities");
  const ignored = [
    incoming(105, { email: "x@acme.test" }, { message_type: "outgoing" }),
    incoming(106, { email: "x@acme.test" }, { private: true }),
    incoming(107, { email: "x@acme.test" }, { account: { id: 2 } }),
    incoming(108, {}),
    { ...incoming(109, { email: "x@acme.test" }), event: "conversation_created" },
  ];
  for (const payload of ignored) {
    const res = await hook(payload);
    assert.equal(res.status, 200);
    assert.ok(res.json.ignored, JSON.stringify(res.json));
  }
  assert.equal(await count("select 1 from activities"), before);
});

await check("la entrada obedece a la gobernanza: se frena con el boton de detener y su agente no hace nada mas", async () => {
  await form("/pausa", eathan, { detener: "si" });
  const paused = await hook(incoming(110, { email: "laura@acme.test" }));
  assert.equal(paused.status, 422);
  assert.match(paused.json.reason, /operacion detenida/);
  await form("/pausa", eathan, { detener: "no" });
  assert.equal((await hook(incoming(110, { email: "laura@acme.test" }))).status, 200);

  const entrada = await connect(nexarm.tokens[INTAKE_AGENT]!);
  assert.match((await call(entrada, "contact_create", { name: "X" })).reason!, /permiso fino/);
  const args = { channel: "correo", external_id: "x", body: "y", email: "x@acme.test" };
  assert.match((await call(seguimiento, "message_receive", args)).reason!, /permiso fino/);
  assert.match((await call(prospeccion, "message_receive", args)).reason!, /permiso fino/);
  const chain = await verifyChain(db, nexarm.tenantId);
  assert.ok(chain.ok, `cadena rota en ${chain.brokenAtSeq}`);
});

console.log(`\n${passed} comprobaciones pasaron`);
for (const server of [http, cwHttp]) { server.close(); server.closeAllConnections(); }
await db.close();
