// Memory graph helpers: pure SQL projections over the edges that already
// exist in the schema (parent_memory_id, shared_with_org_id, tags JSON
// array, content references). No new tables — the graph is "implicit"
// in the existing data; these functions just expose it as graph shapes.
//
// Backed by recursive CTEs and json_each scans over the memories table;
// designed to be cheap to call per-memory or per-briefing-build at our
// scale (~hundreds-low-thousands of memories per user). Larger corpora
// would want a materialised memory_edges table (Phase 2 of the plan).

import type Database from "better-sqlite3";

// ---------------------------------------------------------------- types

export interface GraphMemory {
  id: string;
  title: string;
  tags: string[];
  user_id: string;
  shared_with_org_id: string | null;
  parent_memory_id: string | null;
  created_at: string;
  /** Why we surfaced this memory in the response. */
  relation: GraphRelation;
}

export type GraphRelation =
  | "self"
  | "parent" // the memory's parent (if any)
  | "child" // a reply to the memory
  | "sibling" // shares the same parent
  | "tag_similar" // shares >= K tags
  | "references" // mentions this memory's id in content/tags
  | "referenced_by"; // this memory mentions the target

export interface GraphAround {
  center: GraphMemory;
  parent: GraphMemory | null;
  children: GraphMemory[];
  siblings: GraphMemory[];
  tag_similar: Array<GraphMemory & { shared_tag_count: number }>;
  references: GraphMemory[]; // memories THIS one mentions
  referenced_by: GraphMemory[]; // memories that mention this one
}

export interface TagCooccurrenceRow {
  tag_a: string;
  tag_b: string;
  count: number;
}

export interface TagCooccurrenceOptions {
  /** Per-user pool ('personal') or team-shared pool ('team'). */
  scope: "personal" | "team";
  userId: string;
  orgId?: string | null;
  /** Drop pairs with count below this threshold. Default 1. */
  minCount?: number;
  /** Drop tags appearing on fewer memories than this. Default 1. */
  minTagFrequency?: number;
}

// ---------------------------------------------------------------- helpers

interface MemoryRow {
  id: string;
  title: string;
  tags: string;
  user_id: string;
  shared_with_org_id: string | null;
  parent_memory_id: string | null;
  created_at: string;
}

function rowToGraphMemory(row: MemoryRow, relation: GraphRelation): GraphMemory {
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags) as string[];
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    title: row.title,
    tags,
    user_id: row.user_id,
    shared_with_org_id: row.shared_with_org_id,
    parent_memory_id: row.parent_memory_id,
    created_at: row.created_at,
    relation,
  };
}

// Always qualified with `m.` to avoid `ambiguous column name` collisions
// when joined with json_each (which itself exposes `id`/`key`/`value`).
const COLS =
  "m.id AS id, m.title AS title, m.tags AS tags, m.user_id AS user_id, " +
  "m.shared_with_org_id AS shared_with_org_id, " +
  "m.parent_memory_id AS parent_memory_id, m.created_at AS created_at";

/**
 * Resolve the calling user's org_id (or null). Internal — many graph
 * queries need to honour team-shared visibility.
 */
function getUserTeamId(db: Database.Database, userId: string): string | null {
  const row = db
    .prepare("SELECT org_id FROM users WHERE id = ?")
    .get(userId) as { org_id: string | null } | undefined;
  return row?.org_id ?? null;
}

/**
 * SQL fragment that constrains a memories query to the rows the caller
 * can read (own + team-shared). Use as `WHERE m.deleted_at IS NULL AND ${visibilitySql("m")}`
 * with the bound params [userId, orgId ?? ''].
 */
function visibilitySql(alias: string): string {
  return `(${alias}.user_id = ? OR ${alias}.shared_with_org_id = COALESCE(?, ''))`;
}

// ---------------------------------------------------------------- backlinks

/**
 * Find memories that reference the target by:
 *   1. parent_memory_id (children point at this memory)
 *   2. content scan: the target's UUID appears verbatim in another
 *      memory's content
 *   3. tag scan: the target's first 8 chars appear as a `ref_<id>` tag
 *      on another memory (legacy tagging convention from before
 *      threading)
 *
 * Returns memories the caller can see (own + team-shared). De-duped if
 * a memory matches via multiple paths — the strongest relation wins
 * (child > references > tag-ref).
 */
