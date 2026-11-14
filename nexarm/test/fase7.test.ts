import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { verifyChain } from "../src/audit.ts";
import { setTransports, transportsFromEnv } from "../src/channels.ts";
import { openDb, withTenant } from "../src/db.ts";
import { seed } from "../src/seed.ts";
import { createApp } from "../src/server.ts";
import { startXencrm, XENCRM_AGENT, xencrmConfig } from "../src/xencrm.ts";

// XENCRM de mentira: la parte de su API de tablero que usa Nexarm, con los mismos caminos y formas de respuesta.
const XEN_TOKEN = "xen_token";
const xen = {
  down: false,
  windowClosed: false,
  contacts: [
    { id: "wa:573001112233@s.whatsapp.net", channel: "whatsapp", name: "Laura Gómez", phone: null as string | null, stage: "nuevo", data: {} },
    { id: "web:abc123", channel: "web", name: "Visitante", phone: null as string | null, stage: "nuevo", data: {} },
    { id: "web:def456", channel: "web", name: "Carlos Peña", phone: null as string | null, stage: "calificado", data: { correo: "carlos@acme.test" } },
  ],
  replies: [] as { id: string; text: string; by: string }[],
  streams: new Set<express.Response>(),
  opened: 0,
};
const fake = express();
fake.use(express.json());
fake.use((req, res, next) => {
  if (xen.down) { res.status(500).json({ error: "caido" }); return; }
  if (req.headers["x-admin-token"] !== XEN_TOKEN) { res.status(401).json({ error: "no autorizado" }); return; }
  next();
});
fake.get("/admin/api/contacts", (req, res) => {
  const q = String(req.query.q ?? "");
  res.json(xen.contacts.filter((c) => [c.id, c.name, c.phone].some((v) => v?.includes(q))));
});
fake.post("/admin/api/contacts/:id/reply", (req, res) => {
  if (!xen.contacts.some((c) => c.id === req.params.id)) { res.status(404).json({ error: "no existe" }); return; }
  if (xen.windowClosed) { res.status(409).json({ error: "la ventana de 24 horas de WhatsApp esta cerrada" }); return; }
  xen.replies.push({ id: req.params.id, text: req.body.text, by: req.body.by });
  res.json({ ok: true });
});
fake.get("/admin/api/stream", (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(`event: hello\ndata: {"ts":1}\n\n`);
  xen.streams.add(res);
  xen.opened++;
  req.on("close", () => xen.streams.delete(res));
});
const xenHttp = fake.listen(0, "127.0.0.1");
await new Promise((r) => xenHttp.once("listening", r));
const xenEnv = { XENCRM_URL: `http://127.0.0.1:${(xenHttp.address() as AddressInfo).port}/`, XENCRM_ADMIN_TOKEN: XEN_TOKEN, XENCRM_REINTENTO_MS: "50" };
setTransports(transportsFromEnv(xenEnv));

/** Lo que XENCRM emite por su flujo en vivo. */
let nextMessage = 100;
function emit(userId: string, content: string, more: Record<string, unknown> = {}) {
  const id = (more.id as number | undefined) ?? nextMessage++;
  const ev = { type: "message", userId, ts: Date.now(), payload: { id, role: "user", author: "customer", content, ...more } };
  for (const res of xen.streams) res.write(`event: message\ndata: ${JSON.stringify(ev)}\n\n`);
  return id;
}

