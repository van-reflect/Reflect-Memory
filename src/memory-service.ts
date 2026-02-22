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
  deleted_at?: string | null;
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
  | { by: "ids"; ids: string[] }
  | { by: "search"; term: string }
  | { by: "trashed" };

export interface MemorySummary {
  id: string;
  title: string;
  tags: string[];
  origin: string;
  created_at: string;
  updated_at: string;
}

export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

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
  deleted_at?: string | null;
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
    deleted_at: row.deleted_at ?? undefined,
  };
}

const COLUMNS = `id, user_id, title, content, tags, origin, allowed_vendors, created_at, updated_at, deleted_at`;
const SUMMARY_COLUMNS = `id, user_id, title, tags, origin, created_at, updated_at, deleted_at`;

function buildPaginationClause(opts?: PaginationOptions): { sql: string; params: number[] } {
  if (!opts?.limit) return { sql: "", params: [] };
  const params: number[] = [opts.limit];
  let sql = " LIMIT ?";
  if (opts.offset) {
    sql += " OFFSET ?";
    params.push(opts.offset);
  }
  return { sql, params };
}

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
// Supports pagination via limit/offset.
// =============================================================================

export function listMemories(
  db: Database.Database,
  userId: string,
  filter: MemoryFilter,
  vendor?: string | null,
  pagination?: PaginationOptions,
): MemoryEntry[] {
  const vendorClause = vendor
    ? `AND EXISTS (SELECT 1 FROM json_each(m.allowed_vendors) WHERE value = '*' OR value = ?)`
    : "";
  const vendorParams = vendor ? [vendor] : [];
  const deletedClause =
    filter.by === "trashed"
      ? `AND m.deleted_at IS NOT NULL`
      : `AND m.deleted_at IS NULL`;
  const { sql: pagSql, params: pagParams } = buildPaginationClause(pagination);

  switch (filter.by) {
    case "all": {
      const rows = db
        .prepare(
          `SELECT m.${COLUMNS.split(", ").join(", m.")}
           FROM memories m
           WHERE m.user_id = ? ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC${pagSql}`,
        )
        .all(userId, ...vendorParams, ...pagParams) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    case "trashed": {
      const rows = db
        .prepare(
          `SELECT m.${COLUMNS.split(", ").join(", m.")}
           FROM memories m
           WHERE m.user_id = ? ${vendorClause} ${deletedClause}
           ORDER BY m.deleted_at DESC${pagSql}`,
        )
        .all(userId, ...vendorParams, ...pagParams) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    case "tags": {
      if (filter.tags.length === 0) return [];
      const placeholders = filter.tags.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT DISTINCT m.${COLUMNS.split(", ").join(", m.")}
           FROM memories m, json_each(m.tags) t
           WHERE m.user_id = ? AND t.value IN (${placeholders}) ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC${pagSql}`,
        )
        .all(userId, ...filter.tags, ...vendorParams, ...pagParams) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    case "ids": {
      if (filter.ids.length === 0) return [];
      const placeholders = filter.ids.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT m.${COLUMNS.split(", ").join(", m.")}
           FROM memories m
           WHERE m.user_id = ? AND m.id IN (${placeholders}) ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC${pagSql}`,
        )
        .all(userId, ...filter.ids, ...vendorParams, ...pagParams) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    case "search": {
      if (filter.term.trim().length === 0) return [];
      const likeTerm = `%${filter.term}%`;
      const rows = db
        .prepare(
          `SELECT m.${COLUMNS.split(", ").join(", m.")}
           FROM memories m
           WHERE m.user_id = ? AND (m.title LIKE ? OR m.content LIKE ?) ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC${pagSql}`,
        )
        .all(userId, likeTerm, likeTerm, ...vendorParams, ...pagParams) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    default: {
      const _exhaustive: never = filter;
      throw new Error(`Unhandled filter type: ${(_exhaustive as { by: string }).by}`);
    }
  }
}

// =============================================================================
// countMemories
// =============================================================================

export function countMemories(
  db: Database.Database,
  userId: string,
  filter: MemoryFilter,
  vendor?: string | null,
): number {
  const vendorClause = vendor
    ? `AND EXISTS (SELECT 1 FROM json_each(m.allowed_vendors) WHERE value = '*' OR value = ?)`
    : "";
  const vendorParams = vendor ? [vendor] : [];
  const deletedClause =
    filter.by === "trashed"
      ? `AND m.deleted_at IS NOT NULL`
      : `AND m.deleted_at IS NULL`;

  switch (filter.by) {
    case "all": {
      const row = db
        .prepare(
          `SELECT COUNT(*) as count FROM memories m WHERE m.user_id = ? ${vendorClause} ${deletedClause}`,
        )
        .get(userId, ...vendorParams) as { count: number };
      return row.count;
    }

    case "trashed": {
      const row = db
        .prepare(
          `SELECT COUNT(*) as count FROM memories m WHERE m.user_id = ? ${vendorClause} ${deletedClause}`,
        )
        .get(userId, ...vendorParams) as { count: number };
      return row.count;
    }

    case "tags": {
      if (filter.tags.length === 0) return 0;
      const placeholders = filter.tags.map(() => "?").join(", ");
      const row = db
        .prepare(
          `SELECT COUNT(DISTINCT m.id) as count
           FROM memories m, json_each(m.tags) t
           WHERE m.user_id = ? AND t.value IN (${placeholders}) ${vendorClause} ${deletedClause}`,
        )
        .get(userId, ...filter.tags, ...vendorParams) as { count: number };
      return row.count;
    }

    case "ids": {
      if (filter.ids.length === 0) return 0;
      const placeholders = filter.ids.map(() => "?").join(", ");
      const row = db
        .prepare(
          `SELECT COUNT(*) as count FROM memories m
           WHERE m.user_id = ? AND m.id IN (${placeholders}) ${vendorClause} ${deletedClause}`,
        )
        .get(userId, ...filter.ids, ...vendorParams) as { count: number };
      return row.count;
    }

    case "search": {
      if (filter.term.trim().length === 0) return 0;
      const likeTerm = `%${filter.term}%`;
      const row = db
        .prepare(
          `SELECT COUNT(*) as count FROM memories m
           WHERE m.user_id = ? AND (m.title LIKE ? OR m.content LIKE ?) ${vendorClause} ${deletedClause}`,
        )
        .get(userId, likeTerm, likeTerm, ...vendorParams) as { count: number };
      return row.count;
    }

    default: {
      const _exhaustive: never = filter;
      throw new Error(`Unhandled filter type: ${(_exhaustive as { by: string }).by}`);
    }
  }
}

// =============================================================================
// listMemorySummaries
// =============================================================================
// Lightweight listing: returns metadata only (no content field).
// Designed for browse/discovery endpoints where the agent needs to see
// what exists before fetching full entries.
// =============================================================================

interface SummaryRow {
  id: string;
  user_id: string;
  title: string;
  tags: string;
  origin: string;
  created_at: string;
  updated_at: string;
}

function rowToSummary(row: SummaryRow): MemorySummary {
  return {
    id: row.id,
    title: row.title,
    tags: JSON.parse(row.tags) as string[],
    origin: row.origin,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listMemorySummaries(
  db: Database.Database,
  userId: string,
  filter: MemoryFilter,
  vendor?: string | null,
  pagination?: PaginationOptions,
): MemorySummary[] {
  const vendorClause = vendor
    ? `AND EXISTS (SELECT 1 FROM json_each(m.allowed_vendors) WHERE value = '*' OR value = ?)`
    : "";
  const vendorParams = vendor ? [vendor] : [];
  const deletedClause = `AND m.deleted_at IS NULL`;
  const { sql: pagSql, params: pagParams } = buildPaginationClause(pagination);

  switch (filter.by) {
    case "all": {
      const rows = db
        .prepare(
          `SELECT m.${SUMMARY_COLUMNS.split(", ").join(", m.")}
           FROM memories m
           WHERE m.user_id = ? ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC${pagSql}`,
        )
        .all(userId, ...vendorParams, ...pagParams) as SummaryRow[];
      return rows.map(rowToSummary);
    }

    case "tags": {
      if (filter.tags.length === 0) return [];
      const placeholders = filter.tags.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT DISTINCT m.${SUMMARY_COLUMNS.split(", ").join(", m.")}
           FROM memories m, json_each(m.tags) t
           WHERE m.user_id = ? AND t.value IN (${placeholders}) ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC${pagSql}`,
        )
        .all(userId, ...filter.tags, ...vendorParams, ...pagParams) as SummaryRow[];
      return rows.map(rowToSummary);
    }

    case "ids": {
      if (filter.ids.length === 0) return [];
      const placeholders = filter.ids.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT m.${SUMMARY_COLUMNS.split(", ").join(", m.")}
           FROM memories m
           WHERE m.user_id = ? AND m.id IN (${placeholders}) ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC${pagSql}`,
        )
        .all(userId, ...filter.ids, ...vendorParams, ...pagParams) as SummaryRow[];
      return rows.map(rowToSummary);
    }

    case "search": {
      if (filter.term.trim().length === 0) return [];
      const likeTerm = `%${filter.term}%`;
      const rows = db
        .prepare(
          `SELECT m.${SUMMARY_COLUMNS.split(", ").join(", m.")}
           FROM memories m
           WHERE m.user_id = ? AND (m.title LIKE ? OR m.content LIKE ?) ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC${pagSql}`,
        )
        .all(userId, likeTerm, likeTerm, ...vendorParams, ...pagParams) as SummaryRow[];
      return rows.map(rowToSummary);
    }

    case "trashed":
      return [];

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
// softDeleteMemory
// =============================================================================
// Moves memory to trash. Sets deleted_at. Used by dashboard "Delete" action.
// =============================================================================

export function softDeleteMemory(
  db: Database.Database,
  userId: string,
  memoryId: string,
): MemoryEntry | null {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE memories
       SET deleted_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .run(now, now, memoryId, userId);

  if (result.changes === 0) return null;
  return readMemoryById(db, userId, memoryId);
}

// =============================================================================
// restoreMemory
// =============================================================================
// Clears deleted_at. Used by dashboard "Restore" from trash.
// =============================================================================

export function restoreMemory(
  db: Database.Database,
  userId: string,
  memoryId: string,
): MemoryEntry | null {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE memories
       SET deleted_at = NULL, updated_at = ?
       WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`,
    )
    .run(now, memoryId, userId);

  if (result.changes === 0) return null;
  return readMemoryById(db, userId, memoryId);
}

// =============================================================================
// deleteMemory
// =============================================================================
// Hard delete by primary key. For purge job (30-day auto-delete). Not used by dashboard.
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
