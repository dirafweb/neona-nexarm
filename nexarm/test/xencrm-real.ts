// Prueba contra un XENCRM encendido (no simulado). Uso: pnpm exec tsx test/xencrm-real.ts
// Exige XENCRM_URL y XENCRM_ADMIN_TOKEN. Usa una base de Nexarm en memoria: no toca la base real ni exige detener Nexarm.
import { transportsFromEnv } from "../src/channels.ts";
import { openDb, withTenant } from "../src/db.ts";
import { seed } from "../src/seed.ts";
import { startXencrm, xencrmConfig } from "../src/xencrm.ts";

const cfg = xencrmConfig({ ...process.env, XENCRM_REINTENTO_MS: "500" });
if (!cfg) { console.error("Define XENCRM_URL y XENCRM_ADMIN_TOKEN"); process.exit(1); }
const admin = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${cfg.url}/admin/api${path}`, {
    method, headers: { "x-admin-token": cfg.token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};
const until = async (what: string, ok: () => Promise<boolean> | boolean, seconds = 60) => {
  for (let i = 0; i < seconds * 4; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no ocurrio a tiempo: ${what}`);
};

const db = await openDb();
const nexarm = await seed(db, "Nexarm", undefined, { ventas: true });
const rows = <T>(sql: string, params: unknown[] = []) =>
  withTenant(db, nexarm.tenantId, async (tx) => (await tx.query<T>(sql, params)).rows);
const bridge = startXencrm(db, () => new Date(), cfg)!;
let failed = false;
try {
  await until("la entrada se conecta al flujo en vivo de XENCRM", () => bridge.connected(), 15);
  console.log(`CONECTA: flujo en vivo de ${cfg.url}`);

  // Entra: una persona escribe por el chat del sitio de XENCRM, deja su correo en la ficha y vuelve a escribir.
  const mark = Date.now();
  const session = `nexarm-${mark}`;
  const email = `prueba.${mark}@example.com`;
  const chat = (message: string) => fetch(`${cfg.url}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: session, message, name: "Prueba Puente" }),
  });
  const first = await chat(`Hola, quiero informacion (${mark})`);
  console.log(`CHAT: primer mensaje, XENCRM respondio ${first.status}`);
  const patch = await admin("PATCH", `/contacts/${encodeURIComponent(`web:${session}`)}`, { data: { correo: email } });
  if (patch.status !== 200) throw new Error(`no se pudo poner el correo en la ficha: ${patch.status} ${JSON.stringify(patch.json)}`);
  void chat(`Mi correo es ${email}, quiero una demo (${mark})`);
  await until("el mensaje del cliente entra a Nexarm", async () => (await rows("select 1 from contacts where email = $1", [email])).length === 1);
  const act = await rows<{ body: string }>("select a.body from activities a join contacts c on c.id = a.contact_id where c.email = $1", [email]);
  console.log(`ENTRA: contacto ${email} creado en Nexarm; historial:\n${act.map((a) => `  ${a.body.replace(/\n/g, " | ")}`).join("\n")}`);
  const visitors = await rows<{ n: number }>("select count(*)::int as n from contacts");
  console.log(`ENTRA: contactos en Nexarm tras dos mensajes: ${visitors[0]!.n} (el primero, sin datos, se quedo en XENCRM)`);

  // Sale: el mismo transporte que usa message_send. Sin sesion de WhatsApp solo se comprueba la busqueda del contacto.
  const send = transportsFromEnv({ XENCRM_URL: cfg.url, XENCRM_ADMIN_TOKEN: cfg.token }).whatsapp!;
  const phone = `+5730${String(mark).slice(-8)}`;
  const absent = await send({ channel: "whatsapp", to: phone, body: "x" }).then(() => "enviado", (e: Error) => e.message);
  console.log(`SALE: a un numero sin conversacion: ${absent}`);
  const alta = await admin("POST", "/contacts", { name: "Prueba Salida", phone });
  console.log(`SALE: ficha de WhatsApp creada en XENCRM: ${alta.status} ${alta.json?.contact?.id ?? JSON.stringify(alta.json)} (canal ${alta.json?.contact?.channel})`);
  const out = await send({ channel: "whatsapp", to: phone, body: `Mensaje de Nexarm (${mark})` }).then((r) => `enviado ${r.id}`, (e: Error) => `rechazado: ${e.message}`);
  console.log(`SALE: a esa ficha: ${out}`);
} catch (err) {
  failed = true;
  console.error(`FALLA: ${(err as Error).message}`);
} finally {
  bridge.stop();
  await db.close();
}
process.exit(failed ? 1 : 0);