const db = await openDb();
const nexarm = await seed(db, "Nexarm", undefined, { ventas: true });
const http = createApp(db).listen(0, "127.0.0.1");
await new Promise((r) => http.once("listening", r));
const base = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}`);

async function until(what: string, ok: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 200; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`no ocurrio a tiempo: ${what}`);
}
const bridge = startXencrm(db, () => new Date(), xencrmConfig(xenEnv))!;
await until("la entrada se conecta a XENCRM", () => bridge.connected() && xen.streams.size === 1);

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
const received = () => count("select 1 from audit_log where tool = 'message_receive'");

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const seguimiento = await connect(nexarm.tokens["seguimiento"]!);
async function sendApproved(args: Record<string, unknown>, status = 200) {
  const res = await call(seguimiento, "message_send", args);
  assert.equal(res.outcome, "pendiente", `${res.reason}`);
  assert.equal((await form(`/aprobaciones/${res.approvalId}`, eathan, { decision: "aprobar" })).status, status);
}
const lastSend = async () => (await rows<{ outcome: string; detail: any }>(
  "select outcome, detail from audit_log where tool = 'message_send' and outcome <> 'pendiente' order by seq desc limit 1"))[0]!;

let laura = "";
await check("lo que un cliente escribe por el WhatsApp de XENCRM entra a Nexarm: crea el contacto y queda en el libro", async () => {
  emit("wa:573001112233@s.whatsapp.net", "Hola, quiero una demo.");
  await until("entra el mensaje", async () => (await received()) === 1);
  const contact = (await rows<{ id: string; name: string; phone: string }>("select id, name, phone from contacts"))[0]!;
  assert.deepEqual([contact.name, contact.phone], ["Laura Gómez", "+573001112233"]);
  laura = contact.id;
  const act = await rows<{ body: string }>("select body from activities where contact_id = $1", [laura]);
  assert.match(act[0]!.body, /^RECIBIDO por whatsapp de \+573001112233\nOrigen: XENCRM, canal whatsapp, etapa nuevo\n\nHola, quiero una demo\.$/);
  const entry = (await rows<{ agent_name: string; outcome: string }>("select agent_name, outcome from audit_log where tool = 'message_receive'"))[0]!;
  assert.deepEqual([entry.agent_name, entry.outcome], [XENCRM_AGENT, "ejecutado"]);
});

await check("una entrega repetida no duplica; lo que responde el asistente o el equipo no entra", async () => {
  emit("wa:573001112233@s.whatsapp.net", "Hola, quiero una demo.", { id: 100 });
  emit("wa:573001112233@s.whatsapp.net", "Claro, te cuento.", { role: "assistant", author: "bot" });
  emit("wa:573001112233@s.whatsapp.net", "Te escribe Ana.", { role: "assistant", author: "human" });
  emit("wa:573001112233@s.whatsapp.net", "¿El jueves?");
  await until("entra el segundo mensaje", async () => (await count("select 1 from activities where contact_id = $1", [laura])) === 2);
  assert.equal(await count("select 1 from contacts"), 1);
});

await check("del chat web entra quien dejo su correo; un visitante sin datos se queda en XENCRM", async () => {
  emit("web:abc123", "hola");
  emit("web:def456", "Necesito soporte.");
  await until("entra el mensaje del chat", async () => (await count("select 1 from contacts where email = 'carlos@acme.test'")) === 1);
  const act = await rows<{ body: string }>("select a.body from activities a join contacts c on c.id = a.contact_id where c.email = 'carlos@acme.test'");
  assert.match(act[0]!.body, /^RECIBIDO por chat de carlos@acme\.test\nOrigen: XENCRM, canal web, etapa calificado/);
  assert.equal(await count("select 1 from contacts"), 2);
});

await check("un mensaje aprobado sale por la conversacion del contacto en XENCRM, firmado Nexarm", async () => {
  await sendApproved({ channel: "whatsapp", contact_id: laura, body: "Hola Laura, ¿te sirve el jueves a las 10?" });
  assert.deepEqual(xen.replies, [{ id: "wa:573001112233@s.whatsapp.net", text: "Hola Laura, ¿te sirve el jueves a las 10?", by: "Nexarm" }]);
  const sent = await lastSend();
  assert.equal(sent.outcome, "ejecutado");
  assert.match(sent.detail.result.provider_id, /^xencrm:wa:573001112233@s\.whatsapp\.net:\d+$/);
});

await check("si XENCRM no puede entregar, no queda rastro de un envio que no ocurrio", async () => {
  const before = await count("select 1 from activities where contact_id = $1", [laura]);
  xen.windowClosed = true;
  await sendApproved({ channel: "whatsapp", contact_id: laura, body: "x" }, 409);
  xen.windowClosed = false;
  assert.match((await lastSend()).detail.reason, /respondio 409/);

  const prospeccion = await connect(nexarm.tokens["prospeccion"]!);
  const nuevo = (await call(prospeccion, "contact_create", { name: "Sin Conversación", phone: "+57 301 999 0000" })).data.id as string;
  await sendApproved({ channel: "whatsapp", contact_id: nuevo, body: "x" }, 409);
  assert.match((await lastSend()).detail.reason, /debe escribir primero/);
  assert.equal(await count("select 1 from activities where contact_id = $1", [laura]), before);
  assert.equal(xen.replies.length, 1);
});

await check("si la conexion con XENCRM se cae, la entrada vuelve sola y sigue recibiendo", async () => {
  for (const res of xen.streams) res.destroy();
  await until("la entrada se reconecta", () => xen.opened === 2 && xen.streams.size === 1 && bridge.connected());
  const before = await received();
  emit("wa:573001112233@s.whatsapp.net", "Sigo aquí.");
  await until("entra el mensaje tras reconectar", async () => (await received()) === before + 1);
});

await check("la entrada obedece a la gobernanza: se frena con el boton de detener y su agente no hace nada mas", async () => {
  const before = await count("select 1 from activities");
  await form("/pausa", eathan, { detener: "si" });
  emit("wa:573001112233@s.whatsapp.net", "¿Hay alguien?");
  await until("el libro registra la entrada frenada", async () =>
    (await count("select 1 from audit_log where tool = 'message_receive' and outcome = 'denegado'")) === 1);
  assert.equal(await count("select 1 from activities"), before);
  await form("/pausa", eathan, { detener: "no" });

  const entrada = await connect(nexarm.tokens[XENCRM_AGENT]!);
  assert.match((await call(entrada, "contact_create", { name: "X" })).reason!, /permiso fino/);
  assert.match((await call(seguimiento, "message_receive", { channel: "chat", external_id: "x", body: "y", email: "x@acme.test" })).reason!, /permiso fino/);
  const chain = await verifyChain(db, nexarm.tenantId);
  assert.ok(chain.ok, `cadena rota en ${chain.brokenAtSeq}`);
});

console.log(`\n${passed} comprobaciones pasaron`);
bridge.stop();
for (const server of [http, xenHttp]) { server.close(); server.closeAllConnections(); }
await db.close();
