// Reflective Memory — Memory Service
// Pure data access layer. No HTTP, no AI, no logging, no side effects beyond SQL.
// Every function requires an explicit user_id. No function infers ownership.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

// =============================================================================
// Types
// =============================================================================

/** A memory entry as returned to callers. Tags are a parsed string array. */
export interface MemoryEntry {
  id: string;
  user_id: string;
  title: string;
  content: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

/** Required fields for creating a memory. No optional fields, no defaults. */
export interface CreateMemoryInput {
  title: string;
  content: string;
  tags: string[];
}

/**
 * Required fields for updating a memory. Full replacement, not a partial patch.
 * The caller sends the complete intended state.
 */
export interface UpdateMemoryInput {
  title: string;
  content: string;
  tags: string[];
}

/**
 * Discriminated union for list filtering. The caller must declare intent:
 * - 'all':  return every memory for this user
 * - 'tags': return memories matching at least one of the given tags
 * - 'ids':  return memories matching the given primary keys
 *
 * There is no default. The filter is required.
 */
export type MemoryFilter =
  | { by: "all" }
  | { by: "tags"; tags: string[] }
  | { by: "ids"; ids: string[] };

// =============================================================================
// Internal: row mapping
// =============================================================================

/** Raw row shape from SQLite. Tags are a JSON string in the database. */
interface MemoryRow {
  id: string;
  user_id: string;
  title: string;
  content: string;
  tags: string; // JSON array string, e.g. '["work","project-x"]'
  created_at: string;
  updated_at: string;
}

/** Convert a raw database row to a MemoryEntry. Parses tags from JSON. */
function rowToMemory(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    content: row.content,
    tags: JSON.parse(row.tags) as string[],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// =============================================================================
// createMemory
// =============================================================================
// Inserts a new memory entry owned by the given user.
//
// Guarantees:
// - Generates a new UUIDv4 for the entry. Never accepts a caller-provided ID.
// - Sets created_at and updated_at to the same ISO 8601 timestamp.
// - Tags are serialized as a JSON array. The CHECK constraint in the schema
//   will reject anything that isn't a valid JSON array.
// - Returns the complete entry as written. If the INSERT throws (e.g. invalid
//   user_id due to FK constraint), the error propagates — no silent failure.
// =============================================================================

export function createMemory(
  db: Database.Database,
  userId: string,
  input: CreateMemoryInput,
): MemoryEntry {
  const id = randomUUID();
  const now = new Date().toISOString();
  const tagsJson = JSON.stringify(input.tags);

  db.prepare(
    `INSERT INTO memories (id, user_id, title, content, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, input.title, input.content, tagsJson, now, now);

  return {
    id,
    user_id: userId,
    title: input.title,
    content: input.content,
    tags: [...input.tags],
    created_at: now,
    updated_at: now,
  };
}

// =============================================================================
// readMemoryById
// =============================================================================
// Fetches a single memory by primary key, scoped to the given user.
//
// Guarantees:
// - Always filters by both id AND user_id. A user cannot read another user's
//   memory even if they know the ID.
// - Returns null if not found. Does not throw on missing entries.
// - No side effects: does not update "last accessed" or any other field.
// =============================================================================

export function readMemoryById(
  db: Database.Database,
  userId: string,
  memoryId: string,
): MemoryEntry | null {
  const row = db
    .prepare(
      `SELECT id, user_id, title, content, tags, created_at, updated_at
       FROM memories
       WHERE id = ? AND user_id = ?`,
    )
    .get(memoryId, userId) as MemoryRow | undefined;

  if (!row) return null;
  return rowToMemory(row);
}

// =============================================================================
// listMemories
// =============================================================================
// Fetches multiple memories for a user based on an explicit filter.
//
// Guarantees:
// - The filter is a required discriminated union — the caller must state intent.
// - 'all': returns every memory for this user, ordered by created_at DESC.
// - 'tags': returns memories where at least one tag matches, using json_each().
//           Empty tags array returns []. No "match everything" fallback.
// - 'ids': returns memories matching the given IDs, scoped to user_id.
//          Empty IDs array returns []. No "match everything" fallback.
// - All queries are scoped by user_id. No cross-user leakage.
// - Results are ordered by created_at DESC (newest first).
// =============================================================================

export function listMemories(
  db: Database.Database,
  userId: string,
  filter: MemoryFilter,
): MemoryEntry[] {
  switch (filter.by) {
    case "all": {
      const rows = db
        .prepare(
          `SELECT id, user_id, title, content, tags, created_at, updated_at
           FROM memories
           WHERE user_id = ?
           ORDER BY created_at DESC`,
        )
        .all(userId) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    case "tags": {
      if (filter.tags.length === 0) return [];
      const placeholders = filter.tags.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT DISTINCT m.id, m.user_id, m.title, m.content, m.tags,
                  m.created_at, m.updated_at
           FROM memories m, json_each(m.tags) t
           WHERE m.user_id = ? AND t.value IN (${placeholders})
           ORDER BY m.created_at DESC`,
        )
        .all(userId, ...filter.tags) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    case "ids": {
      if (filter.ids.length === 0) return [];
      const placeholders = filter.ids.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT id, user_id, title, content, tags, created_at, updated_at
           FROM memories
           WHERE user_id = ? AND id IN (${placeholders})
           ORDER BY created_at DESC`,
        )
        .all(userId, ...filter.ids) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    default: {
      // Exhaustive check: if a new filter variant is added but not handled,
      // this line will produce a compile-time error via the `never` type.
      const _exhaustive: never = filter;
      throw new Error(`Unhandled filter type: ${(_exhaustive as { by: string }).by}`);
    }
  }
}

// =============================================================================
// updateMemory
// =============================================================================
// Replaces an existing memory entry with new data. Full replacement, not merge.
//
// Guarantees:
// - Updates title, content, tags, and updated_at. Nothing else.
// - created_at is never modified.
// - Scoped by both id AND user_id. Cannot update another user's memory.
// - Returns the complete updated entry, or null if the entry does not exist
//   (or does not belong to this user).
// - If the entry doesn't exist, no row is touched. result.changes === 0.
// =============================================================================

export function updateMemory(
  db: Database.Database,
  userId: string,
  memoryId: string,
  input: UpdateMemoryInput,
): MemoryEntry | null {
  const now = new Date().toISOString();
  const tagsJson = JSON.stringify(input.tags);

  const result = db
    .prepare(
      `UPDATE memories
       SET title = ?, content = ?, tags = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(input.title, input.content, tagsJson, now, memoryId, userId);

  if (result.changes === 0) return null;

  // Re-read to return the full entry including the original created_at.
  // This is safe: better-sqlite3 is synchronous, same connection, no race.
  return readMemoryById(db, userId, memoryId);
}

// =============================================================================
// deleteMemory
// =============================================================================
// Hard-deletes a memory entry by primary key.
//
// Guarantees:
// - Deletes by id AND user_id. Both are required.
// - Executes: DELETE FROM memories WHERE id = ? AND user_id = ?
// - One row, one table. No cascades (no inbound FKs exist in the schema).
// - Returns true if a row was deleted, false if it didn't exist.
// - After this call, the row is gone. No soft-delete, no tombstone,
//   no "deleted_at" marker. A subsequent read returns null.
// =============================================================================

export function deleteMemory(
  db: Database.Database,
  userId: string,
  memoryId: string,
): boolean {
  const result = db
    .prepare(`DELETE FROM memories WHERE id = ? AND user_id = ?`)
    .run(memoryId, userId);

  return result.changes > 0;
}
