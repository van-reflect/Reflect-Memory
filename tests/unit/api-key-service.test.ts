// Unit tests: src/api-key-service.ts
//
// Drives the service directly against an in-memory SQLite. Targets behaviour
// that's annoying to verify through HTTP: key prefix shape, hash isolation,
// authenticate-vs-not-found symmetry, revoked keys can't authenticate.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  authenticateApiKey,
  countActiveApiKeys,
  generateApiKey,
  listApiKeys,
  revokeApiKey,
} from "../../src/api-key-service.js";
import { makeTestDb, seedUser, type TestDb } from "./db.js";

let h: TestDb;
let userId: string;

beforeEach(() => {
  h = makeTestDb();
  userId = seedUser(h.db).id;
});

afterEach(() => {
  h.close();
});

describe("generateApiKey", () => {
  it("returns a key with the rm_live_ prefix and 48 hex chars of entropy", () => {
    const { key, record } = generateApiKey(h.db, userId);
    expect(key).toMatch(/^rm_live_[0-9a-f]{48}$/);
    expect(record.user_id).toBe(userId);
    expect(record.label).toBe("Default");
    expect(record.revoked_at).toBeNull();
    expect(record.last_used_at).toBeNull();
  });

  it("display prefix is rm_live_ + first 8 hex chars of the random part", () => {
    const { key, record } = generateApiKey(h.db, userId);
    const randomPart = key.slice("rm_live_".length);
    expect(record.key_prefix).toBe(`rm_live_${randomPart.slice(0, 8)}`);
  });

  it("uses the provided label", () => {
    const { record } = generateApiKey(h.db, userId, "production");
    expect(record.label).toBe("production");
  });

  it("two consecutive calls produce distinct keys + hashes (no entropy reuse)", () => {
    const a = generateApiKey(h.db, userId);
    const b = generateApiKey(h.db, userId);
    expect(a.key).not.toBe(b.key);
    expect(a.record.id).not.toBe(b.record.id);
  });

  it("stores only the SHA-256 hash, never the raw key", () => {
    const { key } = generateApiKey(h.db, userId);
    const expectedHash = createHash("sha256").update(key).digest("hex");

    const row = h.db
      .prepare(`SELECT key_hash FROM api_keys WHERE user_id = ?`)
      .get(userId) as { key_hash: string };
    expect(row.key_hash).toBe(expectedHash);

    // Make sure the raw key is NOT stored anywhere as a substring.
    const allRows = h.db.prepare(`SELECT * FROM api_keys`).all();
    const dump = JSON.stringify(allRows);
    expect(dump).not.toContain(key);
  });
});

describe("authenticateApiKey", () => {
  it("returns userId+keyId for a valid key", () => {
    const { key, record } = generateApiKey(h.db, userId);
    const auth = authenticateApiKey(h.db, key);
    expect(auth).toEqual({ userId, keyId: record.id });
  });

  it("returns null for a key that doesn't start with rm_live_", () => {
    expect(authenticateApiKey(h.db, "sk_test_abcdef")).toBeNull();
    expect(authenticateApiKey(h.db, "")).toBeNull();
  });

  it("returns null for a well-formatted key that doesn't exist", () => {
    expect(
      authenticateApiKey(h.db, "rm_live_" + "f".repeat(48)),
    ).toBeNull();
  });

  it("returns null after revocation", () => {
    const { key, record } = generateApiKey(h.db, userId);
    revokeApiKey(h.db, record.id, userId);
    expect(authenticateApiKey(h.db, key)).toBeNull();
  });

  it("updates last_used_at on success", () => {
    const { key, record } = generateApiKey(h.db, userId);
    expect(record.last_used_at).toBeNull();

    authenticateApiKey(h.db, key);
    const row = h.db
      .prepare(`SELECT last_used_at FROM api_keys WHERE id = ?`)
      .get(record.id) as { last_used_at: string | null };
    expect(row.last_used_at).not.toBeNull();
    expect(new Date(row.last_used_at!).getTime()).toBeGreaterThan(0);
  });

  it("does NOT bump last_used_at on a wrong key", () => {
    const { record } = generateApiKey(h.db, userId);
    authenticateApiKey(h.db, "rm_live_" + "f".repeat(48));
    const row = h.db
      .prepare(`SELECT last_used_at FROM api_keys WHERE id = ?`)
      .get(record.id) as { last_used_at: string | null };
    expect(row.last_used_at).toBeNull();
  });
});

describe("countActiveApiKeys", () => {
  it("counts only non-revoked keys", () => {
    const a = generateApiKey(h.db, userId);
    generateApiKey(h.db, userId);
    expect(countActiveApiKeys(h.db, userId)).toBe(2);
    revokeApiKey(h.db, a.record.id, userId);
    expect(countActiveApiKeys(h.db, userId)).toBe(1);
  });

  it("scopes by user (one user's revocation doesn't affect another's count)", () => {
    const otherUserId = seedUser(h.db).id;
    generateApiKey(h.db, userId);
    generateApiKey(h.db, otherUserId);
    expect(countActiveApiKeys(h.db, userId)).toBe(1);
    expect(countActiveApiKeys(h.db, otherUserId)).toBe(1);
  });
});

describe("revokeApiKey", () => {
  it("returns true on first call, false on idempotent re-revoke", () => {
    const { record } = generateApiKey(h.db, userId);
    expect(revokeApiKey(h.db, record.id, userId)).toBe(true);
    expect(revokeApiKey(h.db, record.id, userId)).toBe(false);
  });

  it("won't revoke another user's key", () => {
    const { record } = generateApiKey(h.db, userId);
    const intruderId = seedUser(h.db).id;
    expect(revokeApiKey(h.db, record.id, intruderId)).toBe(false);
    expect(countActiveApiKeys(h.db, userId)).toBe(1);
  });

  it("returns false for nonexistent id", () => {
    expect(
      revokeApiKey(h.db, "00000000-0000-0000-0000-000000000000", userId),
    ).toBe(false);
  });
});

describe("listApiKeys", () => {
  it("returns all keys (active + revoked), most recent first, without key_hash", async () => {
    const a = generateApiKey(h.db, userId);
    // Tiny pause guarantees distinct created_at -- otherwise ORDER BY is ambiguous
    // and the test depends on insertion order, which SQLite doesn't promise.
    await new Promise((r) => setTimeout(r, 5));
    const b = generateApiKey(h.db, userId);
    revokeApiKey(h.db, a.record.id, userId);

    const list = listApiKeys(h.db, userId);
    expect(list).toHaveLength(2);
    expect(list[0]!.id).toBe(b.record.id);
    expect(list[1]!.id).toBe(a.record.id);
    expect(list[1]!.revoked_at).not.toBeNull();
    // The hash must never leak through the public API surface.
    for (const row of list) {
      expect((row as Record<string, unknown>).key_hash).toBeUndefined();
    }
  });

  it("scopes results by user", () => {
    generateApiKey(h.db, userId);
    const otherId = seedUser(h.db).id;
    generateApiKey(h.db, otherId);
    expect(listApiKeys(h.db, userId)).toHaveLength(1);
    expect(listApiKeys(h.db, otherId)).toHaveLength(1);
  });
});
