import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type MemoryType = "semantic" | "episodic" | "procedural";

export interface MemoryEntry {
  id: string;
  title: string;
  content: string;
  tags: string[];
  origin: string;
  allowed_vendors: string[];
  memory_type: MemoryType;
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
  memory_type?: MemoryType;
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
  | { by: "origin"; origin: string }
  | { by: "trashed" };

export interface MemorySummary {
  id: string;
  title: string;
  tags: string[];
  origin: string;
  memory_type: MemoryType;
  created_at: string;
  updated_at: string;
}

export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

interface MemoryRow {
  id: string;
  user_id: string;
  title: string;
  content: string;
  tags: string;
  origin: string;
  allowed_vendors: string;
  memory_type: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToMemory(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    tags: safeJsonArray(row.tags),
    origin: row.origin,
    allowed_vendors: safeJsonArray(row.allowed_vendors),
    memory_type: row.memory_type as MemoryType,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at ?? undefined,
  };
}

const MEMORY_COLUMNS = ["id", "user_id", "title", "content", "tags", "origin", "allowed_vendors", "memory_type", "created_at", "updated_at", "deleted_at"] as const;
const COLUMNS = MEMORY_COLUMNS.join(", ");
const COLUMNS_ALIASED = MEMORY_COLUMNS.map(c => `m.${c}`).join(", ");

const SUMMARY_COLUMN_LIST = ["id", "user_id", "title", "tags", "origin", "memory_type", "created_at", "updated_at"] as const;
const SUMMARY_COLUMNS = SUMMARY_COLUMN_LIST.join(", ");
const SUMMARY_COLUMNS_ALIASED = SUMMARY_COLUMN_LIST.map(c => `m.${c}`).join(", ");

function escapeLike(term: string): string {
  return term.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

function buildPaginationClause(opts?: PaginationOptions): { sql: string; params: number[] } {
  if (opts?.limit == null) return { sql: "", params: [] };
  const params: number[] = [opts.limit];
  let sql = " LIMIT ?";
  if (opts.offset) {
    sql += " OFFSET ?";
    params.push(opts.offset);
  }
  return { sql, params };
}

// ---------------------------------------------------------------------------
// Deduplication: same-origin similarity check before creating new memories
// ---------------------------------------------------------------------------

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const TITLE_SIMILARITY_THRESHOLD = 0.5;
const CONTENT_SIMILARITY_THRESHOLD = 0.4;
const DEDUP_WINDOW_HOURS = 48;

export interface DedupResult {
  action: "created" | "merged";
  memory: MemoryEntry;
  mergedInto?: string;
}

function findSimilarMemory(
  db: Database.Database,
  userId: string,
  input: CreateMemoryInput,
): MemoryRow | null {
  const cutoff = new Date(Date.now() - DEDUP_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const candidates = db
    .prepare(
      `SELECT ${COLUMNS}
       FROM memories
       WHERE user_id = ? AND origin = ? AND deleted_at IS NULL AND created_at > ?
       ORDER BY created_at DESC
       LIMIT 50`,
    )
    .all(userId, input.origin, cutoff) as MemoryRow[];

  if (candidates.length === 0) return null;

  const inputTitleTokens = tokenize(input.title);
  const inputContentTokens = tokenize(input.content);

  for (const candidate of candidates) {
    const titleSim = jaccardSimilarity(inputTitleTokens, tokenize(candidate.title));
    if (titleSim >= TITLE_SIMILARITY_THRESHOLD) {
      const contentSim = jaccardSimilarity(inputContentTokens, tokenize(candidate.content));
      if (contentSim >= CONTENT_SIMILARITY_THRESHOLD) {
        return candidate;
      }
    }
  }

  return null;
}

function mergeTags(existingRaw: string, newTags: string[]): string[] {
  const existing = safeJsonArray(existingRaw);
  const merged = new Set([...existing, ...newTags]);
  return [...merged];
}

export function createMemory(
  db: Database.Database,
  userId: string,
  input: CreateMemoryInput,
): MemoryEntry {
  const similar = findSimilarMemory(db, userId, input);

  if (similar) {
    const now = new Date().toISOString();
    const mergedTags = mergeTags(similar.tags, input.tags);
    const tagsJson = JSON.stringify(mergedTags);

    const maxVersion = db
      .prepare(`SELECT COALESCE(MAX(version_number), 0) as max_ver FROM memory_versions WHERE memory_id = ?`)
      .get(similar.id) as { max_ver: number };

    db.prepare(
      `INSERT INTO memory_versions (id, memory_id, user_id, title, content, tags, memory_type, origin, allowed_vendors, version_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), similar.id, userId, similar.title, similar.content,
      similar.tags, similar.memory_type ?? "semantic", similar.origin, similar.allowed_vendors,
      maxVersion.max_ver + 1, now,
    );

    db.prepare(
      `UPDATE memories SET title = ?, content = ?, tags = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    ).run(input.title, input.content, tagsJson, now, similar.id, userId);

    return {
      id: similar.id,
      title: input.title,
      content: input.content,
      tags: mergedTags,
      origin: input.origin,
      allowed_vendors: safeJsonArray(similar.allowed_vendors),
      memory_type: (similar.memory_type as MemoryType) ?? "semantic",
      created_at: similar.created_at,
      updated_at: now,
    };
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const tagsJson = JSON.stringify(input.tags);
  const allowedVendorsJson = JSON.stringify(input.allowed_vendors);
  const memoryType = input.memory_type ?? "semantic";

  db.prepare(
    `INSERT INTO memories (id, user_id, title, content, tags, origin, allowed_vendors, memory_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, input.title, input.content, tagsJson, input.origin, allowedVendorsJson, memoryType, now, now);

  return {
    id,
    title: input.title,
    content: input.content,
    tags: [...input.tags],
    origin: input.origin,
    allowed_vendors: [...input.allowed_vendors],
    memory_type: memoryType,
    created_at: now,
    updated_at: now,
  };
}

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
          `SELECT ${COLUMNS_ALIASED}
           FROM memories m
           WHERE m.user_id = ? ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(userId, ...vendorParams, ...pagParams) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    case "trashed": {
      const rows = db
        .prepare(
          `SELECT ${COLUMNS_ALIASED}
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
          `SELECT DISTINCT ${COLUMNS_ALIASED}
           FROM memories m, json_each(m.tags) t
           WHERE m.user_id = ? AND t.value IN (${placeholders}) ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(userId, ...filter.tags, ...vendorParams, ...pagParams) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    case "ids": {
      if (filter.ids.length === 0) return [];
      const placeholders = filter.ids.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT ${COLUMNS_ALIASED}
           FROM memories m
           WHERE m.user_id = ? AND m.id IN (${placeholders}) ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(userId, ...filter.ids, ...vendorParams, ...pagParams) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    case "search": {
      if (filter.term.trim().length === 0) return [];
      const likeTerm = `%${escapeLike(filter.term)}%`;
      const rows = db
        .prepare(
          `SELECT ${COLUMNS_ALIASED}
           FROM memories m
           WHERE m.user_id = ? AND (m.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\') ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(userId, likeTerm, likeTerm, ...vendorParams, ...pagParams) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    case "origin": {
      if (!filter.origin.trim()) return [];
      const rows = db
        .prepare(
          `SELECT ${COLUMNS_ALIASED}
           FROM memories m
           WHERE m.user_id = ? AND m.origin = ? ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(userId, filter.origin, ...vendorParams, ...pagParams) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    default: {
      const _exhaustive: never = filter;
      throw new Error(`Unhandled filter type: ${(_exhaustive as { by: string }).by}`);
    }
  }
}

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
      const likeTerm = `%${escapeLike(filter.term)}%`;
      const row = db
        .prepare(
          `SELECT COUNT(*) as count FROM memories m
           WHERE m.user_id = ? AND (m.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\') ${vendorClause} ${deletedClause}`,
        )
        .get(userId, likeTerm, likeTerm, ...vendorParams) as { count: number };
      return row.count;
    }

    case "origin": {
      if (!filter.origin.trim()) return 0;
      const row = db
        .prepare(
          `SELECT COUNT(*) as count FROM memories m
           WHERE m.user_id = ? AND m.origin = ? ${vendorClause} ${deletedClause}`,
        )
        .get(userId, filter.origin, ...vendorParams) as { count: number };
      return row.count;
    }

    default: {
      const _exhaustive: never = filter;
      throw new Error(`Unhandled filter type: ${(_exhaustive as { by: string }).by}`);
    }
  }
}

interface SummaryRow {
  id: string;
  user_id: string;
  title: string;
  tags: string;
  origin: string;
  memory_type: string;
  created_at: string;
  updated_at: string;
}

function rowToSummary(row: SummaryRow): MemorySummary {
  return {
    id: row.id,
    title: row.title,
    tags: safeJsonArray(row.tags),
    origin: row.origin,
    memory_type: row.memory_type as MemoryType,
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
          `SELECT ${SUMMARY_COLUMNS_ALIASED}
           FROM memories m
           WHERE m.user_id = ? ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(userId, ...vendorParams, ...pagParams) as SummaryRow[];
      return rows.map(rowToSummary);
    }

    case "tags": {
      if (filter.tags.length === 0) return [];
      const placeholders = filter.tags.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT DISTINCT ${SUMMARY_COLUMNS_ALIASED}
           FROM memories m, json_each(m.tags) t
           WHERE m.user_id = ? AND t.value IN (${placeholders}) ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(userId, ...filter.tags, ...vendorParams, ...pagParams) as SummaryRow[];
      return rows.map(rowToSummary);
    }

    case "ids": {
      if (filter.ids.length === 0) return [];
      const placeholders = filter.ids.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS_ALIASED}
           FROM memories m
           WHERE m.user_id = ? AND m.id IN (${placeholders}) ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(userId, ...filter.ids, ...vendorParams, ...pagParams) as SummaryRow[];
      return rows.map(rowToSummary);
    }

    case "search": {
      if (filter.term.trim().length === 0) return [];
      const likeTerm = `%${escapeLike(filter.term)}%`;
      const rows = db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS_ALIASED}
           FROM memories m
           WHERE m.user_id = ? AND (m.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\') ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(userId, likeTerm, likeTerm, ...vendorParams, ...pagParams) as SummaryRow[];
      return rows.map(rowToSummary);
    }

    case "origin": {
      if (!filter.origin.trim()) return [];
      const rows = db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS_ALIASED}
           FROM memories m
           WHERE m.user_id = ? AND m.origin = ? ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(userId, filter.origin, ...vendorParams, ...pagParams) as SummaryRow[];
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

/** Full replacement update. Origin is immutable. Snapshots current state before writing. */
export function updateMemory(
  db: Database.Database,
  userId: string,
  memoryId: string,
  input: UpdateMemoryInput,
): MemoryEntry | null {
  const txn = db.transaction(() => {
    const now = new Date().toISOString();
    const tagsJson = JSON.stringify(input.tags);
    const allowedVendorsJson = JSON.stringify(input.allowed_vendors);

    const current = db
      .prepare(`SELECT * FROM memories WHERE id = ? AND user_id = ?`)
      .get(memoryId, userId) as MemoryRow | undefined;

    if (!current) return null;

    // Snapshot current state before mutation
    const maxVersion = db
      .prepare(`SELECT COALESCE(MAX(version_number), 0) as max_ver FROM memory_versions WHERE memory_id = ?`)
      .get(memoryId) as { max_ver: number };

    db.prepare(
      `INSERT INTO memory_versions (id, memory_id, user_id, title, content, tags, memory_type, origin, allowed_vendors, version_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), memoryId, userId, current.title, current.content,
      current.tags, current.memory_type ?? "semantic", current.origin, current.allowed_vendors,
      maxVersion.max_ver + 1, now,
    );

    const result = db
      .prepare(
        `UPDATE memories
         SET title = ?, content = ?, tags = ?, allowed_vendors = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(input.title, input.content, tagsJson, allowedVendorsJson, now, memoryId, userId);

    if (result.changes === 0) return null;
    return readMemoryById(db, userId, memoryId);
  });

  return txn();
}

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

/** Hard delete + version cleanup. Self-contained -- does not rely on FK cascade. */
export function deleteMemory(
  db: Database.Database,
  userId: string,
  memoryId: string,
): boolean {
  const txn = db.transaction(() => {
    // Verify ownership BEFORE touching memory_versions to prevent
    // cross-user version deletion via guessed memory_id (IDOR).
    const owns = db
      .prepare(`SELECT 1 FROM memories WHERE id = ? AND user_id = ?`)
      .get(memoryId, userId);
    if (!owns) return false;

    db.prepare(`DELETE FROM memory_versions WHERE memory_id = ?`).run(memoryId);
    const result = db
      .prepare(`DELETE FROM memories WHERE id = ? AND user_id = ?`)
      .run(memoryId, userId);
    return result.changes > 0;
  });
  return txn();
}
