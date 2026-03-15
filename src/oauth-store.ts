// OAuth 2.1 store for MCP server -- SQLite-backed.
// Implements OAuthServerProvider from the MCP SDK.
// Handles client registration, authorization codes, tokens.

import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthTokens,
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";

// ---------------------------------------------------------------------------
// Schema creation (called from index.ts migration)
// ---------------------------------------------------------------------------

export function createOAuthTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id           TEXT NOT NULL PRIMARY KEY,
      client_secret       TEXT,
      client_secret_hash  TEXT,
      redirect_uris       TEXT NOT NULL DEFAULT '[]',
      client_name         TEXT,
      grant_types         TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
      response_types      TEXT NOT NULL DEFAULT '["code"]',
      scope               TEXT,
      created_at          TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS oauth_codes (
      code          TEXT NOT NULL PRIMARY KEY,
      client_id     TEXT NOT NULL,
      challenge     TEXT NOT NULL,
      redirect_uri  TEXT NOT NULL,
      scopes        TEXT NOT NULL DEFAULT '[]',
      resource      TEXT,
      expires_at    TEXT NOT NULL,
      created_at    TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token         TEXT NOT NULL PRIMARY KEY,
      token_type    TEXT NOT NULL,
      client_id     TEXT NOT NULL,
      scopes        TEXT NOT NULL DEFAULT '[]',
      resource      TEXT,
      expires_at    TEXT,
      created_at    TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);
  `);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJson(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try { return JSON.parse(raw); }
  catch { return []; }
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return ha.length === hb.length && timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// Clients store
// ---------------------------------------------------------------------------

class SqliteClientsStore implements OAuthRegisteredClientsStore {
  constructor(private db: Database.Database) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db
      .prepare(`SELECT * FROM oauth_clients WHERE client_id = ?`)
      .get(clientId) as Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      client_id: row.client_id,
      client_secret: undefined,
      redirect_uris: safeJson(row.redirect_uris) as string[],
      client_name: row.client_name || undefined,
      grant_types: safeJson(row.grant_types) as string[],
      response_types: safeJson(row.response_types) as string[],
      scope: row.scope || undefined,
      client_id_issued_at: Math.floor(new Date(row.created_at).getTime() / 1000),
    };
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const clientId = `rm_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const clientSecret = `rms_${randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO oauth_clients (client_id, client_secret, client_secret_hash, redirect_uris, client_name, grant_types, response_types, scope, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        clientId,
        clientSecret,
        hashSecret(clientSecret),
        JSON.stringify(client.redirect_uris || []),
        client.client_name || null,
        JSON.stringify(client.grant_types || ["authorization_code", "refresh_token"]),
        JSON.stringify(client.response_types || ["code"]),
        client.scope || null,
        now,
      );

    return {
      ...client,
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
  }
}

// ---------------------------------------------------------------------------
// OAuth provider
// ---------------------------------------------------------------------------

interface OAuthStoreConfig {
  db: Database.Database;
  issuerUrl: string;
}

export class ReflectOAuthProvider implements OAuthServerProvider {
  private db: Database.Database;
  private _clientsStore: SqliteClientsStore;
  public issuerUrl: string;

  constructor(config: OAuthStoreConfig) {
    this.db = config.db;
    this._clientsStore = new SqliteClientsStore(config.db);
    this.issuerUrl = config.issuerUrl;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  // Show a minimal consent page, then redirect back with auth code.
  // Since this is a single-owner product, auto-approve.
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const code = randomUUID().replace(/-/g, "");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);

    this.db
      .prepare(
        `INSERT INTO oauth_codes (code, client_id, challenge, redirect_uri, scopes, resource, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        code,
        client.client_id,
        params.codeChallenge,
        params.redirectUri,
        JSON.stringify(params.scopes || []),
        params.resource?.toString() || null,
        expiresAt.toISOString(),
        now.toISOString(),
      );

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state) {
      redirectUrl.searchParams.set("state", params.state);
    }

    res.redirect(302, redirectUrl.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const row = this.db
      .prepare(`SELECT challenge FROM oauth_codes WHERE code = ?`)
      .get(authorizationCode) as { challenge: string } | undefined;
    if (!row) throw new Error("Invalid authorization code");
    return row.challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.db
      .prepare(`SELECT * FROM oauth_codes WHERE code = ? AND client_id = ?`)
      .get(authorizationCode, client.client_id) as Record<string, string> | undefined;

    if (!row) throw new Error("Invalid authorization code");

    if (new Date(row.expires_at) < new Date()) {
      this.db.prepare(`DELETE FROM oauth_codes WHERE code = ?`).run(authorizationCode);
      throw new Error("Authorization code expired");
    }

    this.db.prepare(`DELETE FROM oauth_codes WHERE code = ?`).run(authorizationCode);

    const accessToken = `rma_${randomUUID().replace(/-/g, "")}`;
    const refreshToken = `rmr_${randomUUID().replace(/-/g, "")}`;
    const now = new Date();
    const accessExpiry = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour
    const refreshExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days
    const scopes = safeJson(row.scopes) as string[];
    const resourceStr = resource?.toString() || row.resource || null;

    this.db
      .prepare(
        `INSERT INTO oauth_tokens (token, token_type, client_id, scopes, resource, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(accessToken, "access", client.client_id, JSON.stringify(scopes), resourceStr, accessExpiry.toISOString(), now.toISOString());

    this.db
      .prepare(
        `INSERT INTO oauth_tokens (token, token_type, client_id, scopes, resource, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(refreshToken, "refresh", client.client_id, JSON.stringify(scopes), resourceStr, refreshExpiry.toISOString(), now.toISOString());

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 3600,
      scope: scopes.join(" "),
      refresh_token: refreshToken,
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.db
      .prepare(`SELECT * FROM oauth_tokens WHERE token = ? AND token_type = 'refresh' AND client_id = ?`)
      .get(refreshToken, client.client_id) as Record<string, string> | undefined;

    if (!row) throw new Error("Invalid refresh token");
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      this.db.prepare(`DELETE FROM oauth_tokens WHERE token = ?`).run(refreshToken);
      throw new Error("Refresh token expired");
    }

    this.db.prepare(`DELETE FROM oauth_tokens WHERE token = ?`).run(refreshToken);

    const newAccess = `rma_${randomUUID().replace(/-/g, "")}`;
    const newRefresh = `rmr_${randomUUID().replace(/-/g, "")}`;
    const now = new Date();
    const accessExpiry = new Date(now.getTime() + 60 * 60 * 1000);
    const refreshExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const tokenScopes = scopes || (safeJson(row.scopes) as string[]);
    const resourceStr = resource?.toString() || row.resource || null;

    this.db
      .prepare(`INSERT INTO oauth_tokens (token, token_type, client_id, scopes, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(newAccess, "access", client.client_id, JSON.stringify(tokenScopes), resourceStr, accessExpiry.toISOString(), now.toISOString());

    this.db
      .prepare(`INSERT INTO oauth_tokens (token, token_type, client_id, scopes, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(newRefresh, "refresh", client.client_id, JSON.stringify(tokenScopes), resourceStr, refreshExpiry.toISOString(), now.toISOString());

    return {
      access_token: newAccess,
      token_type: "bearer",
      expires_in: 3600,
      scope: tokenScopes.join(" "),
      refresh_token: newRefresh,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.db
      .prepare(`SELECT * FROM oauth_tokens WHERE token = ? AND token_type = 'access'`)
      .get(token) as Record<string, string> | undefined;

    if (!row) throw new Error("Invalid access token");
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      this.db.prepare(`DELETE FROM oauth_tokens WHERE token = ?`).run(token);
      throw new Error("Access token expired");
    }

    return {
      token,
      clientId: row.client_id,
      scopes: safeJson(row.scopes) as string[],
      expiresAt: row.expires_at ? Math.floor(new Date(row.expires_at).getTime() / 1000) : undefined,
      resource: row.resource ? new URL(row.resource) : undefined,
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    this.db
      .prepare(`DELETE FROM oauth_tokens WHERE token = ? AND client_id = ?`)
      .run(request.token, client.client_id);
  }
}
