import { intakeAgent } from "./chatwoot.ts";
import type { Db } from "./db.ts";
import type { Express } from "express";
import { execute, identify, type Result } from "./gateway.ts";

/** Agente con el que entra a Nexarm lo que escribe un cliente en XENCRM. Solo puede usar message_receive. */
export const XENCRM_AGENT = "entrada-xencrm";

/** Agente con el que el modo agentico de XENCRM pide permiso. Solo puede usar xencrm_read y xencrm_act. */
export const XENCRM_AGENTIC = "agentico-xencrm";

/**
 * POST /gobierno/xencrm: XENCRM pregunta aqui antes de ejecutar cada herramienta de su modo agentico.
 * Cuerpo: { side, tool, effect, args, by, contact, route }. Responde el resultado de la pasarela: XENCRM ejecuta
 * solo con outcome "ejecutado". La credencial es el token del agente, como en /mcp.
 */
export function mountXencrmGovernance(app: Express, db: Db, now: () => Date): void {
  app.post("/gobierno/xencrm", async (req, res) => {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const agent = token ? await identify(db, token, now()) : null;
    if (!agent) { res.status(401).json({ error: "agente no identificado" }); return; }
    const { effect, route, ...call } = (req.body ?? {}) as Record<string, unknown>;
    res.json(effect === "lectura"
      ? await execute(db, agent, "xencrm_read", call, now())
      : await execute(db, agent, "xencrm_act", { ...call, effect, route }, now()));
  });
}

export interface XencrmConfig {
  /** Direccion del tablero de un negocio en XENCRM, sin /admin: http://host:3000 o https://host/c/<cliente>. */
  url: string;
  token: string;
  /** Cliente de Nexarm que recibe. */
  tenant: string;
  retryMs: number;
}

export function xencrmConfig(env: NodeJS.ProcessEnv = process.env): XencrmConfig | null {
  if (!env.XENCRM_URL || !env.XENCRM_ADMIN_TOKEN) return null;
  return {
    url: env.XENCRM_URL.replace(/\/+$/, ""), token: env.XENCRM_ADMIN_TOKEN,
    tenant: env.NEXARM_XENCRM_TENANT ?? "Nexarm", retryMs: Number(env.XENCRM_REINTENTO_MS ?? 5000),
  };
}

interface XenContact { id: string; channel: string; name: string | null; phone: string | null; stage?: string; data?: Record<string, unknown> }
interface XenEvent { type: string; userId: string; payload: { id?: number | string; role?: string; author?: string; content?: string } }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Un evento del flujo en vivo de XENCRM. Solo entra lo que escribe el cliente: lo que responde el asistente o una
 * persona del equipo se queda en XENCRM. Pasa por la pasarela como una llamada del agente de entrada.
 */
export async function receiveFromXencrm(db: Db, now: Date, cfg: XencrmConfig, ev: XenEvent): Promise<Result | { ignored: string }> {
  if (ev.type !== "message" || ev.payload?.role !== "user" || ev.payload.author !== "customer") {
    return { ignored: "solo entra lo que escribe el cliente" };
  }
  if (ev.payload.id === undefined) return { ignored: "el mensaje no trae identificador" };
  const res = await fetch(`${cfg.url}/admin/api/contacts?q=${encodeURIComponent(ev.userId)}&limit=50`, { headers: { "x-admin-token": cfg.token } });
  if (!res.ok) throw new Error(`XENCRM respondio ${res.status} al buscar el contacto`);
  const contact = (await res.json() as XenContact[]).find((c) => c.id === ev.userId);
  if (!contact) return { ignored: "el contacto no aparece en XENCRM" };

  // XENCRM tiene dos canales de WhatsApp: "whatsapp" (codigo QR) y "meta" (API oficial).
  const whatsapp = contact.channel === "whatsapp" || contact.channel === "meta";
  // El identificador de la conversacion (wa:57...@s.whatsapp.net) lleva el numero cuando la ficha aun no lo tiene.
  const number = whatsapp ? /^(?:wa:)?(\d{7,15})@s\.whatsapp\.net$/.exec(contact.id)?.[1] : undefined;
  const jid = number && `+${number}`;
  const phone = contact.phone?.trim() || jid;
  // En el chat del sitio la ficha suele estar vacia: sirve el correo que el cliente escribe en el mensaje.
  const written = /[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}/i.exec(String(ev.payload.content ?? ""))?.[0];
  const mail = [contact.data?.correo, contact.data?.email, written].find((v): v is string => typeof v === "string" && EMAIL.test(v));
  if (!phone && !mail) return { ignored: "el contacto no tiene telefono ni correo en XENCRM" };

  const agent = await intakeAgent(db, cfg.tenant, XENCRM_AGENT);
  if (!agent) throw new Error(`falta el agente ${XENCRM_AGENT}: ejecuta pnpm seed`);
  return execute(db, agent, "message_receive", {
    channel: whatsapp ? "whatsapp" : "chat",
    external_id: `xencrm:${new URL(cfg.url).host}${new URL(cfg.url).pathname}:${ev.payload.id}`.slice(0, 200),
    name: contact.name?.trim() || undefined, email: mail, phone,
    body: (String(ev.payload.content ?? "").trim() || "(sin texto)").slice(0, 8000),
    origin: `XENCRM, canal ${contact.channel}${contact.stage ? `, etapa ${contact.stage}` : ""}`,
  }, now);
}

/**
 * Escucha el flujo en vivo de XENCRM (GET /admin/api/stream) y registra en Nexarm cada mensaje de un cliente.
 * Configuracion: XENCRM_URL y XENCRM_ADMIN_TOKEN; NEXARM_XENCRM_TENANT (por defecto Nexarm).
 * Si la conexion se cae, vuelve a conectar. Lo que el cliente escribio mientras estaba caida queda solo en XENCRM.
 */
export function startXencrm(db: Db, now: () => Date = () => new Date(), cfg = xencrmConfig()): { stop(): void; connected(): boolean } | null {
  if (!cfg) return null;
  const abort = new AbortController();
  let connected = false;

  const handle = async (data: string) => {
    try {
      const out = await receiveFromXencrm(db, now(), cfg, JSON.parse(data));
      if ("outcome" in out && out.outcome !== "ejecutado") console.error(`XENCRM: un mensaje no entro: ${out.reason}`);
      else if ("ignored" in out && out.ignored.startsWith("el contacto")) console.error(`XENCRM: un mensaje no entro: ${out.ignored}`);
    } catch (err) {
      console.error(`XENCRM: un mensaje no entro: ${(err as Error).message}`);
    }
  };

  const listen = async () => {
    const res = await fetch(`${cfg.url}/admin/api/stream`, { headers: { "x-admin-token": cfg.token }, signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`XENCRM respondio ${res.status}`);
    connected = true;
    console.log(`XENCRM: entrada conectada a ${cfg.url}`);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const lines = buffer.slice(0, end).split("\n");
        buffer = buffer.slice(end + 2);
        const field = (name: string) => lines.filter((l) => l.startsWith(`${name}:`)).map((l) => l.slice(name.length + 1).trimStart()).join("\n");
        if (field("event") === "message") await handle(field("data"));
      }
    }
  };

  void (async () => {
    while (!abort.signal.aborted) {
      try { await listen(); } catch (err) {
        if (!abort.signal.aborted && connected) console.error(`XENCRM: se corto la entrada: ${(err as Error).message}`);
      }
      connected = false;
      if (!abort.signal.aborted) await new Promise((r) => setTimeout(r, cfg.retryMs));
    }
  })();

  return { stop: () => abort.abort(), connected: () => connected };
}