export function getBacklinks(
  db: Database.Database,
  userId: string,
  memoryId: string,
): GraphMemory[] {
  const orgId = getUserTeamId(db, userId);
  const teamArg = orgId ?? "";
  const seen = new Map<string, GraphMemory>();

  // Children via parent_memory_id (strongest signal).
  const childRows = db
    .prepare(
      `SELECT ${COLS} FROM memories m
       WHERE m.parent_memory_id = ?
         AND m.deleted_at IS NULL
         AND ${visibilitySql("m")}
       ORDER BY m.created_at ASC`,
    )
    .all(memoryId, userId, teamArg) as MemoryRow[];
  for (const r of childRows) seen.set(r.id, rowToGraphMemory(r, "child"));

  // Content references: another memory's content mentions this id.
  // Cheap LIKE scan, could be slow on huge corpora; fine at our scale.
  const contentRows = db
    .prepare(
      `SELECT ${COLS} FROM memories m
       WHERE m.id != ?
         AND m.content LIKE ?
         AND m.deleted_at IS NULL
         AND ${visibilitySql("m")}`,
    )
    .all(memoryId, `%${memoryId}%`, userId, teamArg) as MemoryRow[];
  for (const r of contentRows) {
    if (!seen.has(r.id)) seen.set(r.id, rowToGraphMemory(r, "references"));
  }

  // Tag references: ref_<first-8> pattern (legacy).
  const refTag = `ref_${memoryId.slice(0, 8)}`;
  const tagRows = db
    .prepare(
      `SELECT DISTINCT ${COLS}
       FROM memories m, json_each(m.tags) t
       WHERE m.id != ?
         AND m.deleted_at IS NULL
         AND t.value = ?
         AND ${visibilitySql("m")}`,
    )
    .all(memoryId, refTag, userId, teamArg) as MemoryRow[];
  for (const r of tagRows) {
    if (!seen.has(r.id)) seen.set(r.id, rowToGraphMemory(r, "references"));
  }

  return Array.from(seen.values());
}

// ---------------------------------------------------------------- graph around

/**
 * Local graph around a memory. Returns the center memory plus its parent,
 * children, siblings, tag-similar memories, and bidirectional content
 * references. Visibility-scoped to the caller (own + team-shared only).
 *
 * `tag_similar` is rate-limited to top N by shared-tag count, with at
 * least K tags shared. Defaults: K=2 shared tags, top N=5.
 *
 * Returns null if the center memory doesn't exist or the caller can't
 * see it.
 */
export interface GetGraphAroundOptions {
  /** Min shared tags to count as tag-similar. Default 2. */
  minSharedTags?: number;
  /** Max tag-similar memories to return. Default 5. */
  topTagSimilar?: number;
}

export function getGraphAround(
  db: Database.Database,
  userId: string,
  memoryId: string,
  opts: GetGraphAroundOptions = {},
): GraphAround | null {
  const minSharedTags = opts.minSharedTags ?? 2;
  const topTagSimilar = opts.topTagSimilar ?? 5;
  const orgId = getUserTeamId(db, userId);
  const teamArg = orgId ?? "";

  const centerRow = db
    .prepare(
      `SELECT ${COLS} FROM memories m
       WHERE m.id = ?
         AND m.deleted_at IS NULL
         AND ${visibilitySql("m")}`,
    )
    .get(memoryId, userId, teamArg) as MemoryRow | undefined;
  if (!centerRow) return null;
  const center = rowToGraphMemory(centerRow, "self");

  // Parent.
  let parent: GraphMemory | null = null;
  if (centerRow.parent_memory_id) {
    const parentRow = db
      .prepare(
        `SELECT ${COLS} FROM memories m
         WHERE m.id = ?
           AND m.deleted_at IS NULL
           AND ${visibilitySql("m")}`,
      )
      .get(centerRow.parent_memory_id, userId, teamArg) as MemoryRow | undefined;
    if (parentRow) parent = rowToGraphMemory(parentRow, "parent");
  }

  // Children: anyone with parent_memory_id == this id.
  const childRows = db
    .prepare(
      `SELECT ${COLS} FROM memories m
       WHERE m.parent_memory_id = ?
         AND m.deleted_at IS NULL
         AND ${visibilitySql("m")}
       ORDER BY m.created_at ASC`,
    )
    .all(memoryId, userId, teamArg) as MemoryRow[];
  const children = childRows.map((r) => rowToGraphMemory(r, "child"));

  // Siblings: same parent (only meaningful if center is a child).
  let siblings: GraphMemory[] = [];
  if (centerRow.parent_memory_id) {
    const siblingRows = db
      .prepare(
        `SELECT ${COLS} FROM memories m
         WHERE m.parent_memory_id = ?
           AND m.id != ?
           AND m.deleted_at IS NULL
           AND ${visibilitySql("m")}
         ORDER BY m.created_at ASC`,
      )
      .all(centerRow.parent_memory_id, memoryId, userId, teamArg) as MemoryRow[];
    siblings = siblingRows.map((r) => rowToGraphMemory(r, "sibling"));
  }

  // Tag-similar: shares >= K tags. Computed via json_each unnest on both
  // sides, joined on tag value, grouped by candidate id.
  let tag_similar: Array<GraphMemory & { shared_tag_count: number }> = [];
  if (center.tags.length > 0) {
    const tagsJson = JSON.stringify(center.tags);
    const candidates = db
      .prepare(
        `SELECT ${COLS}, COUNT(*) AS shared
         FROM memories m, json_each(m.tags) t
         WHERE m.id != ?
           AND m.deleted_at IS NULL
           AND ${visibilitySql("m")}
           AND t.value IN (SELECT value FROM json_each(?))
         GROUP BY m.id
         HAVING shared >= ?
         ORDER BY shared DESC, m.created_at DESC
         LIMIT ?`,
      )
      .all(memoryId, userId, teamArg, tagsJson, minSharedTags, topTagSimilar) as Array<
      MemoryRow & { shared: number }
    >;
    tag_similar = candidates.map((c) => ({
      ...rowToGraphMemory(c, "tag_similar"),
      shared_tag_count: c.shared,
    }));
  }

  // References + referenced-by.
  const referenced_by = getBacklinks(db, userId, memoryId);

  // What does the center memory reference? Look in its own content for
  // any other memory id the caller can see. Cheap: get all visible ids,
  // then test substring.
  const allVisible = db
    .prepare(
      `SELECT ${COLS} FROM memories m
       WHERE m.id != ?
         AND m.deleted_at IS NULL
         AND ${visibilitySql("m")}`,
    )
    .all(memoryId, userId, teamArg) as MemoryRow[];
  const centerContent = (
    db.prepare(`SELECT content FROM memories WHERE id = ?`).get(memoryId) as
      | { content: string }
      | undefined
  )?.content ?? "";
  const references = allVisible
    .filter((r) => centerContent.includes(r.id))
    .map((r) => rowToGraphMemory(r, "references"));

  return { center, parent, children, siblings, tag_similar, references, referenced_by };
}

