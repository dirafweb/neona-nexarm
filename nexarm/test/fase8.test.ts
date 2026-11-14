import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { verifyChain } from "../src/audit.ts";
import { openDb, withTenant } from "../src/db.ts";
import { seed } from "../src/seed.ts";
import { createApp } from "../src/server.ts";
import { XENCRM_AGENTIC } from "../src/xencrm.ts";

// XENCRM de mentira: la ruta del tablero que Nexarm ejecuta al aprobar una accion propuesta.
const XEN_TOKEN = "xen_token";
const patches: { id: string; body: unknown }[] = [];
const fake = express();
fake.use(express.json());
fake.patch("/admin/api/contacts/:id", (req, res) => {
  if (req.headers["x-admin-token"] !== XEN_TOKEN) { res.status(401).json({ error: "no autorizado" }); return; }
  patches.push({ id: req.params.id, body: req.body });
  res.json({ ok: true });
});
const xenHttp = fake.listen(0, "127.0.0.1");
await new Promise((r) => xenHttp.once("listening", r));
process.env.XENCRM_URL = `http://127.0.0.1:${(xenHttp.address() as AddressInfo).port}`;
process.env.XENCRM_ADMIN_TOKEN = XEN_TOKEN;

const db = await openDb();
const nexarm = await seed(db, "Nexarm", undefined, { ventas: true });
const http = createApp(db).listen(0, "127.0.0.1");
await new Promise((r) => http.once("listening", r));
const base = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}`);

type Res = { outcome: string; data?: any; reason?: string; approvalId?: string; auditSeq: number };
/** Lo que XENCRM pregunta antes de ejecutar una herramienta de su modo agentico. */
async function ask(body: Record<string, unknown>, token = nexarm.tokens[XENCRM_AGENTIC]!) {
  const res = await fetch(new URL("/gobierno/xencrm", base), {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, ...(await res.json() as Res) };
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
const entry = async (seq: number) => (await rows<{ agent_name: string; tool: string; outcome: string; args: any; detail: any }>(
  "select agent_name, tool, outcome, args, detail from audit_log where seq = $1", [seq]))[0]!;

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const ANA = "wa:573001110001@s.whatsapp.net";
const read = { side: "cliente", tool: "mis_tickets", effect: "lectura", args: {}, by: "Xen (agente)", contact: ANA };
const safe = { side: "cliente", tool: "abrir_ticket", effect: "seguro", args: { asunto: "No prende" }, by: "Xen (agente)", contact: ANA };
const proposed = {
  side: "equipo", tool: "mover_etapa", effect: "propuesto", args: { contactoId: ANA, etapa: "demo" }, by: "Laura (con Xen)",
  route: { method: "PATCH", path: `contacts/${encodeURIComponent(ANA)}`, body: { stage: "demo" } },
};

await check("una consulta del asistente de XENCRM pasa por la pasarela y queda en el libro con quien, que y para quien", async () => {
  const res = await ask(read);
  assert.equal(res.outcome, "ejecutado", `${res.reason}`);
  const e = await entry(res.auditSeq);
  assert.deepEqual([e.agent_name, e.tool, e.outcome], [XENCRM_AGENTIC, "xencrm_read", "ejecutado"]);
  assert.deepEqual([e.args.side, e.args.tool, e.args.contact, e.args.by], ["cliente", "mis_tickets", ANA, "Xen (agente)"]);
});

await check("una accion segura y una propuesta se autorizan como escritura; sin credencial no hay respuesta", async () => {
  const done = await ask(safe);
  assert.equal(done.outcome, "ejecutado", `${done.reason}`);
  assert.deepEqual([(await entry(done.auditSeq)).tool, done.data.runs_in], ["xencrm_act", "xencrm"]);
  assert.equal((await ask(proposed)).outcome, "ejecutado");
  assert.equal(patches.length, 0);
  assert.equal((await ask(read, "token-inventado")).status, 401);
  assert.equal((await ask({ ...proposed, route: { method: "PATCH", path: "../../etc" } })).outcome, "error");
});

await check("el boton de detener frena tambien al modo agentico de XENCRM: ni consulta ni actua", async () => {
  await form("/pausa", eathan, { detener: "si" });
  for (const call of [read, safe]) {
    const res = await ask(call);
    assert.equal(res.outcome, "denegado");
    assert.match(res.reason!, /operacion detenida por una persona/);
  }
  await form("/pausa", eathan, { detener: "no" });
  assert.equal((await ask(read)).outcome, "ejecutado");
});

await check("con una politica de aprobacion, la accion propuesta espera a una persona y al aprobarla Nexarm la ejecuta en XENCRM", async () => {
  await db.query("insert into policies (tenant_id, name, kind, params, tool) values ($1,'xencrm-con-aprobacion','requiere_aprobacion',$2,'xencrm_act')",
    [nexarm.tenantId, JSON.stringify({ campo: "amount", vence_horas: 24 })]);
  const res = await ask(proposed);
  assert.equal(res.outcome, "pendiente", `${res.reason}`);
  assert.equal(patches.length, 0);
  assert.equal((await ask(read)).outcome, "ejecutado");
  assert.equal((await form(`/aprobaciones/${res.approvalId}`, eathan, { decision: "aprobar" })).status, 200);
  assert.deepEqual(patches, [{ id: ANA, body: { stage: "demo" } }]);
  const done = (await rows<{ outcome: string; detail: any }>(
    "select outcome, detail from audit_log where tool = 'xencrm_act' order by seq desc limit 1"))[0]!;
  assert.deepEqual([done.outcome, done.detail.aprobada_por, done.detail.result.runs_in], ["ejecutado", "Eathan Jimenez", "nexarm"]);
});

await check("una accion segura aprobada no tiene ruta que ejecutar: queda el error con su causa y nada cambia en XENCRM", async () => {
  const res = await ask(safe);
  assert.equal(res.outcome, "pendiente");
  assert.equal((await form(`/aprobaciones/${res.approvalId}`, eathan, { decision: "aprobar" })).status, 409);
  const failed = (await rows<{ outcome: string; detail: any }>(
    "select outcome, detail from audit_log where tool = 'xencrm_act' order by seq desc limit 1"))[0]!;
  assert.equal(failed.outcome, "error");
  assert.match(failed.detail.reason, /XENCRM no dio la ruta/);
  assert.equal(patches.length, 1);
  await db.query("delete from policies where name = 'xencrm-con-aprobacion'");
});

await check("minimo privilegio: el agente de XENCRM no toca el CRM de Nexarm y los demas agentes no usan su puerta", async () => {
  const mcp = async (token: string, name: string, args: Record<string, unknown>) => {
    const res = await fetch(new URL("/mcp", base), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const text = await res.text();
    return JSON.parse(JSON.parse(/\{.*\}/s.exec(text)![0]).result.content[0].text) as Res;
  };
  assert.match((await mcp(nexarm.tokens[XENCRM_AGENTIC]!, "contact_create", { name: "X" })).reason!, /permiso fino/);
  assert.match((await ask(safe, nexarm.tokens["seguimiento"]!)).reason!, /permiso fino/);
  const chain = await verifyChain(db, nexarm.tenantId);
  assert.ok(chain.ok, `cadena rota en ${chain.brokenAtSeq}`);
});

console.log(`\n${passed} comprobaciones pasaron`);
for (const server of [http, xenHttp]) { server.close(); server.closeAllConnections(); }
await db.close();
