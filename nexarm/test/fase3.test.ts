import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb, withTenant } from "../src/db.ts";
import { seed } from "../src/seed.ts";
import { createApp } from "../src/server.ts";
import { verifyChain } from "../src/audit.ts";

const INICIO = new Date("2026-11-11T15:00:00Z");
let clock = INICIO;

const db = await openDb();
const nexarm = await seed(db, "Nexarm");
const otro = await seed(db, "Cliente Demo", "Usuario Demo");
const http = createServer().listen(0, "127.0.0.1");
await new Promise((r) => http.once("listening", r));
const base = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}`);
http.on("request", createApp(db, () => clock, base));
const mcpUrl = new URL("/mcp", base);

async function connect(token: string) {
  const client = new Client({ name: "prueba", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
type Res = { outcome: string; data?: any; reason?: string; policy?: string; approvalId?: string; auditSeq: number };
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse((res.content as { text: string }[])[0]!.text) as Res;
}
async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await call(client, name, args);
  assert.equal(res.outcome, "ejecutado", `${name}: ${res.reason}`);
  return res.data;
}

/** Peticion a la consola como lo haria un navegador: sin seguir redirecciones y con su origen. */
async function web(path: string, opts: { form?: Record<string, string>; cookie?: string; origin?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.form && opts.origin !== null) headers.origin = opts.origin ?? base.origin;
  if (opts.form) headers["content-type"] = "application/x-www-form-urlencoded";
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
const decideWeb = (cookie: string, id: string, decision: string, nota = "") =>
  web(`/aprobaciones/${id}`, { cookie, form: { decision, nota } });

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
const stages: Record<string, string> = Object.fromEntries(
  (await ok(ventas, "pipeline_list")).pipelines[0].stages.map((s: any) => [s.name, s.id]));
const deal = (title: string, amount: number) =>
  ({ title, amount, pipeline_id: nexarm.pipelineId, stage_id: stages["Prospecto"]! });
const dealTitles = async () => (await ok(ventas, "deal_list")).deals.map((d: any) => d.title);

let eathan = "";
/** Un agente administrador propone un cambio de gobierno y la persona lo aprueba en la consola. */
async function govern(tool: string, args: Record<string, unknown>) {
  const res = await call(supervisor, tool, args);
  assert.equal(res.outcome, "pendiente", `${tool}: ${res.reason}`);
  const page = await decideWeb(eathan, res.approvalId!, "aprobar");
  assert.equal(page.status, 200, page.text);
  return page;
}

await check("la consola exige sesion y rechaza una clave incorrecta", async () => {
  const anon = await web("/");
  assert.equal(anon.status, 302);
  assert.equal(anon.location, "/login");
  assert.equal((await web("/login", { form: { usuario: nexarm.consola.usuario, clave: "incorrecta" } })).status, 401);
  eathan = await signIn(nexarm.consola);
  const home = await web("/", { cookie: eathan });
  assert.equal(home.status, 200);
  assert.match(home.text, /Por aprobar \(0\)/);
});

let policyApproval = "";
await check("un agente admin ya no cambia el gobierno solo: su cambio queda pendiente", async () => {
  const res = await call(supervisor, "policy_set", {
    name: "tratos-grandes", kind: "requiere_aprobacion", tool: "deal_create", params: { desde: 10000 },
  });
  assert.equal(res.outcome, "pendiente");
  policyApproval = res.approvalId!;
  assert.equal((await ok(supervisor, "policy_list")).policies.length, 0);
  assert.match((await web("/", { cookie: eathan })).text, /Por aprobar \(1\)/);
});

await check("ningun agente decide aprobaciones: no hay herramienta, y sin sesion o desde otro origen no pasa", async () => {
  const names = (await supervisor.listTools()).tools.map((t) => t.name);
  assert.ok(!names.some((n) => /decide|approve|aprobar/.test(n)), names.join(","));
  assert.equal((await decideWeb("", policyApproval, "aprobar")).location, "/login");
  const forged = await web(`/aprobaciones/${policyApproval}`, { cookie: eathan, origin: "http://sitio-ajeno.test", form: { decision: "aprobar" } });
  assert.equal(forged.status, 403);
  const ajeno = await signIn(otro.consola);
  const cruzado = await decideWeb(ajeno, policyApproval, "aprobar");
  assert.equal(cruzado.status, 409);
  assert.match(cruzado.text, /no encontrada/);
  assert.equal((await ok(supervisor, "policy_list")).policies.length, 0);
});

await check("la persona aprueba en la consola y el cambio se aplica, con su nombre en el libro", async () => {
  assert.equal((await decideWeb(eathan, policyApproval, "aprobar", "de acuerdo")).status, 200);
  assert.equal((await ok(supervisor, "policy_list")).policies[0].name, "tratos-grandes");
  const log = (await ok(supervisor, "audit_query", { limit: 5 })).entries;
  const human = log.find((e: any) => e.tool === "approval_decide");
  assert.equal(human.agent_name, "Eathan Jimenez");
  const applied = log.find((e: any) => e.tool === "policy_set" && e.outcome === "ejecutado");
  assert.equal(applied.detail.aprobada_por, "Eathan Jimenez");
  assert.equal((await decideWeb(eathan, policyApproval, "aprobar")).status, 409);
});

let bigDeal = "";
await check("bajo el umbral se ejecuta; desde el umbral la llamada espera y nada cambia", async () => {
  await ok(ventas, "deal_create", deal("Trato chico", 9000));
  const res = await call(ventas, "deal_create", deal("Trato grande", 25000));
  assert.equal(res.outcome, "pendiente");
  assert.equal(res.policy, "tratos-grandes");
  bigDeal = res.approvalId!;
  assert.deepEqual(await dealTitles(), ["Trato chico"]);
});

await check("el agente consulta su aprobacion; otro agente no la ve", async () => {
  assert.equal((await ok(ventas, "approval_status", { id: bigDeal })).status, "pendiente");
  assert.equal((await call(observador, "approval_status", { id: bigDeal })).outcome, "error");
});

await check("al aprobar, la llamada se ejecuta como el agente que la pidio", async () => {
  assert.equal((await decideWeb(eathan, bigDeal, "aprobar")).status, 200);
  assert.ok((await dealTitles()).includes("Trato grande"));
  const status = await ok(ventas, "approval_status", { id: bigDeal });
  assert.equal(status.status, "aprobada");
  assert.equal(status.result.title, "Trato grande");
  const entry = (await ok(supervisor, "audit_query", { limit: 3 })).entries
    .find((e: any) => e.tool === "deal_create" && e.outcome === "ejecutado");
  assert.equal(entry.agent_name, "agente-ventas");
  assert.equal(entry.detail.aprobacion, bigDeal);
});

await check("al rechazar, nada se ejecuta y el agente recibe el motivo", async () => {
  const res = await call(ventas, "deal_create", deal("Trato dudoso", 40000));
  assert.equal((await decideWeb(eathan, res.approvalId!, "rechazar", "falta el contrato")).status, 200);
  assert.ok(!(await dealTitles()).includes("Trato dudoso"));
  const status = await ok(ventas, "approval_status", { id: res.approvalId });
  assert.equal(status.status, "rechazada");
  assert.equal(status.note, "falta el contrato");
});

await check("un bloqueo gana a una aprobacion: lo prohibido no llega a la persona", async () => {
  await govern("policy_set", { name: "tope", kind: "monto_maximo", tool: "deal_create", params: { maximo: 50000 } });
  const res = await call(ventas, "deal_create", deal("Trato enorme", 60000));
  assert.equal(res.outcome, "denegado");
  assert.equal(res.policy, "tope");
  assert.match((await web("/", { cookie: eathan })).text, /Por aprobar \(0\)/);
});

await check("crear un agente pasa por la persona: ve el token una vez y no queda guardado", async () => {
  const page = await govern("agent_create", { name: "agente-soporte", role: "operador" });
  const token = /nxa_[A-Za-z0-9_-]+/.exec(page.text)?.[0];
  assert.ok(token, "la consola no mostro el token");
  const soporte = await connect(token);
  await ok(soporte, "contact_create", { name: "Cliente de soporte" });
  const stored = await withTenant(db, nexarm.tenantId, (tx) =>
    tx.query<{ result: any }>("select result from approvals where tool = 'agent_create'"));
  assert.equal(stored.rows[0]!.result.token, "[secreto]");
  const dump = await db.query<{ t: string }>("select (select json_agg(a) from audit_log a)::text || (select json_agg(p) from approvals p)::text as t");
  assert.ok(!dump.rows[0]!.t.includes(token));
});

await check("suspender es inmediato; reactivar espera a la persona; la consola tambien suspende", async () => {
  await ok(supervisor, "agent_suspend", { id: agents["observador"], suspended: true });
  assert.equal((await call(observador, "contact_search")).reason, "agente suspendido");
  assert.equal((await call(supervisor, "agent_suspend", { id: agents["observador"], suspended: false })).outcome, "pendiente");
  assert.equal((await call(observador, "contact_search")).outcome, "denegado");
  const back = await web(`/agentes/${agents["observador"]}/suspension`, { cookie: eathan, form: { suspendido: "no" } });
  assert.equal(back.status, 302);
  await ok(observador, "contact_search");
  const entry = (await ok(supervisor, "audit_query", { limit: 3 })).entries.find((e: any) => e.tool === "agent_suspend");
  assert.equal(entry.agent_name, "Eathan Jimenez");
});

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const redirectUri = "http://127.0.0.1:9/callback";
let clientId = "";
let refreshToken = "";
const tokenRequest = async (form: Record<string, string>) => {
  const res = await fetch(new URL("/token", base), {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, ...form }).toString(),
  });
  return { status: res.status, body: await res.json() as any };
};
async function authorizeAs(agentId: string, decision = "permitir") {
  const query = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: "S256", state: "abc",
  });
  const consent = await web(`/authorize?${query}`, { cookie: eathan });
  assert.equal(consent.status, 200, consent.text);
  const solicitud = /name="solicitud" value="([^"]+)"/.exec(consent.text)![1]!;
  const done = await web("/oauth/consentimiento", { cookie: eathan, form: { solicitud, agente: agentId, decision } });
  assert.equal(done.status, 302);
  return new URL(done.location).searchParams;
}

await check("un cliente MCP sin credencial descubre OAuth, se registra y sin sesion va al inicio de sesion", async () => {
  const res = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(res.headers.get("www-authenticate") ?? "")?.[1];
  assert.ok(metadataUrl);
  const resource = await (await fetch(metadataUrl)).json() as any;
  assert.equal(resource.resource, mcpUrl.href);
  const server = await (await fetch(new URL("/.well-known/oauth-authorization-server", base))).json() as any;
  assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
  const reg = await fetch(server.registration_endpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Cliente de prueba", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
  });
  assert.equal(reg.status, 201);
  clientId = (await reg.json() as any).client_id;
  const anon = await web(`/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`);
  assert.equal(anon.status, 302);
  assert.match(anon.location, /^\/login\?next=/);
});

await check("la persona elige el agente; el token OAuth actua con el rol de ese agente y nada mas", async () => {
  assert.equal((await authorizeAs(agents["observador"]!, "negar")).get("error"), "access_denied");
  const params = await authorizeAs(agents["observador"]!);
  assert.equal(params.get("state"), "abc");
  const code = params.get("code")!;
  assert.equal((await tokenRequest({ grant_type: "authorization_code", code, code_verifier: "otro-verificador", redirect_uri: redirectUri })).status, 400);
  const tokens = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri });
  assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
  refreshToken = tokens.body.refresh_token;
  const again = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri });
  assert.equal(again.status, 400);
  const viaOauth = await connect(tokens.body.access_token);
  await ok(viaOauth, "contact_search");
  assert.equal((await call(viaOauth, "contact_create", { name: "x" })).outcome, "denegado");
  const entry = (await ok(supervisor, "audit_query", { limit: 5 })).entries.find((e: any) => e.tool === "oauth_authorize");
  assert.equal(entry.args.agente, "observador");
});

await check("el refresco rota y deja de servir cuando el agente se suspende", async () => {
  const first = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal((await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken })).status, 400);
  await ok(supervisor, "agent_suspend", { id: agents["observador"], suspended: true });
  assert.equal((await tokenRequest({ grant_type: "refresh_token", refresh_token: first.body.refresh_token })).status, 400);
  const viaOauth = await connect(first.body.access_token);
  assert.equal((await call(viaOauth, "contact_search")).reason, "agente suspendido");
});

await check("una aprobacion sin decision vence, y la sesion tambien", async () => {
  const res = await call(ventas, "deal_create", deal("Trato olvidado", 30000));
  clock = new Date(INICIO.getTime() + 25 * 3_600_000);
  assert.equal((await ok(ventas, "approval_status", { id: res.approvalId })).status, "vencida");
  assert.equal((await web("/", { cookie: eathan })).location, "/login");
  eathan = await signIn(nexarm.consola);
  const late = await decideWeb(eathan, res.approvalId!, "aprobar");
  assert.equal(late.status, 409);
  assert.match(late.text, /vencio/);
  assert.ok(!(await dealTitles()).includes("Trato olvidado"));
});

await check("cinco claves malas bloquean el inicio de sesion", async () => {
  for (let i = 0; i < 5; i++) await web("/login", { form: { usuario: otro.consola.usuario, clave: "mala" } });
  const res = await web("/login", { form: otro.consola });
  assert.equal(res.status, 401);
  assert.match(res.text, /Demasiados intentos/);
});

await check("el libro sigue integro con las entradas de personas y agentes", async () => {
  for (const t of [nexarm.tenantId, otro.tenantId]) {
    const chain = await verifyChain(db, t);
    assert.ok(chain.ok, `cadena rota en ${chain.brokenAtSeq}`);
  }
  const humans = await db.query<{ n: number }>("select count(*)::int as n from audit_log where actor = 'humano'");
  assert.ok(humans.rows[0]!.n >= 6);
});

console.log(`\n${passed} comprobaciones pasaron`);
http.close();
http.closeAllConnections();
await db.close();
