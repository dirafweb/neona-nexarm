import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import type { Db } from "./db.ts";
import { execute, type Agent } from "./gateway.ts";
import type { Role } from "./tools.ts";

/** Agente con el que entra a Nexarm lo que llega de Chatwoot. Solo puede usar message_receive. */
export const INTAKE_AGENT = "entrada-chatwoot";

const MAX_SKEW_SECONDS = 300;
const CHANNELS: Record<string, "correo" | "whatsapp"> = { "Channel::Email": "correo", "Channel::Whatsapp": "whatsapp" };

/** Chatwoot firma cada entrega con HMAC-SHA256 de "marca_de_tiempo.cuerpo". Una entrega vieja o mal firmada no entra. */
export function validSignature(secret: string, timestamp: string, signature: string, body: Buffer, now: Date): boolean {
  if (!/^\d+$/.test(timestamp) || Math.abs(now.getTime() / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex")}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** El agente de entrada de un cliente, por nombre. */
export async function intakeAgent(db: Db, tenantName: string, name: string = INTAKE_AGENT): Promise<Agent | null> {
  const r = await db.query<{
    id: string; tenant_id: string; name: string; role: Role; on_behalf_of: string; suspended: boolean; expires_at: Date | null;
  }>(
    `select a.id, a.tenant_id, a.name, a.role, a.on_behalf_of, a.suspended, a.expires_at
     from agents a join tenants t on t.id = a.tenant_id where t.name = $1 and a.name = $2`, [tenantName, name]);
  const a = r.rows[0];
  return a ? {
    id: a.id, tenantId: a.tenant_id, name: a.name, role: a.role, userId: a.on_behalf_of, suspended: a.suspended,
    expiresAt: a.expires_at && new Date(a.expires_at),
  } : null;
}

/**
 * Entrada de Chatwoot: cada mensaje que escribe un contacto en cualquier bandeja llega aqui y pasa por la pasarela
 * como una llamada del agente de entrada, con su permiso, sus politicas y su linea en el libro.
 * Configuracion: CHATWOOT_WEBHOOK_SECRET (el secreto del webhook en Chatwoot), CHATWOOT_ACCOUNT_ID y
 * NEXARM_CHATWOOT_TENANT (cliente de Nexarm que recibe; por defecto Nexarm).
 */
export function mountChatwoot(app: express.Express, db: Db, now: () => Date): void {
  app.post("/chatwoot/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    const secret = process.env.CHATWOOT_WEBHOOK_SECRET;
    if (!secret) { res.status(503).json({ error: "la entrada de Chatwoot no esta configurada en este servidor" }); return; }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const header = (name: string) => String(req.headers[name] ?? "");
    if (!validSignature(secret, header("x-chatwoot-timestamp"), header("x-chatwoot-signature"), raw, now())) {
      res.status(401).json({ error: "firma invalida o entrega vencida" });
      return;
    }
    let event: any;
    try { event = JSON.parse(raw.toString("utf8")); } catch { res.status(400).json({ error: "el cuerpo no es JSON" }); return; }

    const ignore = (reason: string) => { res.json({ ignored: reason }); };
    if (event?.event !== "message_created") return ignore("solo entra message_created");
    if (event.message_type !== "incoming" || event.private) return ignore("solo entra lo que escribe el contacto");
    const account = process.env.CHATWOOT_ACCOUNT_ID;
    if (account && String(event.account?.id) !== account) return ignore("la entrega es de otra cuenta de Chatwoot");
    const email: string | undefined = event.sender?.email || undefined;
    const phone: string | undefined = event.sender?.phone_number || undefined;
    if (!email && !phone) return ignore("el contacto no tiene correo ni telefono");

    const agent = await intakeAgent(db, process.env.NEXARM_CHATWOOT_TENANT ?? "Nexarm");
    if (!agent) { res.status(503).json({ error: `falta el agente ${INTAKE_AGENT}: ejecuta pnpm seed` }); return; }
    const attachments = Array.isArray(event.attachments) ? event.attachments.length : 0;
    const result = await execute(db, agent, "message_receive", {
      channel: CHANNELS[event.conversation?.channel] ?? "chat",
      external_id: `chatwoot:${event.account?.id}:${event.id}`,
      name: event.sender?.name || undefined, email, phone,
      subject: event.conversation?.additional_attributes?.mail_subject || undefined,
      body: (String(event.content ?? "").trim() || `(sin texto; adjuntos: ${attachments})`).slice(0, 8000),
      origin: `Chatwoot, bandeja ${event.inbox?.name ?? event.inbox?.id ?? "?"}, conversacion ${event.conversation?.id ?? "?"}`,
    }, now());
    res.status(result.outcome === "ejecutado" ? 200 : 422).json(result);
  });
}
