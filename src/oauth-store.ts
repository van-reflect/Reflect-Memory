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

let _hasUserIdCols = false;

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

    CREATE TABLE IF NOT EXISTS oauth_pending_requests (
      id            TEXT NOT NULL PRIMARY KEY,
      client_id     TEXT NOT NULL,
      client_name   TEXT,
      redirect_uri  TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      scopes        TEXT NOT NULL DEFAULT '[]',
      state         TEXT,
      resource      TEXT,
      expires_at    TEXT NOT NULL,
      created_at    TEXT NOT NULL
    ) STRICT;
  `);
}

/**
 * Add user_id columns to OAuth tables and create agent_keys table.
 * Safe to call multiple times -- each operation is idempotent.
 * Called from migration 018 in index.ts AND from ReflectOAuthProvider constructor.
 */
export function ensureOAuthUserColumns(db: Database.Database): void {
  const tables = ["oauth_codes", "oauth_tokens", "oauth_pending_requests"];
  for (const table of tables) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === "user_id")) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT`);
        console.log(`[oauth] Added user_id column to ${table}`);
      }
    } catch (err) {
      console.error(`[oauth] Failed to add user_id to ${table}: ${(err as Error).message}`);
    }
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_keys (
        id         TEXT NOT NULL PRIMARY KEY,
        user_id    TEXT NOT NULL,
        vendor     TEXT NOT NULL,
        key_hash   TEXT NOT NULL,
        label      TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_agent_keys_hash ON agent_keys(key_hash);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_keys_user_vendor ON agent_keys(user_id, vendor);
    `);
  } catch (err) {
    console.warn(`[oauth] agent_keys table setup: ${(err as Error).message}`);
  }

  // Set the flag based on actual column existence
  try {
    const cols = db.prepare(`PRAGMA table_info(oauth_codes)`).all() as { name: string }[];
    _hasUserIdCols = cols.some((c) => c.name === "user_id");
  } catch {
    _hasUserIdCols = false;
  }
  console.log(`[oauth] user_id columns available: ${_hasUserIdCols}`);
}

export function hasUserIdColumns(): boolean {
  return _hasUserIdCols;
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
// Agent keys: per-user bearer tokens for non-OAuth vendors (ChatGPT, Cursor)
// ---------------------------------------------------------------------------

export interface AgentKeyRow {
  id: string;
  user_id: string;
  vendor: string;
  key_hash: string;
  label: string | null;
  created_at: string;
}

export function createAgentKey(
  db: Database.Database,
  userId: string,
  vendor: string,
  label?: string,
): { key: string; row: AgentKeyRow } {
  const raw = `rmk_${randomUUID().replace(/-/g, "")}`;
  const id = randomUUID();
  const now = new Date().toISOString();
  const keyHash = hashSecret(raw);

  db.prepare(
    `INSERT OR REPLACE INTO agent_keys (id, user_id, vendor, key_hash, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, vendor, keyHash, label || null, now);

  return { key: raw, row: { id, user_id: userId, vendor, key_hash: keyHash, label: label || null, created_at: now } };
}

export function resolveAgentKeyUser(
  db: Database.Database,
  bearerToken: string,
): { userId: string; vendor: string } | null {
  const tokenHash = hashSecret(bearerToken);
  const row = db
    .prepare(`SELECT user_id, vendor FROM agent_keys WHERE key_hash = ?`)
    .get(tokenHash) as { user_id: string; vendor: string } | undefined;
  if (!row) return null;
  return { userId: row.user_id, vendor: row.vendor };
}

export function listAgentKeys(
  db: Database.Database,
  userId: string,
): Omit<AgentKeyRow, "key_hash">[] {
  return db
    .prepare(`SELECT id, user_id, vendor, label, created_at FROM agent_keys WHERE user_id = ?`)
    .all(userId) as Omit<AgentKeyRow, "key_hash">[];
}

export function deleteAgentKey(db: Database.Database, keyId: string, userId: string): boolean {
  const result = db
    .prepare(`DELETE FROM agent_keys WHERE id = ? AND user_id = ?`)
    .run(keyId, userId);
  return result.changes > 0;
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
  dashboardUrl?: string;
}

export class ReflectOAuthProvider implements OAuthServerProvider {
  private db: Database.Database;
  private _clientsStore: SqliteClientsStore;
  public issuerUrl: string;
  public dashboardUrl: string;

  constructor(config: OAuthStoreConfig) {
    this.db = config.db;
    this._clientsStore = new SqliteClientsStore(config.db);
    this.issuerUrl = config.issuerUrl;
    this.dashboardUrl = config.dashboardUrl || "https://reflectmemory.com";
    // Ensure user_id columns exist every time the provider starts
    ensureOAuthUserColumns(config.db);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const pendingId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);

