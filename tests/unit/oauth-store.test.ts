// Unit tests: src/oauth-store.ts
//
// Drives ReflectOAuthProvider against an in-memory SQLite. Targets the
// specific failure mode that broke Cursor on darwin/arm64 on 2026-05-13:
// the bearer-auth middleware returned 500 for invalid/expired tokens
// instead of 401, which prevents OAuth clients from auto-refreshing
// and locks them out until they manually re-authorize.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { ReflectOAuthProvider, createOAuthTables } from "../../src/oauth-store.js";
import { makeTestDb, seedUser, type TestDb } from "./db.js";

let h: TestDb;
let userId: string;
let provider: ReflectOAuthProvider;

beforeEach(() => {
  h = makeTestDb();
  createOAuthTables(h.db);
  userId = seedUser(h.db).id;
  provider = new ReflectOAuthProvider({
    db: h.db,
    issuerUrl: "https://api.reflectmemory.test",
    dashboardUrl: "https://reflectmemory.test",
  });
});

afterEach(() => {
  h.close();
});

describe("ReflectOAuthProvider.verifyAccessToken — error shape", () => {
  // The SDK's requireBearerAuth middleware returns 401 when the verifier
  // throws InvalidTokenError, but 500 for any other Error. Cursor /
  // Claude / ChatGPT all rely on the 401 to trigger their token
  // refresh flow. Returning 500 looks like a server outage and clients
  // give up instead of refreshing.

  it("throws InvalidTokenError for an unknown token (was: plain Error → 500)", async () => {
    await expect(provider.verifyAccessToken("does-not-exist")).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it("throws InvalidTokenError for an expired token (was: plain Error → 500)", async () => {
    const now = new Date();
    const expired = new Date(now.getTime() - 60_000).toISOString();
    h.db.prepare(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at)
       VALUES ('test-client', 'Test Client', '[]', ?)`,
    ).run(now.toISOString());
    h.db.prepare(
      `INSERT INTO oauth_tokens (token, token_type, client_id, user_id, scopes, expires_at, created_at)
       VALUES ('expired-token', 'access', 'test-client', ?, '["mcp:read","mcp:write"]', ?, ?)`,
    ).run(userId, expired, now.toISOString());

    await expect(provider.verifyAccessToken("expired-token")).rejects.toBeInstanceOf(
      InvalidTokenError,
    );

    // Side effect: the expired row gets deleted on lookup so subsequent
    // calls don't repeat the work.
    const remaining = h.db
      .prepare(`SELECT 1 FROM oauth_tokens WHERE token = ?`)
      .get("expired-token");
    expect(remaining).toBeUndefined();
  });

  it("returns AuthInfo for a valid, unexpired token", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 3_600_000).toISOString();
    h.db.prepare(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at)
       VALUES ('test-client', 'Test Client', '[]', ?)`,
    ).run(now.toISOString());
    h.db.prepare(
      `INSERT INTO oauth_tokens (token, token_type, client_id, user_id, scopes, expires_at, created_at)
       VALUES ('valid-token', 'access', 'test-client', ?, '["mcp:read","mcp:write"]', ?, ?)`,
    ).run(userId, future, now.toISOString());

    const info = await provider.verifyAccessToken("valid-token");
    expect(info.token).toBe("valid-token");
    expect(info.clientId).toBe("test-client");
    expect(info.scopes).toEqual(["mcp:read", "mcp:write"]);
    expect(info.extra?.userId).toBe(userId);
  });
});
