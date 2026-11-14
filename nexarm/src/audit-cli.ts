import { openDb, withTenant } from "./db.ts";
import { verifyChain } from "./audit.ts";

const db = await openDb(process.env.NEXARM_DATA ?? "./data/pg");
const tenants = await db.query<{ id: string; name: string }>("select id, name from tenants order by name");
for (const t of tenants.rows) {
  const chain = await verifyChain(db, t.id);
  console.log(`\n${t.name}: ${chain.entries} entradas, cadena ${chain.ok ? "integra" : `ROTA en seq ${chain.brokenAtSeq}`}`);
  const rows = await withTenant(db, t.id, (tx) =>
    tx.query<{ seq: number; at: Date; agent_name: string; tool: string; outcome: string }>(
      "select seq, at, agent_name, tool, outcome from audit_log order by seq desc limit 20"));
  for (const r of rows.rows) console.log(`  #${r.seq} ${new Date(r.at).toISOString()} ${r.agent_name} ${r.tool} -> ${r.outcome}`);
}
await db.close();
