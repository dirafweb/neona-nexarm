import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.ts";
import type { Human } from "./gateway.ts";
import { hashToken } from "./tokens.ts";

const SESSION_HOURS = 12;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64url")}$${scryptSync(password, salt, 32).toString("base64url")}`;
}

function checkPassword(password: string, stored: string | null): boolean {
  const [scheme, salt, hash] = (stored ?? "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  return timingSafeEqual(scryptSync(password, Buffer.from(salt, "base64url"), expected.length), expected);
}

/** Intentos fallidos por usuario. Vive en memoria: un reinicio los borra. */
const failures = new Map<string, { count: number; until: number }>();

/** Comprueba usuario y clave. Devuelve el token de sesion, o la causa del rechazo. */
export async function login(db: Db, loginName: string, password: string, now: Date): Promise<{ token?: string; reason?: string }> {
  const key = loginName.trim().toLowerCase();
  const f = failures.get(key);
  if (f && f.count >= MAX_FAILURES && f.until > now.getTime()) {
    return { reason: `Demasiados intentos. Espera ${LOCK_MINUTES} minutos.` };
  }
  const r = await db.query<{ id: string; password_hash: string | null }>(
    "select id, password_hash from users where login = $1", [key]);
  const user = r.rows[0];
  if (!user || !checkPassword(password, user.password_hash)) {
    const count = (f && f.until > now.getTime() ? f.count : 0) + 1;
    failures.set(key, { count, until: now.getTime() + LOCK_MINUTES * 60_000 });
    return { reason: "Usuario o clave incorrectos." };
  }
  failures.delete(key);
  const token = `nxs_${randomBytes(32).toString("base64url")}`;
  await db.query("insert into sessions (token_hash, user_id, expires_at) values ($1,$2,$3)",
    [hashToken(token), user.id, new Date(now.getTime() + SESSION_HOURS * 3_600_000).toISOString()]);
  return { token };
}

export async function sessionUser(db: Db, token: string | undefined, now: Date): Promise<Human | null> {
  if (!token) return null;
  const r = await db.query<{ id: string; tenant_id: string; name: string; role: Human["role"] }>(
    `select u.id, u.tenant_id, u.name, u.role from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > $2`, [hashToken(token), now.toISOString()]);
  const u = r.rows[0];
  return u ? { id: u.id, tenantId: u.tenant_id, name: u.name, role: u.role } : null;
}

export async function logout(db: Db, token: string | undefined): Promise<void> {
  if (token) await db.query("delete from sessions where token_hash = $1", [hashToken(token)]);
}
