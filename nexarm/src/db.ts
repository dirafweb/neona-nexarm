import { mkdirSync, readFileSync } from "node:fs";

/** Lo que el codigo usa de una conexion: igual en PGlite (archivo local) y en Postgres servidor. */
export interface Tx {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}

export interface Db extends Tx {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const schema = () => readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

/** Postgres servidor (Neon en Vercel). Los enteros largos llegan como numero, igual que en PGlite. */
async function openPostgres(url: string, migrate: boolean): Promise<Db> {
  const pg = (await import("pg")).default;
  pg.types.setTypeParser(20, (v) => { const n = BigInt(v); return Number.isSafeInteger(Number(n)) ? Number(n) : n; });
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.NEXARM_PG_MAX ?? 5), idleTimeoutMillis: 10_000 });
  pool.on("error", (err) => console.error(`Postgres: conexion inactiva con error: ${err.message}`));
  const db: Db = {
    query: async (sql, params) => ({ rows: (await pool.query(sql, params)).rows }),
    exec: (sql) => pool.query(sql),
    close: () => pool.end(),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn({
          query: async (sql, params) => ({ rows: (await client.query(sql, params)).rows }),
          exec: (sql) => client.query(sql),
        });
        await client.query("commit");
        return out;
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
  if (migrate) {
    await db.exec(schema());
    // Quien crea un rol en Postgres servidor no puede asumirlo hasta darse esa membresia.
    await db.exec("grant nexarm_app to current_user");
  }
  return db;
}

/**
 * Abre la base y aplica el esquema. Con DATABASE_URL es un Postgres servidor: el esquema solo se aplica con
 * migrate, para que cada arranque en la nube no lo reescriba. Sin ella es PGlite: carpeta en disco, o memoria.
 */
export async function openDb(dataDir?: string, opts: { url?: string; migrate?: boolean } = {}): Promise<Db> {
  const url = opts.url ?? (dataDir ? undefined : process.env.DATABASE_URL);
  if (url) return openPostgres(url, opts.migrate ?? false);
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite(dataDir);
  await db.exec(schema());
  return db as unknown as Db;
}

/** Ejecuta fn dentro de una transaccion que solo ve las filas de ese cliente. */
export function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec("set local role nexarm_app");
    await tx.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    return fn(tx);
  });
}
