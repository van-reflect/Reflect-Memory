// Reflect Memory — Memory Service
// Pure data access layer. No HTTP, no AI, no logging, no side effects beyond SQL.
// Every function requires an explicit user_id. No function infers ownership.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

// =============================================================================
// Types
// =============================================================================

export interface MemoryEntry {
  id: string;
  user_id: string;
  title: string;
  content: string;
  tags: string[];
  origin: string;
  allowed_vendors: string[];
  created_at: string;
  updated_at: string;
}

export interface CreateMemoryInput {
  title: string;
  content: string;
  tags: string[];
  origin: string;
  allowed_vendors: string[];
}

export interface UpdateMemoryInput {
  title: string;
  content: string;
  tags: string[];
  allowed_vendors: string[];
}

export type MemoryFilter =
  | { by: "all" }
  | { by: "tags"; tags: string[] }
  | { by: "ids"; ids: string[] };

// =============================================================================
// Internal: row mapping
// =============================================================================

interface MemoryRow {
  id: string;
  user_id: string;
  title: string;
  content: string;
  tags: string;
  origin: string;
  allowed_vendors: string;
  created_at: string;
  updated_at: string;
}

function rowToMemory(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    content: row.content,
    tags: JSON.parse(row.tags) as string[],
    origin: row.origin,
    allowed_vendors: JSON.parse(row.allowed_vendors) as string[],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const COLUMNS = `id, user_id, title, content, tags, origin, allowed_vendors, created_at, updated_at`;

// =============================================================================
// createMemory
// =============================================================================

export function createMemory(
  db: Database.Database,
  userId: string,
  input: CreateMemoryInput,
): MemoryEntry {
  const id = randomUUID();
  const now = new Date().toISOString();
  const tagsJson = JSON.stringify(input.tags);
  const allowedVendorsJson = JSON.stringify(input.allowed_vendors);

  db.prepare(
    `INSERT INTO memories (id, user_id, title, content, tags, origin, allowed_vendors, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, input.title, input.content, tagsJson, input.origin, allowedVendorsJson, now, now);

  return {
    id,
    user_id: userId,
    title: input.title,
    content: input.content,
    tags: [...input.tags],
    origin: input.origin,
    allowed_vendors: [...input.allowed_vendors],
    created_at: now,
    updated_at: now,
  };
}

// =============================================================================
// readMemoryById
// =============================================================================

export function readMemoryById(
  db: Database.Database,
  userId: string,
  memoryId: string,
): MemoryEntry | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM memories WHERE id = ? AND user_id = ?`)
    .get(memoryId, userId) as MemoryRow | undefined;

  if (!row) return null;
  return rowToMemory(row);
}

// =============================================================================
// listMemories
// =============================================================================
// Optional vendor parameter: when set, only returns memories where
// allowed_vendors contains "*" or the given vendor name.
// When null/undefined (user path), returns all memories for the user.
// =============================================================================

export function listMemories(
  db: Database.Database,
  userId: string,
  filter: MemoryFilter,
  vendor?: string | null,
): MemoryEntry[] {
  const vendorClause = vendor
    ? `AND EXISTS (SELECT 1 FROM json_each(m.allowed_vendors) WHERE value = '*' OR value = ?)`
    : "";
  const vendorParams = vendor ? [vendor] : [];

  switch (filter.by) {
    case "all": {
      const rows = db
        .prepare(
          `SELECT m.${COLUMNS.split(", ").join(", m.")}
           FROM memories m
           WHERE m.user_id = ? ${vendorClause}
           ORDER BY m.created_at DESC`,
        )
        .all(userId, ...vendorParams) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    case "tags": {
      if (filter.tags.length === 0) return [];
      const placeholders = filter.tags.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT DISTINCT m.${COLUMNS.split(", ").join(", m.")}
           FROM memories m, json_each(m.tags) t
           WHERE m.user_id = ? AND t.value IN (${placeholders}) ${vendorClause}
           ORDER BY m.created_at DESC`,
        )
        .all(userId, ...filter.tags, ...vendorParams) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    case "ids": {
      if (filter.ids.length === 0) return [];
      const placeholders = filter.ids.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT m.${COLUMNS.split(", ").join(", m.")}
           FROM memories m
           WHERE m.user_id = ? AND m.id IN (${placeholders}) ${vendorClause}
           ORDER BY m.created_at DESC`,
        )
        .all(userId, ...filter.ids, ...vendorParams) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    default: {
      const _exhaustive: never = filter;
      throw new Error(`Unhandled filter type: ${(_exhaustive as { by: string }).by}`);
    }
  }
}

// =============================================================================
// updateMemory
// =============================================================================
// Full replacement. Origin is immutable — not included in the update.
// =============================================================================

export function updateMemory(
  db: Database.Database,
  userId: string,
  memoryId: string,
  input: UpdateMemoryInput,
): MemoryEntry | null {
  const now = new Date().toISOString();
  const tagsJson = JSON.stringify(input.tags);
  const allowedVendorsJson = JSON.stringify(input.allowed_vendors);

  const result = db
    .prepare(
      `UPDATE memories
       SET title = ?, content = ?, tags = ?, allowed_vendors = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(input.title, input.content, tagsJson, allowedVendorsJson, now, memoryId, userId);

  if (result.changes === 0) return null;
  return readMemoryById(db, userId, memoryId);
}

// =============================================================================
// deleteMemory
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
