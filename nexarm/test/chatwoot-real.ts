// Prueba contra el Chatwoot instalado (no simulado). Uso: pnpm tsx test/chatwoot-real.ts
// Exige Nexarm encendido con arrancar-con-chatwoot.ps1.
import { readFileSync } from "node:fs";
import { transportsFromEnv } from "../src/channels.js";

const c = JSON.parse(readFileSync(new URL("../.chatwoot.local.json", import.meta.url), "utf8"));
const api = `${c.url}/api/v1/accounts/${c.account_id}`;
const headers = { "content-type": "application/json", api_access_token: c.token };
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(api + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<any>;
};
const mark = Date.now();
const email = `prueba.${mark}@example.com`;

// Entra: una persona escribe en Chatwoot y Chatwoot avisa a Nexarm.
const contact = await call("POST", "/contacts", { inbox_id: c.inbox_pruebas, name: "Prueba Local", email });
const contactId = contact.payload.contact.id;
const conv = await call("POST", "/conversations", { inbox_id: c.inbox_pruebas, contact_id: contactId });
const inbound = await call("POST", `/conversations/${conv.id}/messages`,
  { content: `Hola, quiero informacion de Nexarm (${mark})`, message_type: "incoming" });
console.log(`ENTRA: mensaje ${inbound.id} creado en la conversacion ${conv.id} de Chatwoot, remitente ${email}`);

// Sale: el mismo transporte que usa message_send escribe en la conversacion del contacto.
const send = transportsFromEnv({
  CHATWOOT_URL: c.url, CHATWOOT_TOKEN: c.token, CHATWOOT_ACCOUNT_ID: String(c.account_id),
  CHATWOOT_INBOX_CORREO: String(c.inbox_pruebas),
}).correo!;
const sent = await send({ channel: "correo", to: email, name: "Prueba Local", subject: "Respuesta", body: `Respuesta de Nexarm (${mark})` });
const messages = (await call("GET", `/conversations/${conv.id}/messages`)).payload as any[];
const out = messages.find((m) => m.content === `Respuesta de Nexarm (${mark})`);
console.log(`SALE: ${sent.id}; visible en la misma conversacion: ${Boolean(out)} (tipo ${out?.message_type})`);
if (!out || !sent.id.startsWith(`chatwoot:conversacion:${conv.id}`)) process.exit(1);