// ---------------------------------------------------------------- tag co-occurrence

/**
 * Build the tag co-occurrence graph for clustering. Returns one row per
 * unordered tag pair (a < b) with the count of memories where both tags
 * appear together. Also returns single-tag memberships for clustering
 * algorithms that need vertex weights.
 *
 * Scope:
 *   - "personal": memories owned by userId (incl. shared)
 *   - "team": memories shared with the team (regardless of author)
 *
 * The pairs are emitted only once per (a,b) with a < b lexicographically
 * to avoid double-counting and to make the output stable.
 */
export function getTagCooccurrence(
  db: Database.Database,
  opts: TagCooccurrenceOptions,
): { pairs: TagCooccurrenceRow[]; tagFrequencies: Map<string, number> } {
  const minCount = opts.minCount ?? 1;
  const minFreq = opts.minTagFrequency ?? 1;

  // Build the visibility scope clause.
  let scopeClause: string;
  let scopeArgs: unknown[];
  if (opts.scope === "personal") {
    scopeClause = `m.user_id = ?`;
    scopeArgs = [opts.userId];
  } else {
    if (!opts.orgId) {
      // No team → empty result for team scope.
      return { pairs: [], tagFrequencies: new Map() };
    }
    scopeClause = `m.shared_with_org_id = ?`;
    scopeArgs = [opts.orgId];
  }

  // Per-tag frequency (how many memories carry each tag in scope).
  const freqRows = db
    .prepare(
      `SELECT t.value AS tag, COUNT(DISTINCT m.id) AS n
       FROM memories m, json_each(m.tags) t
       WHERE m.deleted_at IS NULL AND ${scopeClause}
       GROUP BY t.value
       HAVING n >= ?`,
    )
    .all(...scopeArgs, minFreq) as { tag: string; n: number }[];
  const tagFrequencies = new Map(freqRows.map((r) => [r.tag, r.n]));

  // Pair counts: self-join on json_each, keep only a < b to dedupe pairs.
  const pairRows = db
    .prepare(
      `SELECT a.value AS tag_a, b.value AS tag_b, COUNT(DISTINCT m.id) AS n
       FROM memories m, json_each(m.tags) a, json_each(m.tags) b
       WHERE m.deleted_at IS NULL AND ${scopeClause}
         AND a.value < b.value
       GROUP BY a.value, b.value
       HAVING n >= ?`,
    )
    .all(...scopeArgs, minCount) as { tag_a: string; tag_b: string; n: number }[];

  // Filter out pairs where either tag falls below the frequency floor.
  const pairs: TagCooccurrenceRow[] = pairRows
    .filter((p) => tagFrequencies.has(p.tag_a) && tagFrequencies.has(p.tag_b))
    .map((p) => ({ tag_a: p.tag_a, tag_b: p.tag_b, count: p.n }));

  return { pairs, tagFrequencies };
}
