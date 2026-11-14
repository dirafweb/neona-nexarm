import { PGlite, type Transaction } from "@electric-sql/pglite";
import { mkdirSync, readFileSync } from "node:fs";

export type Db = PGlite;
export type Tx = Transaction;

const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

/** Abre la base (carpeta en disco, o en memoria si no se da ruta) y aplica el esquema. */
export async function openDb(dataDir?: string): Promise<Db> {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const db = new PGlite(dataDir);
  await db.exec(schema);
  return db;
}

/** Ejecuta fn dentro de una transaccion que solo ve las filas de ese cliente. */
export function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec("set local role nexarm_app");
    await tx.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    return fn(tx);
  });
}
