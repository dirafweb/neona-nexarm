import nodemailer from "nodemailer";

export type Channel = "correo" | "whatsapp";

export interface Outbound { channel: Channel; to: string; name?: string; subject?: string; body: string }

/** Entrega un mensaje y devuelve el identificador que le dio el proveedor. Lanza si el proveedor lo rechaza. */
export type Transport = (message: Outbound) => Promise<{ id: string }>;

async function requestJson(url: string, method: string, headers: Record<string, string>, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`el proveedor respondio ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const postJson = (url: string, token: string, body: unknown) => requestJson(url, "POST", { authorization: `Bearer ${token}` }, body);

/** Telefono como lo exige Chatwoot: signo mas y solo digitos. */
export const e164 = (phone: string) => `+${phone.replace(/\D/g, "")}`;

/**
 * Envia por una bandeja de Chatwoot: el mensaje sale por el canal de esa bandeja y queda en la conversacion del contacto,
 * donde tambien llega su respuesta. Usa la conversacion abierta del contacto en esa bandeja, o abre una.
 */
function chatwootTransport(base: string, token: string, account: string, inboxId: number, channel: Channel): Transport {
  const api = `${base.replace(/\/+$/, "")}/api/v1/accounts/${account}`;
  const call = (method: string, path: string, body?: unknown) => requestJson(api + path, method, { api_access_token: token }, body);
  const field = channel === "correo" ? "email" : "phone_number";
  return async (m) => {
    const value = channel === "correo" ? m.to.trim() : e164(m.to);
    const same = (other: unknown) => typeof other === "string" && other.trim().toLowerCase() === value.toLowerCase();
    const found = (await call("GET", `/contacts/search?q=${encodeURIComponent(value)}`)).payload.find((c: any) => same(c[field]));
    const contactId: number = found?.id
      ?? (await call("POST", "/contacts", { inbox_id: inboxId, name: m.name ?? m.to, [field]: value })).payload.contact.id;
    const open = (await call("GET", `/contacts/${contactId}/conversations`)).payload
      .find((c: any) => c.inbox_id === inboxId && c.status !== "resolved");
    if (open) {
      const msg = await call("POST", `/conversations/${open.id}/messages`, { content: m.body, message_type: "outgoing" });
      return { id: `chatwoot:conversacion:${open.id}:mensaje:${msg.id}` };
    }
    const conv = await call("POST", "/conversations", {
      inbox_id: inboxId, contact_id: contactId, additional_attributes: m.subject ? { mail_subject: m.subject } : {},
      message: { content: m.body },
    });
    return { id: `chatwoot:conversacion:${conv.id}` };
  };
}

/**
 * Envia por XENCRM: el mensaje sale por el WhatsApp del negocio y queda en la conversacion del contacto, firmado Nexarm.
 * XENCRM solo escribe a quien ya tiene conversacion, y al responder pausa a su asistente en esa conversacion.
 */
function xencrmTransport(base: string, token: string): Transport {
  const api = `${base.replace(/\/+$/, "")}/admin/api`;
  const call = (method: string, path: string, body?: unknown) => requestJson(api + path, method, { "x-admin-token": token }, body);
  const digits = (v: unknown) => String(v ?? "").replace(/@.*$/, "").replace(/\D/g, "");
  return async (m) => {
    const want = digits(m.to);
    const found = (await call("GET", `/contacts?q=${want}&limit=50`) as any[])
      .find((c) => (c.channel === "whatsapp" || c.channel === "meta") && [c.phone, c.id].some((v) => digits(v) === want));
    if (!found) throw new Error("ese telefono no tiene conversacion de WhatsApp en XENCRM: el contacto debe escribir primero");
    await call("POST", `/contacts/${encodeURIComponent(found.id)}/reply`, { text: m.body, by: "Nexarm" });
    return { id: `xencrm:${found.id}:${Date.now()}` };
  };
}

/**
 * Canales configurados por variables de entorno. Un canal sin configurar no existe: enviar por el falla con su causa.
 * Chatwoot (CHATWOOT_URL, CHATWOOT_TOKEN, CHATWOOT_ACCOUNT_ID) atiende cada canal que tenga bandeja:
 * CHATWOOT_INBOX_CORREO y CHATWOOT_INBOX_WHATSAPP. Un canal con bandeja sale por Chatwoot y no por el proveedor directo.
 * Correo directo: SMTP (NEXARM_SMTP_HOST, _PORT, _USER, _PASS) o Resend (RESEND_API_KEY); remitente en NEXARM_CORREO_REMITENTE.
 * WhatsApp directo: API de la nube de Meta (WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_API_VERSION).
 * XENCRM (XENCRM_URL, XENCRM_ADMIN_TOKEN): con el, WhatsApp sale por la conversacion del contacto en XENCRM.
 */
export function transportsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<Record<Channel, Transport>> {
  const out: Partial<Record<Channel, Transport>> = {};
  const from = env.NEXARM_CORREO_REMITENTE;
  if (from && env.NEXARM_SMTP_HOST) {
    const port = Number(env.NEXARM_SMTP_PORT ?? 465);
    const smtp = nodemailer.createTransport({
      host: env.NEXARM_SMTP_HOST, port, secure: port === 465,
      auth: { user: env.NEXARM_SMTP_USER ?? from, pass: env.NEXARM_SMTP_PASS ?? "" },
    });
    out.correo = async (m) => ({ id: (await smtp.sendMail({ from, to: m.to, subject: m.subject, text: m.body })).messageId });
  } else if (from && env.RESEND_API_KEY) {
    const key = env.RESEND_API_KEY;
    out.correo = async (m) =>
      ({ id: (await postJson("https://api.resend.com/emails", key, { from, to: [m.to], subject: m.subject, text: m.body })).id });
  }
  if (env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID && env.WHATSAPP_API_VERSION) {
    const url = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_ID}/messages`;
    const token = env.WHATSAPP_TOKEN;
    // Texto libre: Meta solo lo entrega dentro de las 24 horas siguientes al ultimo mensaje del contacto.
    out.whatsapp = async (m) => ({
      id: (await postJson(url, token, {
        messaging_product: "whatsapp", to: m.to.replace(/\D/g, ""), type: "text", text: { body: m.body },
      })).messages[0].id,
    });
  }
  if (env.CHATWOOT_URL && env.CHATWOOT_TOKEN && env.CHATWOOT_ACCOUNT_ID) {
    const inboxes: [Channel, string | undefined][] = [["correo", env.CHATWOOT_INBOX_CORREO], ["whatsapp", env.CHATWOOT_INBOX_WHATSAPP]];
    for (const [channel, inbox] of inboxes) {
      if (inbox) out[channel] = chatwootTransport(env.CHATWOOT_URL, env.CHATWOOT_TOKEN, env.CHATWOOT_ACCOUNT_ID, Number(inbox), channel);
    }
  }
  if (env.XENCRM_URL && env.XENCRM_ADMIN_TOKEN) out.whatsapp = xencrmTransport(env.XENCRM_URL, env.XENCRM_ADMIN_TOKEN);
  return out;
}

/** Ejecuta una ruta de la API del tablero de XENCRM (sin /admin/api/ delante) y devuelve lo que respondio. */
export async function callXencrm(route: { method: string; path: string; body?: unknown }, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  if (!env.XENCRM_URL || !env.XENCRM_ADMIN_TOKEN) throw new Error("XENCRM no esta configurado en este servidor");
  const url = `${env.XENCRM_URL.replace(/\/+$/, "")}/admin/api/${route.path.replace(/^\/+/, "")}`;
  return requestJson(url, route.method, { "x-admin-token": env.XENCRM_ADMIN_TOKEN }, route.body ?? {});
}

let transports = transportsFromEnv();

/** Sustituye los canales. Lo usan las pruebas para no enviar nada real. */
export function setTransports(next: Partial<Record<Channel, Transport>>): void {
  transports = next;
}

export const configuredChannels = (): Channel[] => Object.keys(transports) as Channel[];

export async function send(message: Outbound): Promise<{ id: string }> {
  const transport = transports[message.channel];
  if (!transport) throw new Error(`el canal ${message.channel} no esta configurado en este servidor`);
  return transport(message);
}
