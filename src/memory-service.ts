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
  /** Org-scope share. Mutually exclusive with shared_with_team_id. */
  shared_with_org_id?: string | null;
  /** Team-scope (sub-team) share. Mutually exclusive with shared_with_org_id. */
  shared_with_team_id?: string | null;
  shared_at?: string | null;
  /** Present when this memory is a reply / child of another. Top-level
   *  memories have this as null or undefined. Children never have children
   *  (enforced at write time). */
  parent_memory_id?: string | null;
}

export interface CreateMemoryInput {
  title: string;
  content: string;
  tags: string[];
  origin: string;
  allowed_vendors: string[];
  memory_type?: MemoryType;
  /**
   * The caller's intended share scope for this write. Used by the
   * dedup path so that two writes with different intended visibilities
   * are treated as distinct memories — even when their title/content
   * tokens are similar enough to otherwise merge.
   *
   * Without this, a follow-up write with a different scope would
   * merge into an earlier memory and then have its scope silently
   * flipped by the post-write share step (data-loss + visibility leak).
   *
   * Defaults to "personal" when omitted.
   */
  share_scope_intent?: "personal" | "org" | "team";
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

/**
 * Visibility scope for read/search/browse queries.
 *   "personal" — only memories the caller authored (legacy default; kept
 *                for backward compat with existing call sites).
 *   "org"      — memories shared with the caller's org (any author).
 *   "team"     — memories shared with the caller's sub-team (any author).
 *   "all"      — union of personal + org + team (everything the caller
 *                has read access to). Recommended for discovery tools
 *                like browse / search / by-tag because it matches the
 *                user's intuitive expectation that "search my memories"
 *                covers everything they can see in the dashboard.
 *
 * Note on `trashed` filter: trash is always personal-only — soft-deleted
 * shared memories don't show up in anyone else's trash because that's
 * an editor's-view concept. The scope arg is ignored for `by: "trashed"`.
 */
export type MemoryScope = "personal" | "org" | "team" | "all";

/**
 * Build the SQL WHERE-clause fragment that scopes a memories query to
 * the caller's accessible visibility. Returns the fragment and a
 * helper that yields the parameter values, in order, for the prepared
 * statement.
 *
 * The clause references the `m` alias for the memories table (used
 * everywhere in this file). The org_id / team_id of the caller are
 * resolved via subqueries so the call site doesn't need to pre-fetch
 * the user row.
 */
function buildScopeClause(
  scope: MemoryScope,
): { sql: string; params: (userId: string) => unknown[] } {
  switch (scope) {
    case "personal":
      return { sql: "m.user_id = ?", params: (uid) => [uid] };
    case "org":
      return {
        sql:
          "m.shared_with_org_id IS NOT NULL " +
          "AND m.shared_with_org_id = (SELECT org_id FROM users WHERE id = ?)",
        params: (uid) => [uid],
      };
    case "team":
      return {
        sql:
          "m.shared_with_team_id IS NOT NULL " +
          "AND m.shared_with_team_id = (SELECT team_id FROM users WHERE id = ?)",
        params: (uid) => [uid],
      };
    case "all":
      return {
        sql:
          "(m.user_id = ? " +
          "OR (m.shared_with_org_id IS NOT NULL AND m.shared_with_org_id = (SELECT org_id FROM users WHERE id = ?)) " +
          "OR (m.shared_with_team_id IS NOT NULL AND m.shared_with_team_id = (SELECT team_id FROM users WHERE id = ?)))",
        params: (uid) => [uid, uid, uid],
      };
  }
}

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
  shared_with_org_id?: string | null;
  shared_with_team_id?: string | null;
  shared_at?: string | null;
  parent_memory_id?: string | null;
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
    shared_with_org_id: row.shared_with_org_id ?? null,
    shared_with_team_id: row.shared_with_team_id ?? null,
    shared_at: row.shared_at ?? null,
    parent_memory_id: row.parent_memory_id ?? null,
  };
}

const MEMORY_COLUMNS = ["id", "user_id", "title", "content", "tags", "origin", "allowed_vendors", "memory_type", "created_at", "updated_at", "deleted_at", "shared_with_org_id", "shared_with_team_id", "shared_at", "parent_memory_id"] as const;
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