    this.db
      .prepare(
        `INSERT INTO oauth_pending_requests (id, client_id, client_name, redirect_uri, code_challenge, scopes, state, resource, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pendingId,
        client.client_id,
        client.client_name || null,
        params.redirectUri,
        params.codeChallenge,
        JSON.stringify(params.scopes || []),
        params.state || null,
        params.resource?.toString() || null,
        expiresAt.toISOString(),
        now.toISOString(),
      );

    console.log(`[oauth] Created pending request ${pendingId.slice(0, 8)}... for client=${client.client_id}`);

    const consentUrl = new URL(`${this.dashboardUrl}/oauth/consent`);
    consentUrl.searchParams.set("pending_id", pendingId);
    consentUrl.searchParams.set("client_name", client.client_name || "Unknown application");

    res.redirect(302, consentUrl.toString());
  }

  approvePendingRequest(pendingId: string, userId?: string): string {
    const row = this.db
      .prepare(`SELECT * FROM oauth_pending_requests WHERE id = ?`)
      .get(pendingId) as Record<string, string> | undefined;

    if (!row) throw new Error("Pending request not found");
    if (new Date(row.expires_at) < new Date()) {
      this.db.prepare(`DELETE FROM oauth_pending_requests WHERE id = ?`).run(pendingId);
      throw new Error("Pending request expired");
    }

    const resolvedUserId = userId || row.user_id || null;

    this.db.prepare(`DELETE FROM oauth_pending_requests WHERE id = ?`).run(pendingId);

    const code = randomUUID().replace(/-/g, "");
    const now = new Date();
    const codeExpiry = new Date(now.getTime() + 5 * 60 * 1000);

    if (_hasUserIdCols) {
      this.db
        .prepare(
          `INSERT INTO oauth_codes (code, client_id, user_id, challenge, redirect_uri, scopes, resource, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(code, row.client_id, resolvedUserId, row.code_challenge, row.redirect_uri, row.scopes, row.resource || null, codeExpiry.toISOString(), now.toISOString());
    } else {
      this.db
        .prepare(
          `INSERT INTO oauth_codes (code, client_id, challenge, redirect_uri, scopes, resource, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(code, row.client_id, row.code_challenge, row.redirect_uri, row.scopes, row.resource || null, codeExpiry.toISOString(), now.toISOString());
    }

    const redirectUrl = new URL(row.redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (row.state) {
      redirectUrl.searchParams.set("state", row.state);
    }

    return redirectUrl.toString();
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
    const accessExpiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const refreshExpiry = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    const scopes = safeJson(row.scopes) as string[];
    const resourceStr = resource?.toString() || row.resource || null;
    const tokenUserId = row.user_id || null;

    if (_hasUserIdCols) {
      this.db.prepare(
        `INSERT INTO oauth_tokens (token, token_type, client_id, user_id, scopes, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(accessToken, "access", client.client_id, tokenUserId, JSON.stringify(scopes), resourceStr, accessExpiry.toISOString(), now.toISOString());
      this.db.prepare(
        `INSERT INTO oauth_tokens (token, token_type, client_id, user_id, scopes, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(refreshToken, "refresh", client.client_id, tokenUserId, JSON.stringify(scopes), resourceStr, refreshExpiry.toISOString(), now.toISOString());
    } else {
      this.db.prepare(
        `INSERT INTO oauth_tokens (token, token_type, client_id, scopes, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(accessToken, "access", client.client_id, JSON.stringify(scopes), resourceStr, accessExpiry.toISOString(), now.toISOString());
      this.db.prepare(
        `INSERT INTO oauth_tokens (token, token_type, client_id, scopes, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(refreshToken, "refresh", client.client_id, JSON.stringify(scopes), resourceStr, refreshExpiry.toISOString(), now.toISOString());
    }

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 604800,
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
    const accessExpiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const refreshExpiry = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    const tokenScopes = scopes || (safeJson(row.scopes) as string[]);
    const resourceStr = resource?.toString() || row.resource || null;
    const tokenUserId = row.user_id || null;

    if (_hasUserIdCols) {
      this.db.prepare(
        `INSERT INTO oauth_tokens (token, token_type, client_id, user_id, scopes, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(newAccess, "access", client.client_id, tokenUserId, JSON.stringify(tokenScopes), resourceStr, accessExpiry.toISOString(), now.toISOString());
      this.db.prepare(
        `INSERT INTO oauth_tokens (token, token_type, client_id, user_id, scopes, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(newRefresh, "refresh", client.client_id, tokenUserId, JSON.stringify(tokenScopes), resourceStr, refreshExpiry.toISOString(), now.toISOString());
    } else {
      this.db.prepare(
        `INSERT INTO oauth_tokens (token, token_type, client_id, scopes, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(newAccess, "access", client.client_id, JSON.stringify(tokenScopes), resourceStr, accessExpiry.toISOString(), now.toISOString());
      this.db.prepare(
        `INSERT INTO oauth_tokens (token, token_type, client_id, scopes, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(newRefresh, "refresh", client.client_id, JSON.stringify(tokenScopes), resourceStr, refreshExpiry.toISOString(), now.toISOString());
    }

    return {
      access_token: newAccess,
      token_type: "bearer",
      expires_in: 604800,
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
      extra: { userId: (_hasUserIdCols ? row.user_id : null) || null },
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
