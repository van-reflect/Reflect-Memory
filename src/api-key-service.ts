// Reflect Memory — API Key Service
// Per-user API key generation, validation, and management.
// Keys are prefixed with "rm_live_" followed by 48 random hex chars.
// Only the SHA-256 hash is stored; the raw key is returned once at creation.

import type Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const KEY_PREFIX = "rm_live_";
const KEY_RANDOM_BYTES = 24; // 48 hex chars
const DISPLAY_PREFIX_CHARS = 8;

export interface ApiKeyRecord {
  id: string;
  user_id: string;
  key_prefix: string;
  label: string;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface ApiKeyAuth {
  userId: string;
  keyId: string;
}

export function generateApiKey(
  db: Database.Database,
  userId: string,
  label: string = "Default",
): { key: string; record: ApiKeyRecord } {
  const randomPart = randomBytes(KEY_RANDOM_BYTES).toString("hex");
  const fullKey = `${KEY_PREFIX}${randomPart}`;
  const keyHash = createHash("sha256").update(fullKey).digest("hex");
  const keyPrefix = `${KEY_PREFIX}${randomPart.slice(0, DISPLAY_PREFIX_CHARS)}`;

  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, keyHash, keyPrefix, label, now);

  return {
    key: fullKey,
    record: {
      id,
      user_id: userId,
      key_prefix: keyPrefix,
      label,
      last_used_at: null,
      created_at: now,
      revoked_at: null,
    },
  };
}

export function listApiKeys(
  db: Database.Database,
  userId: string,
): ApiKeyRecord[] {
  return db
    .prepare(
      `SELECT id, user_id, key_prefix, label, last_used_at, created_at, revoked_at
       FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(userId) as ApiKeyRecord[];
}

export function revokeApiKey(
  db: Database.Database,
  keyId: string,
  userId: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    )
    .run(new Date().toISOString(), keyId, userId);
  return result.changes > 0;
}

export function authenticateApiKey(
  db: Database.Database,
  rawKey: string,
): ApiKeyAuth | null {
  if (!rawKey.startsWith(KEY_PREFIX)) return null;

  const keyHash = createHash("sha256").update(rawKey).digest("hex");

  const row = db
    .prepare(
      `SELECT id, user_id, key_hash FROM api_keys
       WHERE revoked_at IS NULL`,
    )
    .all() as Array<{ id: string; user_id: string; key_hash: string }>;

  for (const r of row) {
    const storedHash = Buffer.from(r.key_hash, "hex");
    const inputHash = Buffer.from(keyHash, "hex");
    if (storedHash.length === inputHash.length && timingSafeEqual(storedHash, inputHash)) {
      db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).run(
        new Date().toISOString(),
        r.id,
      );
      return { userId: r.user_id, keyId: r.id };
    }
  }

  return null;
}
