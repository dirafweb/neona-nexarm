import { randomBytes } from "node:crypto";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Db } from "./db.ts";
import { hashToken } from "./tokens.ts";

const CODE_MINUTES = 5;
const ACCESS_SECONDS = 3600;
const REFRESH_DAYS = 30;

const secret = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

/**
 * Servidor de autorizacion OAuth 2.1 con PKCE para clientes MCP.
 * Un token OAuth siempre equivale a un agente concreto, elegido por una persona con sesion en la consola.
 * authorize es la pantalla de consentimiento; la pone la consola.
 */
export function createOAuth(db: Db, now: () => Date, authorize: OAuthServerProvider["authorize"]) {
  const later = (ms: number) => new Date(now().getTime() + ms).toISOString();

  async function issue(clientId: string, agentId: string): Promise<OAuthTokens> {
    const access = secret("nxo");
    const refresh = secret("nxr");
    await db.query(
      "insert into oauth_tokens (token_hash, kind, client_id, agent_id, expires_at) values ($1,'acceso',$3,$4,$5), ($2,'refresco',$3,$4,$6)",
      [hashToken(access), hashToken(refresh), clientId, agentId, later(ACCESS_SECONDS * 1000), later(REFRESH_DAYS * 86_400_000)]);
    return { access_token: access, token_type: "bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh };
  }

  const provider: OAuthServerProvider = {
    clientsStore: {
      async getClient(clientId) {
        const r = await db.query<{ info: OAuthClientInformationFull }>("select info from oauth_clients where client_id = $1", [clientId]);
        return r.rows[0]?.info;
      },
      async registerClient(client) {
        const full = client as OAuthClientInformationFull;
        await db.query("insert into oauth_clients (client_id, info) values ($1,$2)", [full.client_id, JSON.stringify(full)]);
        return full;
      },
    },
    authorize,
    async challengeForAuthorizationCode(client, code) {
      const r = await db.query<{ challenge: string }>(
        "select challenge from oauth_codes where code_hash = $1 and client_id = $2 and expires_at > $3",
        [hashToken(code), client.client_id, now().toISOString()]);
      if (!r.rows[0]) throw new InvalidGrantError("codigo de autorizacion invalido o vencido");
      return r.rows[0].challenge;
    },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
      // Borrar al canjear hace que cada codigo sirva una sola vez.
      const r = await db.query<{ agent_id: string; redirect_uri: string }>(
        "delete from oauth_codes where code_hash = $1 and client_id = $2 and expires_at > $3 returning agent_id, redirect_uri",
        [hashToken(code), client.client_id, now().toISOString()]);
      const row = r.rows[0];
      if (!row) throw new InvalidGrantError("codigo de autorizacion invalido o vencido");
      if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError("redirect_uri no coincide");
      return issue(client.client_id, row.agent_id);
    },
    async exchangeRefreshToken(client, refreshToken) {
      const r = await db.query<{ agent_id: string }>(
        `delete from oauth_tokens where token_hash = $1 and kind = 'refresco' and client_id = $2 and expires_at > $3
           and agent_id in (select id from agents where not suspended) returning agent_id`,
        [hashToken(refreshToken), client.client_id, now().toISOString()]);
      if (!r.rows[0]) throw new InvalidGrantError("token de refresco invalido, vencido o de un agente suspendido");
      return issue(client.client_id, r.rows[0].agent_id);
    },
    async verifyAccessToken(token) {
      const r = await db.query<{ client_id: string; agent_id: string; expires_at: Date }>(
        "select client_id, agent_id, expires_at from oauth_tokens where token_hash = $1 and kind = 'acceso' and expires_at > $2",
        [hashToken(token), now().toISOString()]);
      const row = r.rows[0];
      if (!row) throw new InvalidTokenError("token invalido o vencido");
      return {
        token, clientId: row.client_id, scopes: [], expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
        extra: { agentId: row.agent_id },
      };
    },
    async revokeToken(client, request) {
      await db.query("delete from oauth_tokens where token_hash = $1 and client_id = $2", [hashToken(request.token), client.client_id]);
    },
  };

  /** Emite el codigo de un solo uso tras el consentimiento de una persona. */
  async function issueCode(clientId: string, agentId: string, params: AuthorizationParams): Promise<string> {
    const code = secret("nxc");
    await db.query(
      "insert into oauth_codes (code_hash, client_id, agent_id, challenge, redirect_uri, expires_at) values ($1,$2,$3,$4,$5,$6)",
      [hashToken(code), clientId, agentId, params.codeChallenge, params.redirectUri, later(CODE_MINUTES * 60_000)]);
    return code;
  }

  return { provider, issueCode };
}
