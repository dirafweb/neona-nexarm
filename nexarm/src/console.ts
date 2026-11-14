import { randomBytes } from "node:crypto";
import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { appendAudit, verifyChain } from "./audit.ts";
import { CSS, FAVICON, FONTS, FOOTER, ISOTIPO } from "./brand.ts";
import { withTenant, type Db } from "./db.ts";
import { configuredChannels } from "./channels.ts";
import { decide, revert, type Human } from "./gateway.ts";
import { login, logout, sessionUser } from "./humans.ts";
import { createOAuth } from "./oauth.ts";

const COOKIE = "nexarm_sesion";
const CONSENT_MINUTES = 10;

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const when = (d: unknown) => d ? `${new Date(d as string).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
const json = (v: unknown) => esc(JSON.stringify(v, null, 2));

function page(title: string, body: string, human?: Human): string {
  const session = human
    ? `<form method="post" action="/logout"><span class="mut">${esc(human.name)} · ${esc(human.role)}</span> <button>Salir</button></form>` : "";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Nexarm</title><link rel="icon" href="${FAVICON}">${FONTS}<style>${CSS}</style></head><body>
<header><div class="brand">${ISOTIPO}<b>NEXARM</b><p class="tag">// Consola de supervisión</p></div>${session}</header><main>${body}</main>${FOOTER}</body></html>`;
}

interface PendingConsent { client: OAuthClientInformationFull; params: AuthorizationParams; userId: string; expires: number }

