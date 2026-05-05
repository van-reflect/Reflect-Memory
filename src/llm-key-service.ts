/**
 * LLM key service — CRUD for the `llm_keys` table.
 *
 * Wraps the encryption module so callers don't see plaintext unless they
 * explicitly fetch a key for use (`getLlmKeyPlaintext`). All other reads
 * return the non-secret summary (provider, last4, timestamps).
 *
 * Audit events are emitted for create / rotate / remove.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { recordAuditEvent } from "./audit-service.js";
import {
  decryptLlmKey,
  encryptLlmKey,
  type KeyScope,
} from "./llm-key-crypto.js";

export type LlmProvider = "anthropic";

export const SUPPORTED_PROVIDERS: ReadonlyArray<LlmProvider> = ["anthropic"];

export function isSupportedProvider(value: string): value is LlmProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

/** Public, non-secret view of a stored key. Safe to return to clients. */
export interface LlmKeySummary {
  provider: LlmProvider;
  last4: string;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
}

interface LlmKeyRow {
  id: string;
  org_id: string | null;
  user_id: string | null;
  provider: string;
  key_encrypted: Buffer;
  key_nonce: Buffer;
  key_last4: string;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToSummary(row: LlmKeyRow): LlmKeySummary {
  if (!isSupportedProvider(row.provider)) {
    throw new Error(`Unsupported provider in llm_keys row: ${row.provider}`);
  }
  return {
    provider: row.provider,
    last4: row.key_last4,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByUserId: row.created_by_user_id,
  };
}

function whereClauseForScope(scope: KeyScope): { sql: string; params: unknown[] } {
  if (scope.orgId && !scope.userId) {
    return { sql: "org_id = ? AND user_id IS NULL", params: [scope.orgId] };
  }
  if (scope.userId && !scope.orgId) {
    return { sql: "user_id = ? AND org_id IS NULL", params: [scope.userId] };
  }
  throw new Error("KeyScope must have exactly one of orgId or userId");
}

/**
 * Returns all keys for the given scope (non-secret summaries).
 */
export function listLlmKeys(db: Database.Database, scope: KeyScope): LlmKeySummary[] {
  const where = whereClauseForScope(scope);
  const rows = db
    .prepare(
      `SELECT * FROM llm_keys WHERE ${where.sql} ORDER BY provider ASC`,
    )
    .all(...where.params) as LlmKeyRow[];
  return rows.map(rowToSummary);
}

/**
 * Returns the single key for (scope, provider), or null if not set.
 * Non-secret summary only.
 */
export function getLlmKeySummary(
  db: Database.Database,
  scope: KeyScope,
  provider: LlmProvider,
): LlmKeySummary | null {
  const where = whereClauseForScope(scope);
  const row = db
    .prepare(`SELECT * FROM llm_keys WHERE ${where.sql} AND provider = ?`)
    .get(...where.params, provider) as LlmKeyRow | undefined;
  return row ? rowToSummary(row) : null;
}

/**
 * Returns the decrypted key plaintext for (scope, provider), or null if not set.
 * Use only when actually about to call the LLM provider — never log the result,
 * never return it to clients.
 */
export function getLlmKeyPlaintext(
  db: Database.Database,
  scope: KeyScope,
  provider: LlmProvider,
): string | null {
  const where = whereClauseForScope(scope);
  const row = db
    .prepare(`SELECT * FROM llm_keys WHERE ${where.sql} AND provider = ?`)
    .get(...where.params, provider) as LlmKeyRow | undefined;
  if (!row) return null;
  return decryptLlmKey(
    { ciphertext: row.key_encrypted, nonce: row.key_nonce },
    scope,
  );
}

export interface SetLlmKeyOptions {
  scope: KeyScope;
  provider: LlmProvider;
  plaintext: string;
  /** Authenticated user setting the key (admin). */
  createdByUserId: string;
  /** For audit events; passed straight through. */
  requestId?: string | null;
}

/**
 * Upserts a key for (scope, provider). If a row exists, it's replaced
 * (rotate); if not, it's created. Emits the appropriate audit event.
 *
 * Returns the new summary.
 */
export function setLlmKey(
  db: Database.Database,
  options: SetLlmKeyOptions,
): LlmKeySummary {
  const trimmed = options.plaintext.trim();
  if (trimmed.length === 0) {
    throw new Error("Cannot set empty LLM key");
  }

  const encrypted = encryptLlmKey(trimmed, options.scope);
  const now = new Date().toISOString();
  const where = whereClauseForScope(options.scope);

  const existing = db
    .prepare(`SELECT id FROM llm_keys WHERE ${where.sql} AND provider = ?`)
    .get(...where.params, options.provider) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE llm_keys
       SET key_encrypted = ?, key_nonce = ?, key_last4 = ?,
           created_by_user_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.last4,
      options.createdByUserId,
      now,
      existing.id,
    );
    recordAuditEvent(db, {
      userId: options.createdByUserId,
      eventType: "llm_key.rotated",
      requestId: options.requestId ?? null,
      metadata: {
        provider: options.provider,
        scope_org_id: options.scope.orgId ?? null,
        scope_user_id: options.scope.userId ?? null,
        last4: encrypted.last4,
      },
    });
  } else {
    db.prepare(
      `INSERT INTO llm_keys (
        id, org_id, user_id, provider, key_encrypted, key_nonce, key_last4,
        created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      options.scope.orgId ?? null,
      options.scope.userId ?? null,
      options.provider,
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.last4,
      options.createdByUserId,
      now,
      now,
    );
    recordAuditEvent(db, {
      userId: options.createdByUserId,
      eventType: "llm_key.created",
      requestId: options.requestId ?? null,
      metadata: {
        provider: options.provider,
        scope_org_id: options.scope.orgId ?? null,
        scope_user_id: options.scope.userId ?? null,
        last4: encrypted.last4,
      },
    });
  }

  const summary = getLlmKeySummary(db, options.scope, options.provider);
  if (!summary) {
    throw new Error("setLlmKey post-condition: key not found after upsert");
  }
  return summary;
}

export interface DeleteLlmKeyOptions {
  scope: KeyScope;
  provider: LlmProvider;
  actorUserId: string;
  requestId?: string | null;
}

/**
 * Deletes the key for (scope, provider). Returns true if a row was deleted,
 * false if no key was set. Emits a `llm_key.removed` audit event when a row
 * is actually deleted.
 */
export function deleteLlmKey(
  db: Database.Database,
  options: DeleteLlmKeyOptions,
): boolean {
  const where = whereClauseForScope(options.scope);
  const existing = db
    .prepare(`SELECT id, key_last4 FROM llm_keys WHERE ${where.sql} AND provider = ?`)
    .get(...where.params, options.provider) as
    | { id: string; key_last4: string }
    | undefined;
  if (!existing) return false;

  db.prepare(`DELETE FROM llm_keys WHERE id = ?`).run(existing.id);
  recordAuditEvent(db, {
    userId: options.actorUserId,
    eventType: "llm_key.removed",
    requestId: options.requestId ?? null,
    metadata: {
      provider: options.provider,
      scope_org_id: options.scope.orgId ?? null,
      scope_user_id: options.scope.userId ?? null,
      last4: existing.key_last4,
    },
  });
  return true;
}
