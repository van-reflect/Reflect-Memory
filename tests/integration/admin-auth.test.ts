// Admin auth integration tests. Complements agent-restrictions.test.ts which
// proves AGENT keys cannot reach /admin/*. This file proves:
//   1. The primary owner's key DOES reach /admin/* (positive path — previously untested).
//   2. A valid USER-role key that is NOT an admin gets 403 (auth check is ownership-based,
//      not just role-differentiated).
//
// See src/server.ts admin route guards which use `!ownerUserIds.has(request.userId)`.
// Multi-admin (RM_OWNER_EMAILS) is not exercised here because the test server is started
// with only RM_OWNER_EMAIL set; the set-membership logic is identical in both cases and
// was verified end-to-end on dev + prod when fb8d4f19 shipped.

import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, getTestServer } from "../helpers";

// All /admin/* GET routes that share the same owner-only guard. Kept as a table
// so adding a new admin endpoint and forgetting to cover it is caught here.
const ADMIN_GET_ROUTES = [
  "/admin/check",
  "/admin/users",
  "/admin/metrics",
  "/admin/audit",
  "/admin/waitlist",
  "/admin/early-access",
  "/admin/integration-requests",
] as const;

describe("admin auth — primary owner (positive path)", () => {
  it.each(ADMIN_GET_ROUTES)("GET %s with owner key -> 200", async (path) => {
    const r = await api("GET", path);
    expect(r.status, `unexpected body: ${r.text}`).toBe(200);
  });

  it("GET /admin/check returns {owner: true}", async () => {
    const r = await api<{ owner: boolean }>("GET", "/admin/check");
    expect(r.status).toBe(200);
    expect(r.json.owner).toBe(true);
  });
});

describe("admin auth — non-owner user (negative path)", () => {
  // Second user provisioned directly in the DB (the HTTP API does not expose a
  // "create arbitrary user" route, and adding one just for tests would be worse).
  let secondaryUserId: string;
  let secondaryKey: string;
  let secondaryKeyId: string;

  beforeAll(() => {
    const { dbPath } = getTestServer();
    const db = new Database(dbPath);
    try {
      secondaryUserId = randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO users (id, email, role, plan, created_at, updated_at) VALUES (?, ?, 'user', 'free', ?, ?)",
      ).run(secondaryUserId, `non-owner-${secondaryUserId.slice(0, 8)}@test.local`, now, now);

      const keyRandom = randomBytes(24).toString("hex");
      secondaryKey = `rm_live_${keyRandom}`;
      const keyHash = createHash("sha256").update(secondaryKey).digest("hex");
      const keyPrefix = `rm_live_${keyRandom.slice(0, 8)}`;
      secondaryKeyId = randomUUID();
      db.prepare(
        `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(secondaryKeyId, secondaryUserId, keyHash, keyPrefix, "non-owner-probe", now);
    } finally {
      db.close();
    }
  });

  afterAll(() => {
    const { dbPath } = getTestServer();
    const db = new Database(dbPath);
    try {
      db.prepare("DELETE FROM api_keys WHERE id = ?").run(secondaryKeyId);
      db.prepare("DELETE FROM users WHERE id = ?").run(secondaryUserId);
    } finally {
      db.close();
    }
  });

  it("non-owner key authenticates as role=user (sanity check)", async () => {
    const r = await api<{ role: string; vendor: string | null }>("GET", "/whoami", {
      token: secondaryKey,
    });
    expect(r.status).toBe(200);
    expect(r.json.role).toBe("user");
    expect(r.json.vendor).toBeNull();
  });

  it.each(ADMIN_GET_ROUTES)("GET %s with non-owner user key -> 403", async (path) => {
    const r = await api<{ error?: string }>("GET", path, { token: secondaryKey });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("Admin access required");
  });
});