/** Consola de supervision y servidor de autorizacion OAuth. Todo lo que hace una persona aqui queda en el libro. */
export function mountConsole(app: express.Express, db: Db, now: () => Date, baseUrl: URL): void {
  const cookie = (req: express.Request) =>
    new RegExp(`(?:^|; )${COOKIE}=([^;]+)`).exec(req.headers.cookie ?? "")?.[1];
  const current = (req: express.Request) => sessionUser(db, cookie(req), now());
  // Con la cookie SameSite=Strict, exigir el mismo origen cierra las peticiones forjadas desde otro sitio.
  const sameOrigin = (req: express.Request) => req.headers.origin === `${req.protocol}://${req.headers.host}`;
  const safeNext = (next: unknown) => typeof next === "string" && next.startsWith("/authorize?") ? next : "/";
  const consents = new Map<string, PendingConsent>();
  const isUuid = (v: unknown) => /^[0-9a-f-]{36}$/i.test(String(v));

  const oauth = createOAuth(db, now, async (client, params, res) => {
    const req = res.req;
    const human = await current(req);
    if (!human) { res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`); return; }
    if (human.role !== "supervisor") {
      res.status(403).send(page("Sin permiso", "<h1>Solo un supervisor conecta agentes</h1>", human));
      return;
    }
    const id = randomBytes(16).toString("base64url");
    consents.set(id, { client, params, userId: human.id, expires: now().getTime() + CONSENT_MINUTES * 60_000 });
    const agents = await withTenant(db, human.tenantId, (tx) =>
      tx.query<{ id: string; name: string; role: string }>("select id, name, role from agents where not suspended order by name"));
    const options = agents.rows.map((a) => `<option value="${esc(a.id)}">${esc(a.name)} (${esc(a.role)})</option>`).join("");
    res.send(page("Conectar agente", `
      <h1>Conectar un cliente MCP</h1>
      <p><b>${esc(client.client_name ?? client.client_id)}</b> pide acceso a Nexarm.
      Vuelve a <span class="mut">${esc(params.redirectUri)}</span>.</p>
      <p>Elige con qué agente actúa. Tendrá exactamente el rol, los permisos y las políticas de ese agente.</p>
      <form class="stack" method="post" action="/oauth/consentimiento">
        <input type="hidden" name="solicitud" value="${esc(id)}">
        <select name="agente" required>${options}</select>
        <button class="go" name="decision" value="permitir">Permitir</button>
        <button name="decision" value="negar">Negar</button>
      </form>`, human));
  });

  app.use(mcpAuthRouter({
    provider: oauth.provider, issuerUrl: baseUrl, resourceServerUrl: new URL("/mcp", baseUrl), resourceName: "Nexarm",
  }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/login", (req, res) => {
    res.send(page("Entrar", `
      <p class="tag">// Acceso</p><h1>Consola de supervisión</h1>
      <form class="stack" method="post" action="/login">
        <input type="hidden" name="next" value="${esc(safeNext(req.query.next))}">
        <input name="usuario" placeholder="Usuario" autocomplete="username" required autofocus>
        <input name="clave" type="password" placeholder="Clave" autocomplete="current-password" required>
        <button class="go">Entrar</button>
      </form>`));
  });

  app.post("/login", async (req, res) => {
    if (!sameOrigin(req)) { res.status(403).send("origen no permitido"); return; }
    const { token, reason } = await login(db, String(req.body?.usuario ?? ""), String(req.body?.clave ?? ""), now());
    if (!token) {
      res.status(401).send(page("Entrar", `<h1>No se pudo entrar</h1><p class="no">${esc(reason)}</p><p><a href="/login">Volver</a></p>`));
      return;
    }
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${req.secure ? "; Secure" : ""}`);
    res.redirect(safeNext(req.body?.next));
  });

  app.post("/logout", async (req, res) => {
    if (!sameOrigin(req)) { res.status(403).send("origen no permitido"); return; }
    await logout(db, cookie(req));
    res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.redirect("/login");
  });

  /** Exige sesion; en los POST, tambien mismo origen y rol de supervisor. */
  async function guard(req: express.Request, res: express.Response): Promise<Human | null> {
    const human = await current(req);
    if (!human) { res.redirect("/login"); return null; }
    if (req.method === "POST" && !sameOrigin(req)) { res.status(403).send("origen no permitido"); return null; }
    if (req.method === "POST" && human.role !== "supervisor") {
      res.status(403).send(page("Sin permiso", "<h1>Solo un supervisor puede hacer esto</h1>", human));
      return null;
    }
    return human;
  }

  app.get("/", async (req, res) => {
    const human = await guard(req, res);
    if (!human) return;
    const t = now().toISOString();
    const data = await withTenant(db, human.tenantId, async (tx) => ({
      pending: (await tx.query<any>(
        `select p.id, p.tool, p.args, p.reason, p.policy, p.requested_at, p.expires_at, a.name as agent,
           c.name as contact_name, case when p.args->>'channel' = 'correo' then c.email else c.phone end as contact_to
         from approvals p join agents a on a.id = p.agent_id
         left join contacts c on p.tool = 'message_send' and c.id::text = p.args->>'contact_id'
         where p.status = 'pendiente' and p.expires_at > $1 order by p.requested_at`, [t])).rows,
      agents: (await tx.query<any>("select id, name, role, suspended, expires_at from agents order by name")).rows,
      policies: (await tx.query<any>(
        `select p.name, p.kind, p.params, p.tool, p.applies_to, p.enabled, a.name as agent
         from policies p left join agents a on a.id = p.agent_id order by p.name`)).rows,
      log: (await tx.query<any>(
        `select l.seq, l.at, l.actor, l.agent_name, l.tool, l.outcome, l.detail,
           u.audit_seq is not null as revertible, u.reverted_at
         from audit_log l left join undo_snapshots u on u.audit_seq = l.seq order by l.seq desc limit 30`)).rows,
      paused: (await tx.query<{ paused: boolean }>("select paused from tenants")).rows[0]!.paused,
    }));
    const chain = await verifyChain(db, human.tenantId);
    const can = human.role === "supervisor";

    const pending = data.pending.map((p) => `
      <div class="card">
        <b>${esc(p.agent)}</b> quiere ejecutar <b>${esc(p.tool)}</b>
        ${p.contact_name ? `<div>Para: <b>${esc(p.contact_name)}</b> · ${esc(p.contact_to ?? "sin destino en su ficha")}</div>` : ""}
        <div class="mut">${esc(p.reason)}${p.policy ? ` · política ${esc(p.policy)}` : ""}</div>
        <pre>${json(p.args)}</pre>
        <div class="mut">Pedida ${when(p.requested_at)} · vence ${when(p.expires_at)}</div>
        ${can ? `<form class="row" method="post" action="/aprobaciones/${esc(p.id)}">
          <input type="text" name="nota" placeholder="Nota (opcional)" maxlength="500">
          <button class="go" name="decision" value="aprobar">Aprobar</button>
          <button name="decision" value="rechazar">Rechazar</button>
        </form>` : ""}
      </div>`).join("") || `<p class="mut">Nada espera tu decisión.</p>`;

    const agents = data.agents.map((a) => `<tr>
      <td>${esc(a.name)}</td><td>${esc(a.role)}</td>
      <td class="${a.suspended ? "no" : "ok"}">${a.suspended ? "suspendido" : "activo"}</td>
      <td>${when(a.expires_at) || "sin vencimiento"}</td>
      <td>${can ? `<form method="post" action="/agentes/${esc(a.id)}/suspension">
        <button name="suspendido" value="${a.suspended ? "no" : "si"}">${a.suspended ? "Reactivar" : "Suspender"}</button></form>` : ""}</td>
    </tr>`).join("");

    const policies = data.policies.map((p) => `<tr>
      <td>${esc(p.name)}</td><td>${esc(p.kind)}</td><td><code>${esc(JSON.stringify(p.params))}</code></td>
      <td>${esc(p.agent ?? "todos")}</td><td>${esc(p.tool ?? "todas")}</td><td>${p.enabled ? "activa" : "apagada"}</td>
    </tr>`).join("") || `<tr><td colspan="6" class="mut">Sin políticas.</td></tr>`;

    const log = data.log.map((e) => `<tr>
      <td>${esc(e.seq)}</td><td>${when(e.at)}</td><td>${esc(e.agent_name)}${e.actor === "humano" ? " (persona)" : ""}</td>
      <td>${esc(e.tool)}</td><td class="${e.outcome === "ejecutado" ? "ok" : e.outcome === "pendiente" ? "" : "no"}">${esc(e.outcome)}</td>
      <td class="mut">${esc(e.detail?.reason ?? "")}</td>
      <td>${e.reverted_at ? `<span class="mut">revertida</span>` : e.revertible && can
        ? `<form method="post" action="/libro/${esc(e.seq)}/revertir"><button>Revertir</button></form>` : ""}</td>
    </tr>`).join("");

    const channels = configuredChannels();
    const stop = `<div class="card">${data.paused
      ? `<b class="no">Operación detenida.</b> Ningún agente ejecuta nada.`
      : `<b class="ok">Agentes operando.</b>`}
      <span class="mut"> Canales de envío: ${channels.length ? esc(channels.join(", ")) : "ninguno configurado"}.</span>
      ${can ? `<form class="row" method="post" action="/pausa">
        <button name="detener" value="${data.paused ? "no" : "si"}">${data.paused ? "Reanudar agentes" : "Detener todos los agentes"}</button>
      </form>` : ""}</div>`;

    res.send(page("Consola", `
      ${stop}
      <p class="tag">// 01 · Aprobaciones</p><h1>Por aprobar (${data.pending.length})</h1>${pending}
      <p class="tag">// 02 · Agentes</p><h2>Agentes</h2><div class="scroll"><table><tr><th>Agente</th><th>Rol</th><th>Estado</th><th>Vence</th><th></th></tr>${agents}</table></div>
      <p class="tag">// 03 · Políticas</p><h2>Políticas</h2><div class="scroll"><table><tr><th>Nombre</th><th>Tipo</th><th>Parámetros</th><th>Agente</th><th>Herramienta</th><th>Estado</th></tr>${policies}</table></div>
      <p class="tag">// 04 · Auditoría</p><h2>Libro de auditoría</h2>
      <p class="${chain.ok ? "ok" : "no"}">${chain.ok
        ? `Cadena íntegra: ${chain.entries} entradas verificadas.`
        : `Cadena alterada en la entrada ${chain.brokenAtSeq}.`}</p>
      <div class="scroll"><table><tr><th>#</th><th>Cuándo</th><th>Quién</th><th>Acción</th><th>Resultado</th><th>Motivo</th><th></th></tr>${log}</table></div>`,
      human));
  });

  app.post("/aprobaciones/:id", async (req, res) => {
    const human = await guard(req, res);
    if (!human) return;
    if (!isUuid(req.params.id)) { res.status(404).send("no encontrada"); return; }
    const decision = req.body?.decision === "aprobar" ? "aprobar" : "rechazar";
    const out = await decide(db, human, String(req.params.id), decision, String(req.body?.nota ?? "").slice(0, 500), now());
    const title = out.ok ? `Solicitud ${out.status}` : "No se pudo decidir";
    res.status(out.ok ? 200 : 409).send(page(title, `
      <h1 class="${out.ok ? "ok" : "no"}">${esc(title)}</h1>
      ${out.tool ? `<p><b>${esc(out.agent)}</b> · ${esc(out.tool)}</p>` : ""}
      ${out.reason ? `<p class="no">${esc(out.reason)}</p>` : ""}
      ${out.data !== undefined ? `<p class="mut">Resultado. Si incluye un token, cópialo ahora: no se guarda ni se vuelve a mostrar.</p><pre>${json(out.data)}</pre>` : ""}
      <p><a href="/">Volver a la consola</a></p>`, human));
  });

  app.post("/agentes/:id/suspension", async (req, res) => {
    const human = await guard(req, res);
    if (!human) return;
    if (!isUuid(req.params.id)) { res.status(404).send("no encontrado"); return; }
    const suspended = req.body?.suspendido === "si";
    await withTenant(db, human.tenantId, async (tx) => {
      const r = await tx.query<{ name: string }>(
        "update agents set suspended = $2 where id = $1 returning name", [String(req.params.id), suspended]);
      if (!r.rows[0]) return;
      await appendAudit(tx, {
        tenantId: human.tenantId, agentId: human.id, agentName: human.name, userId: human.id, actor: "humano",
        tool: "agent_suspend", args: { id: req.params.id, suspended }, outcome: "ejecutado", detail: { agent: r.rows[0].name },
      }, now());
    });
    res.redirect("/");
  });

  app.post("/libro/:seq/revertir", async (req, res) => {
    const human = await guard(req, res);
    if (!human) return;
    const seq = Number(req.params.seq);
    if (!Number.isSafeInteger(seq)) { res.status(404).send("no encontrada"); return; }
    const out = await revert(db, human, seq, now());
    const title = out.ok ? `Acción #${seq} revertida` : `No se pudo revertir la acción #${seq}`;
    res.status(out.ok ? 200 : 409).send(page(title, `
      <h1 class="${out.ok ? "ok" : "no"}">${esc(title)}</h1>
      ${out.tool ? `<p><b>${esc(out.agent)}</b> · ${esc(out.tool)}</p>` : ""}
      ${out.reason ? `<p class="no">${esc(out.reason)}</p>` : ""}
      <p><a href="/">Volver a la consola</a></p>`, human));
  });

  app.post("/pausa", async (req, res) => {
    const human = await guard(req, res);
    if (!human) return;
    const paused = req.body?.detener === "si";
    await withTenant(db, human.tenantId, async (tx) => {
      await appendAudit(tx, {
        tenantId: human.tenantId, agentId: human.id, agentName: human.name, userId: human.id, actor: "humano",
        tool: "tenant_pause", args: { detener: paused }, outcome: "ejecutado", detail: {},
      }, now());
    });
    // tenants no admite escritura del rol de aplicacion: el freno solo se mueve desde aqui.
    await db.query("update tenants set paused = $2 where id = $1", [human.tenantId, paused]);
    res.redirect("/");
  });

  app.post("/oauth/consentimiento", async (req, res) => {
    const human = await guard(req, res);
    if (!human) return;
    const id = String(req.body?.solicitud ?? "");
    const consent = consents.get(id);
    consents.delete(id);
    if (!consent || consent.userId !== human.id || consent.expires <= now().getTime()) {
      res.status(400).send(page("Solicitud vencida", "<h1>La solicitud venció</h1><p>Vuelve a conectar desde el cliente MCP.</p>", human));
      return;
    }
    const { client, params } = consent;
    const back = new URL(params.redirectUri);
    if (params.state) back.searchParams.set("state", params.state);
    const agent = req.body?.decision === "permitir" ? await withTenant(db, human.tenantId, async (tx) => {
      const r = await tx.query<{ id: string; name: string }>(
        "select id, name from agents where id = $1 and not suspended", [isUuid(req.body?.agente) ? req.body.agente : null]);
      if (!r.rows[0]) return null;
      await appendAudit(tx, {
        tenantId: human.tenantId, agentId: human.id, agentName: human.name, userId: human.id, actor: "humano",
        tool: "oauth_authorize", args: { cliente: client.client_name ?? client.client_id, agente: r.rows[0].name },
        outcome: "ejecutado", detail: { client_id: client.client_id, redirect_uri: params.redirectUri },
      }, now());
      return r.rows[0];
    }) : null;
    if (agent) back.searchParams.set("code", await oauth.issueCode(client.client_id, agent.id, params));
    else back.searchParams.set("error", "access_denied");
    res.redirect(back.href);
  });
}
