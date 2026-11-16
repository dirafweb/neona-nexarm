import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { execute, identify } from "../src/gateway.ts";
import { startAuto } from "../src/sales/auto.ts";
import { seed } from "../src/seed.ts";
import { XENCRM_AGENT } from "../src/xencrm.ts";

const db = await openDb();
const nexarm = await seed(db, "Nexarm", undefined, { ventas: true });
const otro = await seed(db, "Cliente Demo", "Usuario Demo", { ventas: true });
const entrada = (await identify(db, nexarm.tokens[XENCRM_AGENT]!))!;
const ajena = (await identify(db, otro.tokens[XENCRM_AGENT]!))!;

const runs: { agent: string; task: string }[] = [];
let failing = "";
const auto = startAuto({
  tenantId: nexarm.tenantId, waitMs: 20, log: () => {},
  async run(agent, task) {
    runs.push({ agent: agent.name, task });
    if (agent.name === failing) throw new Error("sin saldo");
    return { report: "hecho", stopReason: "end_turn" };
  },
});

let n = 0;
const receive = async (agent = entrada, phone = "+57 300 555 0101", external = `prueba:${++n}`) =>
  (await execute(db, agent, "message_receive", { channel: "whatsapp", external_id: external, phone, body: "Hola, quiero una demo" })).data as
    { contact_id: string; duplicate: boolean };

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  runs.length = 0;
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

await check("un mensaje nuevo despierta a prospeccion, calificacion y seguimiento, en orden y con el contacto", async () => {
  const { contact_id } = await receive();
  await auto.idle();
  assert.deepEqual(runs.map((r) => r.agent), ["prospeccion", "calificacion", "seguimiento"]);
  for (const r of runs) assert.match(r.task, new RegExp(contact_id));
});

await check("una rafaga del mismo contacto se atiende en una sola ronda, y una entrega repetida no despierta a nadie", async () => {
  await receive();
  await receive();
  await auto.idle();
  assert.equal(runs.length, 3);
  runs.length = 0;
  assert.equal((await receive(entrada, "+57 300 555 0101", "prueba:1")).duplicate, true);
  await auto.idle();
  assert.equal(runs.length, 0);
});

await check("dos contactos se atienden uno despues del otro", async () => {
  const a = await receive(entrada, "+57 300 555 0202");
  const b = await receive(entrada, "+57 300 555 0303");
  await auto.idle();
  assert.equal(runs.length, 6);
  assert.ok(runs.slice(0, 3).every((r) => r.task.includes(a.contact_id)));
  assert.ok(runs.slice(3).every((r) => r.task.includes(b.contact_id)));
});

await check("si un agente falla, los demas atienden igual; el mensaje de otro cliente no despierta a nadie", async () => {
  failing = "calificacion";
  await receive();
  await auto.idle();
  assert.deepEqual(runs.map((r) => r.agent), ["prospeccion", "calificacion", "seguimiento"]);
  failing = "";
  runs.length = 0;
  await receive(ajena, "+57 300 555 0404");
  await auto.idle();
  assert.equal(runs.length, 0);
});

await check("apagado, un mensaje nuevo ya no despierta a los agentes", async () => {
  auto.stop();
  await receive();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runs.length, 0);
});

console.log(`\n${passed} comprobaciones pasaron`);
await db.close();