/** @internal — exported for unit tests; do not use outside this module. */
export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/** @internal — exported for unit tests; do not use outside this module. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** @internal — exposed so unit tests can assert against the same constants the prod path uses. */
export const TITLE_SIMILARITY_THRESHOLD = 0.5;
export const CONTENT_SIMILARITY_THRESHOLD = 0.4;
export const DEDUP_WINDOW_HOURS = 48;

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

  // Scope-aware dedup: only consider candidates whose CURRENT visibility
  // matches the incoming write's INTENT. This prevents a same-shape
  // follow-up with a different intended scope (e.g. T1=team then
  // T2=org) from merging into the prior row and having its share
  // scope silently flipped by the post-write share step.
  let scopePredicate: string;
  switch (input.share_scope_intent ?? "personal") {
    case "team":
      scopePredicate = " AND shared_with_team_id IS NOT NULL";
      break;
    case "org":
      scopePredicate = " AND shared_with_org_id IS NOT NULL";
      break;
    case "personal":
    default:
      scopePredicate =
        " AND shared_with_org_id IS NULL AND shared_with_team_id IS NULL";
      break;
  }

  const candidates = db
    .prepare(
      `SELECT ${COLUMNS}
       FROM memories
       WHERE user_id = ? AND origin = ? AND deleted_at IS NULL AND created_at > ?${scopePredicate}
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

    // Consistent response shape (issue #3): always surface share +
    // parent fields, even on the merge path. Same-scope dedup means
    // these reflect the existing memory's state and applyShareScope
    // (when invoked) will refresh shared_at without changing scope.
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
      shared_with_org_id: similar.shared_with_org_id ?? null,
      shared_with_team_id: similar.shared_with_team_id ?? null,
      shared_at: similar.shared_at ?? null,
      parent_memory_id: similar.parent_memory_id ?? null,
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
    shared_with_org_id: null,
    shared_with_team_id: null,
    shared_at: null,
    parent_memory_id: null,
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

/**
 * Read a memory the caller can access — either because they own it,
 * OR because it is shared with their org, OR because it is shared with
 * their sub-team. Returns null if none of those hold (looks like a 404
 * to the caller, which is intentional — we don't want to leak existence
 * of memories outside the caller's visibility).
 *
 * Used by team-collaborative endpoints (e.g. thread fetch, get-by-id)
 * where a teammate needs to read a memory another team member owns or
 * a memory that was shared into a pool the caller has access to.
 *
 * Sub-team access was added alongside the orgs+teams v1 cutover; before
 * that this only handled personal + org-shared, which made
 * sub-team-shared memories invisible to `get_memory_by_id` from the
 * MCP server (matching the wider scope-aware fix in the discovery
 * tools).
 */
export function readMemoryWithTeamAccess(
  db: Database.Database,
  userId: string,
  memoryId: string,
): MemoryEntry | null {
  const row = db
    .prepare(
      `SELECT ${COLUMNS} FROM memories
       WHERE id = ?
         AND (
           user_id = ?
           OR (
             shared_with_org_id IS NOT NULL
             AND shared_with_org_id = (SELECT org_id FROM users WHERE id = ?)
           )
           OR (
             shared_with_team_id IS NOT NULL
             AND shared_with_team_id = (SELECT team_id FROM users WHERE id = ?)
           )
         )`,
    )
    .get(memoryId, userId, userId, userId) as MemoryRow | undefined;
  if (!row) return null;
  return rowToMemory(row);
}

export function listMemories(
  db: Database.Database,
  userId: string,
  filter: MemoryFilter,
  vendor?: string | null,
  pagination?: PaginationOptions,
  scope: MemoryScope = "personal",
): MemoryEntry[] {
  const vendorClause = vendor
    ? `AND EXISTS (SELECT 1 FROM json_each(m.allowed_vendors) WHERE value = '*' OR value = ?)`
    : "";
  const vendorParams = vendor ? [vendor] : [];
  const deletedClause =
    filter.by === "trashed"
      ? `AND m.deleted_at IS NOT NULL`
      : `AND m.deleted_at IS NULL`;
  // Trash is always personal-only — restoring your own soft-deletes is
  // an editor's-view concept, not a shared one. Override scope here to
  // avoid surfacing other users' trashed memories.
  const effectiveScope: MemoryScope = filter.by === "trashed" ? "personal" : scope;
  const sc = buildScopeClause(effectiveScope);
  const scopeParams = sc.params(userId);
  const { sql: pagSql, params: pagParams } = buildPaginationClause(pagination);

  switch (filter.by) {
    case "all": {
      const rows = db
        .prepare(
          `SELECT ${COLUMNS_ALIASED}
           FROM memories m
           WHERE ${sc.sql} ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(...scopeParams, ...vendorParams, ...pagParams) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    case "trashed": {
      const rows = db
        .prepare(
          `SELECT ${COLUMNS_ALIASED}
           FROM memories m
           WHERE ${sc.sql} ${vendorClause} ${deletedClause}
           ORDER BY m.deleted_at DESC${pagSql}`,
        )
        .all(...scopeParams, ...vendorParams, ...pagParams) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    case "tags": {
      if (filter.tags.length === 0) return [];
      const placeholders = filter.tags.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT DISTINCT ${COLUMNS_ALIASED}
           FROM memories m, json_each(m.tags) t
           WHERE ${sc.sql} AND t.value IN (${placeholders}) ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(...scopeParams, ...filter.tags, ...vendorParams, ...pagParams) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    case "ids": {
      if (filter.ids.length === 0) return [];
      const placeholders = filter.ids.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT ${COLUMNS_ALIASED}
           FROM memories m
           WHERE ${sc.sql} AND m.id IN (${placeholders}) ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(...scopeParams, ...filter.ids, ...vendorParams, ...pagParams) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    case "search": {
      if (filter.term.trim().length === 0) return [];
      const likeTerm = `%${escapeLike(filter.term)}%`;
      const rows = db
        .prepare(
          `SELECT ${COLUMNS_ALIASED}
           FROM memories m
           WHERE ${sc.sql} AND (m.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\') ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(...scopeParams, likeTerm, likeTerm, ...vendorParams, ...pagParams) as MemoryRow[];
      return rows.map(rowToMemory);
    }

    case "origin": {
      if (!filter.origin.trim()) return [];
      const rows = db
        .prepare(
          `SELECT ${COLUMNS_ALIASED}
           FROM memories m
           WHERE ${sc.sql} AND m.origin = ? ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(...scopeParams, filter.origin, ...vendorParams, ...pagParams) as MemoryRow[];
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
  scope: MemoryScope = "personal",
): number {
  const vendorClause = vendor
    ? `AND EXISTS (SELECT 1 FROM json_each(m.allowed_vendors) WHERE value = '*' OR value = ?)`
    : "";
  const vendorParams = vendor ? [vendor] : [];
  const deletedClause =
    filter.by === "trashed"
      ? `AND m.deleted_at IS NOT NULL`
      : `AND m.deleted_at IS NULL`;
  const effectiveScope: MemoryScope = filter.by === "trashed" ? "personal" : scope;
  const sc = buildScopeClause(effectiveScope);
  const scopeParams = sc.params(userId);

  switch (filter.by) {
    case "all": {
      const row = db
        .prepare(
          `SELECT COUNT(*) as count FROM memories m WHERE ${sc.sql} ${vendorClause} ${deletedClause}`,
        )
        .get(...scopeParams, ...vendorParams) as { count: number };
      return row.count;
    }

    case "trashed": {
      const row = db
        .prepare(
          `SELECT COUNT(*) as count FROM memories m WHERE ${sc.sql} ${vendorClause} ${deletedClause}`,
        )
        .get(...scopeParams, ...vendorParams) as { count: number };
      return row.count;
    }

    case "tags": {
      if (filter.tags.length === 0) return 0;
      const placeholders = filter.tags.map(() => "?").join(", ");
      const row = db
        .prepare(
          `SELECT COUNT(DISTINCT m.id) as count
           FROM memories m, json_each(m.tags) t
           WHERE ${sc.sql} AND t.value IN (${placeholders}) ${vendorClause} ${deletedClause}`,
        )
        .get(...scopeParams, ...filter.tags, ...vendorParams) as { count: number };
      return row.count;
    }

    case "ids": {
      if (filter.ids.length === 0) return 0;
      const placeholders = filter.ids.map(() => "?").join(", ");
      const row = db
        .prepare(
          `SELECT COUNT(*) as count FROM memories m
           WHERE ${sc.sql} AND m.id IN (${placeholders}) ${vendorClause} ${deletedClause}`,
        )
        .get(...scopeParams, ...filter.ids, ...vendorParams) as { count: number };
      return row.count;
    }

    case "search": {
      if (filter.term.trim().length === 0) return 0;
      const likeTerm = `%${escapeLike(filter.term)}%`;
      const row = db
        .prepare(
          `SELECT COUNT(*) as count FROM memories m
           WHERE ${sc.sql} AND (m.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\') ${vendorClause} ${deletedClause}`,
        )
        .get(...scopeParams, likeTerm, likeTerm, ...vendorParams) as { count: number };
      return row.count;
    }

    case "origin": {
      if (!filter.origin.trim()) return 0;
      const row = db
        .prepare(
          `SELECT COUNT(*) as count FROM memories m
           WHERE ${sc.sql} AND m.origin = ? ${vendorClause} ${deletedClause}`,
        )
        .get(...scopeParams, filter.origin, ...vendorParams) as { count: number };
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
  scope: MemoryScope = "personal",
): MemorySummary[] {
  const vendorClause = vendor
    ? `AND EXISTS (SELECT 1 FROM json_each(m.allowed_vendors) WHERE value = '*' OR value = ?)`
    : "";
  const vendorParams = vendor ? [vendor] : [];
  const deletedClause = `AND m.deleted_at IS NULL`;
  const sc = buildScopeClause(scope);
  const scopeParams = sc.params(userId);
  const { sql: pagSql, params: pagParams } = buildPaginationClause(pagination);

  switch (filter.by) {
    case "all": {
      const rows = db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS_ALIASED}
           FROM memories m
           WHERE ${sc.sql} ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(...scopeParams, ...vendorParams, ...pagParams) as SummaryRow[];
      return rows.map(rowToSummary);
    }

    case "tags": {
      if (filter.tags.length === 0) return [];
      const placeholders = filter.tags.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT DISTINCT ${SUMMARY_COLUMNS_ALIASED}
           FROM memories m, json_each(m.tags) t
           WHERE ${sc.sql} AND t.value IN (${placeholders}) ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(...scopeParams, ...filter.tags, ...vendorParams, ...pagParams) as SummaryRow[];
      return rows.map(rowToSummary);
    }

    case "ids": {
      if (filter.ids.length === 0) return [];
      const placeholders = filter.ids.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS_ALIASED}
           FROM memories m
           WHERE ${sc.sql} AND m.id IN (${placeholders}) ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(...scopeParams, ...filter.ids, ...vendorParams, ...pagParams) as SummaryRow[];
      return rows.map(rowToSummary);
    }

    case "search": {
      if (filter.term.trim().length === 0) return [];
      const likeTerm = `%${escapeLike(filter.term)}%`;
      const rows = db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS_ALIASED}
           FROM memories m
           WHERE ${sc.sql} AND (m.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\') ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(...scopeParams, likeTerm, likeTerm, ...vendorParams, ...pagParams) as SummaryRow[];
      return rows.map(rowToSummary);
    }

    case "origin": {
      if (!filter.origin.trim()) return [];
      const rows = db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS_ALIASED}
           FROM memories m
           WHERE ${sc.sql} AND m.origin = ? ${vendorClause} ${deletedClause}
           ORDER BY m.created_at DESC, m.id DESC${pagSql}`,
        )
        .all(...scopeParams, filter.origin, ...vendorParams, ...pagParams) as SummaryRow[];
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
/**
 * Result of an update attempt. Used by the route layer to decide whether
 * to emit a `memory.cross_author_update` audit event in addition to the
 * regular `memory.updated` event.
 */
export interface UpdateMemoryResult {
  memory: MemoryEntry;
  /** True iff the caller is not the original author of the memory.
   *  The route layer should record an audit event in that case so we
   *  retain a paper trail of who edited whose memory. */
  cross_author: boolean;
  /** Original author's user_id, preserved across the update. */
  original_author: string;
  /** Scope under which the caller had write access — used for audit
   *  metadata only. "self" = caller is the author; "org"/"team" = the
   *  memory was shared with the caller's org or sub-team. */
  access_scope: "self" | "org" | "team";
}

/**
 * Update a memory. Author-or-team-member permission model:
 *   - Caller is the original author → always allowed.
 *   - Memory is org-shared and caller is on that org → allowed.
 *   - Memory is sub-team-shared and caller is on that sub-team → allowed.
 *   - Otherwise → null (looks like a 404; we don't leak existence).
 *
 * The original `user_id` (author) is preserved on update — a teammate
 * editing a shared memory does not change its authorship. The
 * `memory_versions` snapshot records who made each change via the
 * audit_events trail (see route layer's cross_author_update emit).
 *
 * Note: soft/hard delete + restore intentionally stay author-only.
 * Update is reversible via memory_versions; delete is not (or much
 * harder). The asymmetry is deliberate.
 */
export function updateMemory(
  db: Database.Database,
  userId: string,
  memoryId: string,
  input: UpdateMemoryInput,
): UpdateMemoryResult | null {
  const txn = db.transaction(() => {
    const now = new Date().toISOString();
    const tagsJson = JSON.stringify(input.tags);
    const allowedVendorsJson = JSON.stringify(input.allowed_vendors);

    const current = db
      .prepare(`SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL`)
      .get(memoryId) as MemoryRow | undefined;

    if (!current) return null;

    // Permission check: author OR member of the org/team this memory is
    // shared with. We resolve the caller's org/team membership in the
    // same query rather than a separate lookup so authorization stays
    // a single round-trip.
    let access_scope: "self" | "org" | "team";
    if (current.user_id === userId) {
      access_scope = "self";
    } else if (current.shared_with_org_id) {
      const callerOrg = (
        db.prepare(`SELECT org_id FROM users WHERE id = ?`).get(userId) as
          | { org_id: string | null }
          | undefined
      )?.org_id;
      if (callerOrg && callerOrg === current.shared_with_org_id) {
        access_scope = "org";
      } else {
        return null;
      }
    } else if (current.shared_with_team_id) {
      const callerTeam = (
        db.prepare(`SELECT team_id FROM users WHERE id = ?`).get(userId) as
          | { team_id: string | null }
          | undefined
      )?.team_id;
      if (callerTeam && callerTeam === current.shared_with_team_id) {
        access_scope = "team";
      } else {
        return null;
      }
    } else {
      // Personal memory, caller is not the author — no access.
      return null;
    }

    // Snapshot pre-mutation state. user_id on the version row records
    // the EDITOR (so a future "who changed what" view can attribute the
    // change), while the parent memory's user_id stays the original
    // author. This matches the existing version-row semantics where
    // user_id has always meant "who saved this snapshot".
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

    // UPDATE no longer scoped by user_id — that was the bug. We
    // already verified access above; the WHERE clause now just
    // re-checks deleted_at to avoid racing with a soft-delete.
    const result = db
      .prepare(
        `UPDATE memories
         SET title = ?, content = ?, tags = ?, allowed_vendors = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(input.title, input.content, tagsJson, allowedVendorsJson, now, memoryId);

    if (result.changes === 0) return null;

    // Read back via the author's user_id so the returned MemoryEntry
    // reflects what the original author would see. (For team-edits the
    // shape is identical regardless of whose user_id we read with.)
    const refreshed = readMemoryById(db, current.user_id, memoryId);
    if (!refreshed) return null;

    return {
      memory: refreshed,
      cross_author: current.user_id !== userId,
      original_author: current.user_id,
      access_scope,
    } satisfies UpdateMemoryResult;
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

/** Permanently delete all trashed memories for a user. Returns count of deleted rows. */
export function emptyTrash(
  db: Database.Database,
  userId: string,
): number {
  const txn = db.transaction(() => {
    const trashed = db
      .prepare(`SELECT id FROM memories WHERE user_id = ? AND deleted_at IS NOT NULL`)
      .all(userId) as { id: string }[];

    if (trashed.length === 0) return 0;

    const ids = trashed.map((r) => r.id);
    for (const id of ids) {
      db.prepare(`DELETE FROM memory_versions WHERE memory_id = ?`).run(id);
    }

    const result = db
      .prepare(`DELETE FROM memories WHERE user_id = ? AND deleted_at IS NOT NULL`)
      .run(userId);
    return result.changes;
  });
  return txn();
}

// ---------------------------------------------------------------------------
// Threading: parent ↔ children relationships.
// One level only (enforced in createChildMemory). Children inherit the
// parent's sharing (applied in createChildMemory + cascade helpers below).
// Cascade helpers return the affected child IDs so the route layer can
// emit one SSE event per child (SQL CASCADE would skip the event bus).
// ---------------------------------------------------------------------------

export class ThreadingError extends Error {
  constructor(
    message: string,
    public code:
      | "parent_not_found"
      | "parent_is_child"
      | "parent_deleted"
      | "not_owner",
  ) {
    super(message);
    this.name = "ThreadingError";
  }
}

/** Resolve a user's org_id (null if not on a team). Internal helper. */
function getUserTeamIdInternal(
  db: Database.Database,
  userId: string,
): string | null {
  const row = db
    .prepare("SELECT org_id FROM users WHERE id = ?")
    .get(userId) as { org_id: string | null } | undefined;
  return row?.org_id ?? null;
}

/**
 * Create a memory as a child of an existing parent.
 *
 * Permission model:
 *   - Caller may reply to their OWN parent memory (always).
 *   - Caller may reply to a parent that is shared with their team (any team
 *     member can participate in a shared thread). This was added 2026-04-22
 *     after Van couldn't reply to a teammate's shared ticket.
 *   - Caller may NOT reply to someone else's private memory.
 *
 * Other validations:
 *   - Parent must exist.
 *   - Parent must not be soft-deleted.
 *   - Parent must not itself be a child (single-level threading).
 *
 * Behavior:
 *   - No similar-memory dedup (unlike createMemory). A reply shouldn't
 *     silently merge with an unrelated top-level memory.
 *   - Child inherits the parent's `shared_with_org_id` (access
 *     inheritance — if parent is in the team pool, so is the child).
 *   - Child is owned by the CALLER, not by the parent's owner.
 *
 * Throws ThreadingError on validation failure.
 */
export function createChildMemory(
  db: Database.Database,
  userId: string,
  parentId: string,
  input: CreateMemoryInput,
): MemoryEntry {
  const parent = db
    .prepare(
      `SELECT id, user_id, parent_memory_id, deleted_at, shared_with_org_id
       FROM memories WHERE id = ?`,
    )
    .get(parentId) as
    | {
        id: string;
        user_id: string;
        parent_memory_id: string | null;
        deleted_at: string | null;
        shared_with_org_id: string | null;
      }
    | undefined;

  if (!parent) {
    throw new ThreadingError("Parent memory not found", "parent_not_found");
  }
  if (parent.user_id !== userId) {
    // Allowed iff parent is shared with a team the caller belongs to.
    const callerTeamId = getUserTeamIdInternal(db, userId);
    const sharedWithCallerTeam =
      parent.shared_with_org_id !== null &&
      callerTeamId !== null &&
      parent.shared_with_org_id === callerTeamId;
    if (!sharedWithCallerTeam) {
      throw new ThreadingError(
        "Parent memory belongs to another user and is not shared with your team",
        "not_owner",
      );
    }
  }
  if (parent.deleted_at !== null) {
    throw new ThreadingError("Cannot reply to a trashed memory", "parent_deleted");
  }
  if (parent.parent_memory_id !== null) {
    throw new ThreadingError(
      "Threads are one level deep; cannot reply to a child",
      "parent_is_child",
    );
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const tagsJson = JSON.stringify(input.tags);
  const allowedVendorsJson = JSON.stringify(input.allowed_vendors);
  const memoryType = input.memory_type ?? "semantic";

  db.prepare(
    `INSERT INTO memories
      (id, user_id, title, content, tags, origin, allowed_vendors, memory_type,
       created_at, updated_at, shared_with_org_id, shared_at, parent_memory_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    input.title,
    input.content,
    tagsJson,
    input.origin,
    allowedVendorsJson,
    memoryType,
    now,
    now,
    parent.shared_with_org_id,
    parent.shared_with_org_id ? now : null,
    parentId,
  );

  return {
    id,
    title: input.title,
    content: input.content,
    tags: input.tags,
    origin: input.origin,
    allowed_vendors: input.allowed_vendors,
    memory_type: memoryType,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    shared_with_org_id: parent.shared_with_org_id,
    shared_at: parent.shared_with_org_id ? now : null,
    parent_memory_id: parentId,
  };
}

/**
 * List children of a parent memory, oldest-first. Excludes soft-deleted.
 *
 * Visibility model:
 *   - If the caller owns the parent → see ALL children regardless of author.
 *   - If the parent is shared with the caller's team → see ALL children
 *     (any team member can read every reply in the thread).
 *   - Otherwise → empty list.
 *
 * The caller is expected to have already verified read access on the parent
 * (e.g. via readMemoryById or shared_with_org_id check). This function does
 * its own check too as defense-in-depth.
 */
export function listChildren(
  db: Database.Database,
  userId: string,
  parentId: string,
): MemoryEntry[] {
  const parent = db
    .prepare(
      `SELECT user_id, shared_with_org_id FROM memories WHERE id = ?`,
    )
    .get(parentId) as
    | { user_id: string; shared_with_org_id: string | null }
    | undefined;
  if (!parent) return [];

  let visible = parent.user_id === userId;
  if (!visible && parent.shared_with_org_id) {
    const callerTeamId = getUserTeamIdInternal(db, userId);
    visible =
      callerTeamId !== null && parent.shared_with_org_id === callerTeamId;
  }
  if (!visible) return [];

  const rows = db
    .prepare(
      `SELECT ${COLUMNS_ALIASED}
       FROM memories m
       WHERE m.parent_memory_id = ? AND m.deleted_at IS NULL
       ORDER BY m.created_at ASC, m.id ASC`,
    )
    .all(parentId) as MemoryRow[];
  return rows.map(rowToMemory);
}

/**
 * Soft-delete cascade: trash the parent's children along with it.
 *
 * Multi-author scope: only the CALLER's own children are moved to trash.
 * Teammates' replies on a shared thread stay intact in their own personal
 * pool — destroying their work just because their thread parent was trashed
 * would be surprising and they'd have no way to restore it (only the author
 * of a memory can restore it).
 *
 * Returns the IDs of children actually trashed (caller-owned, non-trashed).
 * Caller is expected to have already trashed the parent.
 */
export function cascadeSoftDelete(
  db: Database.Database,
  userId: string,
  parentId: string,
): string[] {
  const now = new Date().toISOString();
  const childIds = db
    .prepare(
      `SELECT id FROM memories
       WHERE parent_memory_id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .all(parentId, userId)
    .map((r) => (r as { id: string }).id);

  for (const id of childIds) {
    db.prepare(
      `UPDATE memories SET deleted_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    ).run(now, now, id, userId);
  }
  return childIds;
}

/**
 * Restore cascade: un-trash the parent's children. Caller-scoped (only the
 * caller's own children come back; teammates were never trashed).
 *
 * Returns restored child IDs. Caller is expected to have already restored
 * the parent.
 */
export function cascadeRestore(
  db: Database.Database,
  userId: string,
  parentId: string,
): string[] {
  const now = new Date().toISOString();
  const childIds = db
    .prepare(
      `SELECT id FROM memories
       WHERE parent_memory_id = ? AND user_id = ? AND deleted_at IS NOT NULL`,
    )
    .all(parentId, userId)
    .map((r) => (r as { id: string }).id);

  for (const id of childIds) {
    db.prepare(
      `UPDATE memories SET deleted_at = NULL, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ).run(now, id, userId);
  }
  return childIds;
}

/**
 * Hard-delete cascade: prepare children for the parent's permanent deletion.
 *
 *   - The CALLER's own children are purged (rows + version history) — same
 *     as before.
 *   - Teammates' children are ORPHANED (parent_memory_id set to NULL) so the
 *     parent's `DELETE FROM memories` doesn't fail on the FK constraint.
 *     The teammate's reply is preserved in their personal pool but no longer
 *     belongs to a thread (the thread no longer exists). Marker: their
 *     row's `updated_at` advances so SSE consumers see the change.
 *
 * Returns:
 *   { purged: string[], orphaned: string[] }
 *
 * Caller is expected to call this BEFORE purging the parent — orphaning
 * teammates' children must happen inside the same transaction window so
 * the parent's FK is satisfied at the moment of deletion.
 */
export function cascadeHardDelete(
  db: Database.Database,
  userId: string,
  parentId: string,
): { purged: string[]; orphaned: string[] } {
  const now = new Date().toISOString();
  const allChildren = db
    .prepare(
      `SELECT id, user_id FROM memories WHERE parent_memory_id = ?`,
    )
    .all(parentId) as { id: string; user_id: string }[];

  const purged: string[] = [];
  const orphaned: string[] = [];

  for (const c of allChildren) {
    if (c.user_id === userId) {
      db.prepare(`DELETE FROM memory_versions WHERE memory_id = ?`).run(c.id);
      db.prepare(`DELETE FROM memories WHERE id = ?`).run(c.id);
      purged.push(c.id);
    } else {
      db.prepare(
        `UPDATE memories SET parent_memory_id = NULL, updated_at = ? WHERE id = ?`,
      ).run(now, c.id);
      orphaned.push(c.id);
    }
  }

  return { purged, orphaned };
}

/**
 * Share cascade: copy the parent's team scope down to ALL children of the
 * thread, regardless of author. The whole thread's visibility flips together
 * — if the parent is now in the team pool, every reply must be too, even
 * teammates' replies (which were already team-shared, since they inherited
 * sharing on creation; this is a no-op for them in the common path).
 *
 * Returns affected child IDs. Caller is expected to have already shared the
 * parent.
 */
export function cascadeShare(
  db: Database.Database,
  parentId: string,
  orgId: string,
): string[] {
  const now = new Date().toISOString();
  const childIds = db
    .prepare(
      `SELECT id FROM memories
       WHERE parent_memory_id = ?
         AND deleted_at IS NULL
         AND (shared_with_org_id IS NULL OR shared_with_org_id != ?)`,
    )
    .all(parentId, orgId)
    .map((r) => (r as { id: string }).id);

  for (const id of childIds) {
    db.prepare(
      `UPDATE memories
       SET shared_with_org_id = ?, shared_with_team_id = NULL,
           shared_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(orgId, now, now, id);
  }
  return childIds;
}

/**
 * Cascade-share at TEAM scope. Mirrors cascadeShare for org but applies
 * shared_with_team_id (and clears any prior org scope so the
 * mutually-exclusive invariant holds across the whole thread).
 */
export function cascadeShareToTeam(
  db: Database.Database,
  parentId: string,
  teamId: string,
): string[] {
  const now = new Date().toISOString();
  const childIds = db
    .prepare(
      `SELECT id FROM memories
       WHERE parent_memory_id = ?
         AND deleted_at IS NULL
         AND (shared_with_team_id IS NULL OR shared_with_team_id != ?)`,
    )
    .all(parentId, teamId)
    .map((r) => (r as { id: string }).id);

  for (const id of childIds) {
    db.prepare(
      `UPDATE memories
       SET shared_with_team_id = ?, shared_with_org_id = NULL,
           shared_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(teamId, now, now, id);
  }
  return childIds;
}

/**
 * Unshare cascade: clear the team scope on ALL children of the thread,
 * regardless of author. Whole thread becomes private to each child's owner
 * (children stay owned by their original authors; only their team visibility
 * flips off).
 *
 * Returns child IDs. Caller is expected to have already unshared the parent.
 */
export function cascadeUnshare(
  db: Database.Database,
  parentId: string,
): string[] {
  const now = new Date().toISOString();
  // Clears whichever scope is set on each child (org OR team — they're
  // mutually exclusive so at most one is populated).
  const childIds = db
    .prepare(
      `SELECT id FROM memories
       WHERE parent_memory_id = ?
         AND (shared_with_org_id IS NOT NULL OR shared_with_team_id IS NOT NULL)`,
    )
    .all(parentId)
    .map((r) => (r as { id: string }).id);

  for (const id of childIds) {
    db.prepare(
      `UPDATE memories
       SET shared_with_org_id = NULL, shared_with_team_id = NULL,
           shared_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(now, id);
  }
  return childIds;
}

// ---------------------------------------------------------------------------
// Team memory functions
// ---------------------------------------------------------------------------

/**
 * Share a memory at the ORG scope. Mutually exclusive with team scope —
 * if the memory was team-shared, the team scope is cleared as part of
 * the same UPDATE so we never end up with both fields set (per D2 in
 * docs/eng-plan-orgs-and-teams-v1.md).
 */
export function shareMemoryToOrg(
  db: Database.Database,
  memoryId: string,
  userId: string,
  orgId: string,
): MemoryEntry | null {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE memories
       SET shared_with_org_id = ?, shared_with_team_id = NULL,
           shared_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .run(orgId, now, now, memoryId, userId);
  if (result.changes === 0) return null;
  return readMemoryById(db, userId, memoryId);
}

/**
 * Share a memory at the TEAM scope. Mutually exclusive with org scope —
 * promoting from team to org clears team_id; demoting from org to team
 * clears org_id. Caller must have verified the user is a member of the
 * given team (or the team is in the user's org).
 */
export function shareMemoryToTeam(
  db: Database.Database,
  memoryId: string,
  userId: string,
  teamId: string,
): MemoryEntry | null {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE memories
       SET shared_with_team_id = ?, shared_with_org_id = NULL,
           shared_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .run(teamId, now, now, memoryId, userId);
  if (result.changes === 0) return null;
  return readMemoryById(db, userId, memoryId);
}

/**
 * Clear ANY share scope on a memory (whether org or team). Used by the
 * dashboard's Unshare button + when a memory is being deleted.
 */
export function unshareMemory(
  db: Database.Database,
  memoryId: string,
  userId: string,
): MemoryEntry | null {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE memories
       SET shared_with_org_id = NULL, shared_with_team_id = NULL,
           shared_at = NULL, updated_at = ?
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .run(now, memoryId, userId);
  if (result.changes === 0) return null;
  return readMemoryById(db, userId, memoryId);
}

export interface TeamMemoryEntry extends MemoryEntry {
  author_email: string;
  author_first_name: string | null;
  author_last_name: string | null;
  shared_at: string | null;
}

export function listOrgMemories(
  db: Database.Database,
  orgId: string,
  pagination?: PaginationOptions,
): TeamMemoryEntry[] {
  const { sql: pagSql, params: pagParams } = buildPaginationClause(pagination);
  const rows = db
    .prepare(
      `SELECT ${COLUMNS_ALIASED}, u.email AS author_email, u.first_name AS author_first_name,
              u.last_name AS author_last_name, m.shared_at
       FROM memories m
       JOIN users u ON u.id = m.user_id
       WHERE m.shared_with_org_id = ? AND m.deleted_at IS NULL
       ORDER BY m.shared_at DESC, m.created_at DESC${pagSql}`,
    )
    .all(orgId, ...pagParams) as (MemoryRow & {
      author_email: string;
      author_first_name: string | null;
      author_last_name: string | null;
      shared_at: string | null;
    })[];

  return rows.map((row) => ({
    ...rowToMemory(row),
    author_email: row.author_email,
    author_first_name: row.author_first_name,
    author_last_name: row.author_last_name,
    shared_at: row.shared_at,
  }));
}

export function countOrgMemories(
  db: Database.Database,
  orgId: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM memories
       WHERE deleted_at IS NULL
         AND user_id IN (SELECT id FROM users WHERE org_id = ?)`,
    )
    .get(orgId) as { cnt: number };
  return row.cnt;
}

/**
 * List sub-team-shared memories. Mirrors listOrgMemories but on
 * shared_with_team_id. Returns the same enriched shape (author + shared_at)
 * so the dashboard can pipe through one renderer.
 */
export function listTeamMemories(
  db: Database.Database,
  teamId: string,
  pagination?: PaginationOptions,
): TeamMemoryEntry[] {
  const { sql: pagSql, params: pagParams } = buildPaginationClause(pagination);
  const rows = db
    .prepare(
      `SELECT ${COLUMNS_ALIASED}, u.email AS author_email, u.first_name AS author_first_name,
              u.last_name AS author_last_name, m.shared_at
       FROM memories m
       JOIN users u ON u.id = m.user_id
       WHERE m.shared_with_team_id = ? AND m.deleted_at IS NULL
       ORDER BY m.shared_at DESC, m.created_at DESC${pagSql}`,
    )
    .all(teamId, ...pagParams) as (MemoryRow & {
      author_email: string;
      author_first_name: string | null;
      author_last_name: string | null;
      shared_at: string | null;
    })[];

  return rows.map((row) => ({
    ...rowToMemory(row),
    author_email: row.author_email,
    author_first_name: row.author_first_name,
    author_last_name: row.author_last_name,
    shared_at: row.shared_at,
  }));
}

export function countTeamMemories(
  db: Database.Database,
  teamId: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM memories
       WHERE shared_with_team_id = ? AND deleted_at IS NULL`,
    )
    .get(teamId) as { cnt: number };
  return row.cnt;
}

/**
 * Full-text-ish search across the sub-team-shared pool. Mirrors
 * searchOrgMemories on shared_with_team_id. Same match axes (title,
 * content, tags, author identity), same case-insensitivity, same shape.
 */
export function searchTeamMemories(
  db: Database.Database,
  teamId: string,
  term: string,
  pagination?: PaginationOptions,
): TeamMemoryEntry[] {
  const { sql: pagSql, params: pagParams } = buildPaginationClause(pagination);
  const likeTerm = `%${escapeLike(term)}%`;
  const rows = db
    .prepare(
      `SELECT ${COLUMNS_ALIASED}, u.email AS author_email, u.first_name AS author_first_name,
              u.last_name AS author_last_name, m.shared_at
       FROM memories m
       JOIN users u ON u.id = m.user_id
       WHERE m.shared_with_team_id = ? AND m.deleted_at IS NULL
         AND (
              m.title LIKE ? ESCAPE '\\'
           OR m.content LIKE ? ESCAPE '\\'
           OR m.tags LIKE ? ESCAPE '\\'
           OR u.email LIKE ? ESCAPE '\\'
           OR u.first_name LIKE ? ESCAPE '\\'
           OR u.last_name LIKE ? ESCAPE '\\'
         )
       ORDER BY m.shared_at DESC, m.created_at DESC${pagSql}`,
    )
    .all(
      teamId,
      likeTerm,
      likeTerm,
      likeTerm,
      likeTerm,
      likeTerm,
      likeTerm,
      ...pagParams,
    ) as (MemoryRow & {
      author_email: string;
      author_first_name: string | null;
      author_last_name: string | null;
      shared_at: string | null;
    })[];

  return rows.map((row) => ({
    ...rowToMemory(row),
    author_email: row.author_email,
    author_first_name: row.author_first_name,
    author_last_name: row.author_last_name,
    shared_at: row.shared_at,
  }));
}

export function countSearchTeamMemories(
  db: Database.Database,
  teamId: string,
  term: string,
): number {
  const likeTerm = `%${escapeLike(term)}%`;
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt
       FROM memories m
       JOIN users u ON u.id = m.user_id
       WHERE m.shared_with_team_id = ? AND m.deleted_at IS NULL
         AND (
              m.title LIKE ? ESCAPE '\\'
           OR m.content LIKE ? ESCAPE '\\'
           OR m.tags LIKE ? ESCAPE '\\'
           OR u.email LIKE ? ESCAPE '\\'
           OR u.first_name LIKE ? ESCAPE '\\'
           OR u.last_name LIKE ? ESCAPE '\\'
         )`,
    )
    .get(teamId, likeTerm, likeTerm, likeTerm, likeTerm, likeTerm, likeTerm) as {
      cnt: number;
    };
  return row.cnt;
}

/**
 * Full-text-ish search across the Team Shared pool. Case-insensitive LIKE
 * across title, content, tags (JSON TEXT column, substring match), and
 * author identity (email, first_name, last_name). Matches listOrgMemories
 * column + ordering contract so the dashboard can pipe results directly
 * through the same renderer.
 *
 * Trim and reject empty terms at the caller; this function assumes a
 * non-empty term.
 */
export function searchOrgMemories(
  db: Database.Database,
  orgId: string,
  term: string,
  pagination?: PaginationOptions,
): TeamMemoryEntry[] {
  const { sql: pagSql, params: pagParams } = buildPaginationClause(pagination);
  const likeTerm = `%${escapeLike(term)}%`;
  const rows = db
    .prepare(
      `SELECT ${COLUMNS_ALIASED}, u.email AS author_email, u.first_name AS author_first_name,
              u.last_name AS author_last_name, m.shared_at
       FROM memories m
       JOIN users u ON u.id = m.user_id
       WHERE m.shared_with_org_id = ? AND m.deleted_at IS NULL
         AND (
              m.title LIKE ? ESCAPE '\\'
           OR m.content LIKE ? ESCAPE '\\'
           OR m.tags LIKE ? ESCAPE '\\'
           OR u.email LIKE ? ESCAPE '\\'
           OR u.first_name LIKE ? ESCAPE '\\'
           OR u.last_name LIKE ? ESCAPE '\\'
         )
       ORDER BY m.shared_at DESC, m.created_at DESC${pagSql}`,
    )
    .all(
      orgId,
      likeTerm,
      likeTerm,
      likeTerm,
      likeTerm,
      likeTerm,
      likeTerm,
      ...pagParams,
    ) as (MemoryRow & {
      author_email: string;
      author_first_name: string | null;
      author_last_name: string | null;
      shared_at: string | null;
    })[];

  return rows.map((row) => ({
    ...rowToMemory(row),
    author_email: row.author_email,
    author_first_name: row.author_first_name,
    author_last_name: row.author_last_name,
    shared_at: row.shared_at,
  }));
}

/** Count matches for the same filter as searchOrgMemories. */
export function countSearchOrgMemories(
  db: Database.Database,
  orgId: string,
  term: string,
): number {
  const likeTerm = `%${escapeLike(term)}%`;
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt
       FROM memories m
       JOIN users u ON u.id = m.user_id
       WHERE m.shared_with_org_id = ? AND m.deleted_at IS NULL
         AND (
              m.title LIKE ? ESCAPE '\\'
           OR m.content LIKE ? ESCAPE '\\'
           OR m.tags LIKE ? ESCAPE '\\'
           OR u.email LIKE ? ESCAPE '\\'
           OR u.first_name LIKE ? ESCAPE '\\'
           OR u.last_name LIKE ? ESCAPE '\\'
         )`,
    )
    .get(orgId, likeTerm, likeTerm, likeTerm, likeTerm, likeTerm, likeTerm) as {
      cnt: number;
    };
  return row.cnt;
}

export interface MemoryVersion {
  id: string;
  memory_id: string;
  title: string;
  content: string;
  tags: string[];
  origin: string;
  allowed_vendors: string[];
  memory_type: MemoryType;
  version_number: number;
  created_at: string;
}

export function getVersionHistory(
  db: Database.Database,
  userId: string,
  memoryId: string,
): MemoryVersion[] {
  const owner = db
    .prepare(`SELECT id FROM memories WHERE id = ? AND user_id = ?`)
    .get(memoryId, userId);
  if (!owner) return [];

  const rows = db
    .prepare(
      `SELECT id, memory_id, title, content, tags, memory_type, origin, allowed_vendors, version_number, created_at
       FROM memory_versions
       WHERE memory_id = ?
       ORDER BY version_number DESC`,
    )
    .all(memoryId) as Array<Record<string, string | number>>;

  return rows.map((row) => ({
    id: row.id as string,
    memory_id: row.memory_id as string,
    title: row.title as string,
    content: row.content as string,
    tags: safeJsonArray(row.tags as string),
    origin: row.origin as string,
    allowed_vendors: safeJsonArray(row.allowed_vendors as string),
    memory_type: (row.memory_type as MemoryType) || "semantic",
    version_number: row.version_number as number,
    created_at: row.created_at as string,
  }));
}
