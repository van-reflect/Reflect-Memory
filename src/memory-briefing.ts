// Memory briefing: condensed, structured first-contact context for MCP clients.
//
// The MCP `initialize` handshake lets the server hand a free-form `instructions`
// string to the client. Historically we sent nothing. This module builds a
// compact "mindmap" of the user's memory state (identity, tag index, recency,
// open threads, detected conventions, named topic clusters) so a connecting
// LLM can orient itself without burning tool calls.
//
// Also exposed via an HTTP route and an MCP tool so clients can refresh
// mid-session.
//
// v2 (2026-04-23): added topic_clusters — Louvain over tag co-occurrence,
// names cached via cluster-naming. Optional to keep backwards compat: gated
// on opts.enableTopicClusters. When enabled, briefing build becomes async
// (cluster naming may call the LLM if cache misses).

import type Database from "better-sqlite3";
import { getTagCooccurrence } from "./memory-graph.js";
import { clusterTags, type TagCluster } from "./tag-clustering.js";
import { nameClusters, type NamedCluster } from "./cluster-naming.js";

export interface TagCount {
  tag: string;
  count: number;
}

export interface ActiveThread {
  memory_id: string;
  title: string;
  reply_count: number;
  last_activity_at: string;
  shared_with_team: boolean;
}

export interface UserSummary {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  role: string | null;
  plan: string | null;
  org_id: string | null;
  team_name: string | null;
  org_role: string | null;
  team_member_count: number;
}

export interface BriefingTotals {
  personal_memories: number;
  personal_memories_shared: number;
  team_pool_total: number;
}

export interface TopicCluster {
  /** LLM-named topic, e.g. "Auth & MCP Engineering". Stable per cluster_hash. */
  name: string;
  /** One-liner explaining what the cluster is about. */
  description: string;
  /** Member tags, alphabetical. */
  tags: string[];
  /** Total memories the cluster spans (sum of per-tag frequencies). */
  member_count: number;
  /** Cluster cohesion (sum of intra-cluster cooccurrence weights). */
  internal_weight: number;
  /** Stable hash of the sorted tag list — for cache lookups + UI keys. */
  cluster_hash: string;
  /** Scope this cluster came from. */
  scope: "personal" | "team";
}

export interface MemoryBriefing {
  user: UserSummary;
  totals: BriefingTotals;
  personal_tags: TagCount[];
  team_tags: TagCount[];
  recent_tags: TagCount[];
  active_threads: ActiveThread[];
  detected_conventions: string[];
  /**
   * v2: named topic clusters. Empty when clustering is disabled or the
   * corpus is too small to produce meaningful clusters.
   */
  topic_clusters: TopicCluster[];
  generated_at: string;
}

export interface BriefingOptions {
  topTagsN?: number;
  recencyDays?: number;
  activeThreadsN?: number;
  /**
   * v2: when true, run Louvain clustering over tag co-occurrence and ask
   * the LLM to name each cluster. Defaults to false to preserve sync
   * behavior for callers that haven't migrated. Adds ~50ms cold + LLM
   * call per missing cluster (cached for 24h thereafter).
   */
  enableTopicClusters?: boolean;
  /**
   * Min tags per cluster to surface. Default 3. Smaller → noisier; larger
   * → fewer surfaced topics.
   */
  minClusterSize?: number;
  /**
   * Anthropic API key for cluster naming. Falls back to ANTHROPIC_API_KEY
   * env var. Without one, clusters get fallback "tag/tag/tag" names.
   */
  anthropicKey?: string;
}

const DEFAULT_TOP_TAGS = 30;
const DEFAULT_RECENCY_DAYS = 7;
const DEFAULT_ACTIVE_THREADS = 5;
const DEFAULT_MIN_CLUSTER_SIZE = 3;

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function loadUserSummary(db: Database.Database, userId: string): UserSummary {
  const user = db
    .prepare(
      `SELECT id, email, first_name, last_name, role, plan, org_id, org_role
       FROM users WHERE id = ?`,
    )
    .get(userId) as
    | {
        id: string;
        email: string | null;
        first_name: string | null;
        last_name: string | null;
        role: string | null;
        plan: string | null;
        org_id: string | null;
        org_role: string | null;
      }
    | undefined;

  if (!user) {
    return {
      id: userId,
      email: null,
      first_name: null,
      last_name: null,
      role: null,
      plan: null,
      org_id: null,
      team_name: null,
      org_role: null,
      team_member_count: 0,
    };
  }

  let orgName: string | null = null;
  let teamMemberCount = 0;
  if (user.org_id) {
    const team = db
      .prepare(`SELECT name FROM orgs WHERE id = ?`)
      .get(user.org_id) as { name: string } | undefined;
    orgName = team?.name ?? null;
    teamMemberCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM users WHERE org_id = ?`).get(user.org_id) as {
        n: number;
      }
    ).n;
  }

  return {
    id: user.id,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    role: user.role,
    plan: user.plan,
    org_id: user.org_id,
    team_name: orgName,
    org_role: user.org_role,
    team_member_count: teamMemberCount,
  };
}

function loadTotals(
  db: Database.Database,
  userId: string,
  orgId: string | null,
): BriefingTotals {
  const personal = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND deleted_at IS NULL`)
      .get(userId) as { n: number }
  ).n;
  const personalShared = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM memories
         WHERE user_id = ? AND deleted_at IS NULL AND shared_with_org_id IS NOT NULL`,
      )
      .get(userId) as { n: number }
  ).n;
  let teamPoolTotal = 0;
  if (orgId) {
    teamPoolTotal = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM memories
           WHERE shared_with_org_id = ? AND deleted_at IS NULL`,
        )
        .get(orgId) as { n: number }
    ).n;
  }
  return {
    personal_memories: personal,
    personal_memories_shared: personalShared,
    team_pool_total: teamPoolTotal,
  };
}

function loadPersonalTags(
  db: Database.Database,
  userId: string,
  limit: number,
): TagCount[] {
  const rows = db
    .prepare(
      `SELECT t.value AS tag, COUNT(*) AS n
       FROM memories m, json_each(m.tags) t
       WHERE m.user_id = ? AND m.deleted_at IS NULL
       GROUP BY t.value
       ORDER BY n DESC, t.value ASC
       LIMIT ?`,
    )
    .all(userId, limit) as { tag: string; n: number }[];
  return rows.map((r) => ({ tag: r.tag, count: r.n }));
}

function loadTeamTags(
  db: Database.Database,
  orgId: string,
  limit: number,
): TagCount[] {
  const rows = db
    .prepare(
      `SELECT t.value AS tag, COUNT(*) AS n
       FROM memories m, json_each(m.tags) t
       WHERE m.shared_with_org_id = ? AND m.deleted_at IS NULL
       GROUP BY t.value
       ORDER BY n DESC, t.value ASC
       LIMIT ?`,
    )
    .all(orgId, limit) as { tag: string; n: number }[];
  return rows.map((r) => ({ tag: r.tag, count: r.n }));
}

function loadRecentTags(
  db: Database.Database,
  userId: string,
  orgId: string | null,
  days: number,
  limit: number,
): TagCount[] {
  const since = daysAgoIso(days);
  // Union of user's own + team-visible memories in window. COALESCE handles
  // orgId = null (SQLite won't match NULL = anything).
  const rows = db
    .prepare(
      `SELECT t.value AS tag, COUNT(DISTINCT m.id) AS n
       FROM memories m, json_each(m.tags) t
       WHERE m.deleted_at IS NULL
         AND m.created_at >= ?
         AND (m.user_id = ? OR m.shared_with_org_id = COALESCE(?, ''))
       GROUP BY t.value
       ORDER BY n DESC, t.value ASC
       LIMIT ?`,
    )
    .all(since, userId, orgId ?? "", limit) as { tag: string; n: number }[];
  return rows.map((r) => ({ tag: r.tag, count: r.n }));
}

function loadActiveThreads(
  db: Database.Database,
  userId: string,
  orgId: string | null,
  limit: number,
): ActiveThread[] {
  // Visibility model: a thread is "active" for the caller if
  //   (a) the caller owns the parent memory, OR
  //   (b) the parent memory is shared with the caller's team.
  // Without (b) a teammate would never see threads other team members
  // started in their briefing, so they couldn't reply to them. This
  // matched the single-author threading bug Van hit on 2026-04-22.
  // COALESCE on orgId so the OR clause doesn't match anything when
  // the caller has no team.
  const rows = db
    .prepare(
      `SELECT m.id, m.title, m.shared_with_org_id,
              (SELECT COUNT(*) FROM memories c
               WHERE c.parent_memory_id = m.id AND c.deleted_at IS NULL) AS reply_count,
              COALESCE(
                (SELECT MAX(c.updated_at) FROM memories c
                 WHERE c.parent_memory_id = m.id AND c.deleted_at IS NULL),
                m.updated_at
              ) AS last_activity_at
       FROM memories m
       WHERE m.parent_memory_id IS NULL
         AND m.deleted_at IS NULL
         AND (
           m.user_id = ?
           OR m.shared_with_org_id = COALESCE(?, '')
         )
       ORDER BY reply_count DESC, last_activity_at DESC
       LIMIT ?`,
    )
    .all(userId, orgId ?? "", limit) as {
      id: string;
      title: string;
      shared_with_org_id: string | null;
      reply_count: number;
      last_activity_at: string;
    }[];
  return rows
    .filter((r) => r.reply_count > 0)
    .map((r) => ({
      memory_id: r.id,
      title: r.title,
      reply_count: r.reply_count,
      last_activity_at: r.last_activity_at,
      shared_with_team: r.shared_with_org_id !== null,
    }));
}

/**
 * Zero-LLM heuristic detection of common tagging conventions the user/team
 * has established. Makes it easier for a connecting LLM to follow the same
 * patterns rather than invent new ones.
 */
function detectConventions(
  personalTags: TagCount[],
  teamTags: TagCount[],
): string[] {
  const allTags = new Map<string, number>();
  for (const { tag, count } of [...personalTags, ...teamTags]) {
    allTags.set(tag, (allTags.get(tag) ?? 0) + count);
  }
  const has = (t: string) => (allTags.get(t) ?? 0) > 0;
  const hasAtLeast = (t: string, n: number) => (allTags.get(t) ?? 0) >= n;

  const conventions: string[] = [];

  // Engineering ticket pattern: when `eng` is a top tag AND there are
  // multiple priority tags, surface the umbrella convention so the LLM
  // knows to apply `eng` (not just priority + area). Without this hint
  // models often file with priority + area but skip `eng`, which then
  // breaks the briefing's tag-clustering on subsequent sessions.
  const priorityTags = ["p0", "p1", "p2", "p3"].filter(has);
  if (has("eng") && priorityTags.length >= 2) {
    conventions.push(
      `**Engineering work always uses \`eng\` as the umbrella tag** + a priority (${priorityTags.join(", ")}) + an area (e.g. \`auth\`, \`dashboard\`, \`billing\`). Even when a memory falls inside an area-specific topic cluster (Dashboard, Billing, etc.), if it's an engineering ticket / bug / fix / shipped work, ALWAYS add \`eng\` on top of the area tags. The topic clusters reflect what \`s in the corpus, not what should be there — apply \`eng\` rigorously.`,
    );
  } else if (priorityTags.length >= 2) {
    conventions.push(
      `Tickets use priority tags (${priorityTags.join(", ")}). Match this when filing or resolving.`,
    );
  }

  const refTags = [...allTags.keys()].filter((t) => /^ref_[0-9a-f]{8}/i.test(t));
  if (refTags.length > 0) {
    conventions.push(
      `Some memories reference a parent ticket via \`ref_<id>\` tag (e.g. \`${refTags[0]}\`). Threading via parent_memory_id is preferred for replies; the tag pattern is legacy.`,
    );
  }

  if (has("eng") && has("resolved")) {
    conventions.push(
      "Engineering resolutions are tagged `eng` + `resolved` + `shipped` (+ often `ref_<id>`).",
    );
  }

  if (hasAtLeast("session_summary", 1)) {
    conventions.push(
      "Session summaries are parent memories tagged `session_summary`; per-session follow-ups are replies (children), not new top-level memories.",
    );
  }

  if (hasAtLeast("shipped", 3)) {
    conventions.push("Shipped work is tagged `shipped` for quick filtering.");
  }

  return conventions;
}

/**
 * Compute the full briefing structure (legacy sync — no topic clusters).
 *
 * For full v2 briefings including LLM-named topic clusters, use
 * `buildMemoryBriefingAsync(db, userId, { enableTopicClusters: true })`.
 *
 * This sync entry-point is preserved for callers that don't want async +
 * LLM cost. It always returns `topic_clusters: []`.
 */
export function buildMemoryBriefing(
  db: Database.Database,
  userId: string,
  opts: BriefingOptions = {},
): MemoryBriefing {
  return buildMemoryBriefingCore(db, userId, opts, []);
}

/**
 * Async briefing build. Identical to the sync version when
 * opts.enableTopicClusters is false. When enabled, runs Louvain over tag
 * co-occurrence and asks the LLM (or cache) for cluster names.
 *
 * Why async: cluster naming may call Anthropic's API on cache miss. We
 * never block the briefing on naming — failures fall back to "tag/tag/tag"
 * names so the rest of the briefing still ships.
 */
export async function buildMemoryBriefingAsync(
  db: Database.Database,
  userId: string,
  opts: BriefingOptions = {},
): Promise<MemoryBriefing> {
  const topicClusters = opts.enableTopicClusters
    ? await loadTopicClusters(db, userId, opts)
    : [];
  return buildMemoryBriefingCore(db, userId, opts, topicClusters);
}

function buildMemoryBriefingCore(
  db: Database.Database,
  userId: string,
  opts: BriefingOptions,
  topicClusters: TopicCluster[],
): MemoryBriefing {
  const topTagsN = opts.topTagsN ?? DEFAULT_TOP_TAGS;
  const recencyDays = opts.recencyDays ?? DEFAULT_RECENCY_DAYS;
  const activeThreadsN = opts.activeThreadsN ?? DEFAULT_ACTIVE_THREADS;

  const user = loadUserSummary(db, userId);
  const totals = loadTotals(db, userId, user.org_id);
  const personalTags = loadPersonalTags(db, userId, topTagsN);
  const teamTags = user.org_id
    ? loadTeamTags(db, user.org_id, topTagsN)
    : [];
  const recentTags = loadRecentTags(
    db,
    userId,
    user.org_id,
    recencyDays,
    topTagsN,
  );
  const activeThreads = loadActiveThreads(db, userId, user.org_id, activeThreadsN);
  const detectedConventions = detectConventions(personalTags, teamTags);

  return {
    user,
    totals,
    personal_tags: personalTags,
    team_tags: teamTags,
    recent_tags: recentTags,
    active_threads: activeThreads,
    detected_conventions: detectedConventions,
    topic_clusters: topicClusters,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Run Louvain clustering on tag co-occurrence for both personal and team
 * scopes, then resolve cluster names via cache + LLM. Failures fall back
 * to "tag/tag/tag" placeholder names so the briefing always renders.
 */
async function loadTopicClusters(
  db: Database.Database,
  userId: string,
  opts: BriefingOptions,
): Promise<TopicCluster[]> {
  const minSize = opts.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;
  const user = loadUserSummary(db, userId);

  const personalCo = getTagCooccurrence(db, { scope: "personal", userId });
  const personalClusters = clusterTags(personalCo.pairs, personalCo.tagFrequencies, {
    minClusterSize: minSize,
  });

  const teamCo = user.org_id
    ? getTagCooccurrence(db, {
        scope: "team",
        userId,
        orgId: user.org_id,
      })
    : { pairs: [], tagFrequencies: new Map<string, number>() };
  const teamClusters = clusterTags(teamCo.pairs, teamCo.tagFrequencies, {
    minClusterSize: minSize,
  });

  const [namedPersonal, namedTeam] = await Promise.all([
    nameClusters(db, userId, "personal", null, personalClusters, {
      anthropicKey: opts.anthropicKey,
    }),
    nameClusters(db, userId, "team", user.org_id, teamClusters, {
      anthropicKey: opts.anthropicKey,
    }),
  ]);

  const out: TopicCluster[] = [];
  for (const c of namedPersonal) out.push(toTopicCluster(c, "personal"));
  for (const c of namedTeam) out.push(toTopicCluster(c, "team"));
  // Sort by size+cohesion desc so the heaviest clusters render first.
  out.sort(
    (a, b) =>
      b.member_count + b.internal_weight - (a.member_count + a.internal_weight),
  );
  return out;
}

function toTopicCluster(c: NamedCluster, scope: "personal" | "team"): TopicCluster {
  return {
    name: c.name,
    description: c.description,
    tags: c.tags,
    member_count: c.size,
    internal_weight: c.internal_weight,
    cluster_hash: c.cluster_hash,
    scope,
  };
}

// Re-export for downstream tests that build TagCluster fixtures.
export type { TagCluster };

function renderTagList(tags: TagCount[]): string {
  if (tags.length === 0) return "_(none)_";
  return tags.map((t) => `\`${t.tag}\` (${t.count})`).join(" · ");
}

function formatUserLine(user: UserSummary): string {
  const displayName =
    [user.first_name, user.last_name].filter(Boolean).join(" ") ||
    user.email ||
    "(unknown user)";
  const teamPart = user.team_name
    ? ` · team **${user.team_name}** (${user.team_member_count} ${
        user.team_member_count === 1 ? "member" : "members"
      }, role: ${user.org_role ?? "member"})`
    : "";
  const rolePart = user.role && user.role !== "user" ? ` · role: ${user.role}` : "";
  return `**${displayName}**${user.email ? ` (${user.email})` : ""}${teamPart}${rolePart}`;
}

/**
 * Format the briefing as markdown suitable for the MCP `initialize.instructions`
 * field. Sized to be useful without being expensive — typical output is
 * ~1-3KB. A connecting LLM can parse sections visually without needing to
 * remember an exact schema.
 */
export function formatBriefingAsMarkdown(b: MemoryBriefing): string {
  const lines: string[] = [];

  lines.push("# Reflect Memory — session briefing");
  lines.push("");
  lines.push("You are connected to the user's personal memory system. What's below is");
  lines.push("a snapshot of the memory state at connect time so you can orient yourself");
  lines.push("without fishing with tool calls.");
  lines.push("");
  lines.push(`**User:** ${formatUserLine(b.user)}`);
  lines.push(
    `**Totals:** ${b.totals.personal_memories} personal memories (${b.totals.personal_memories_shared} shared with team) · ${b.totals.team_pool_total} in team pool`,
  );
  lines.push("");

  // Conventions FIRST (before the rest) so behavioral rules don't get lost
  // at the bottom of a long briefing. Detected from the user's actual tag
  // patterns; the model should follow these to keep the corpus consistent.
  if (b.detected_conventions.length > 0) {
    lines.push("## Conventions to follow");
    for (const c of b.detected_conventions) {
      lines.push(`- ${c}`);
    }
    lines.push("");
  }

  // Read-before-write guidance — applies to every memory the model
  // writes. The harness's avoid-duplication / cross-reference /
  // supersession scenarios all surfaced the same gap: models default to
  // writing without checking what's already in the corpus.
  lines.push("## Before you write");
  lines.push(
    "- **If the prompt's topic overlaps with anything in the topic map below or the open threads**, " +
      "use `search_memories` / `get_topic_cluster` / `read_thread` to check what's already recorded BEFORE writing. " +
      "This prevents duplicates and surfaces context you should reference or reply under.",
  );
  lines.push(
    "- **If the new memory updates, contradicts, or extends an existing memory**, link to it explicitly: " +
      "either `write_child_memory(parent_memory_id=…)` (best — preserves history) " +
      "or `write_memory` with the prior memory's full UUID in the content body.",
  );
  lines.push(
    "- **If the new memory is fresh + unrelated**, go ahead with `write_memory` — but match the tag vocabulary " +
      "from the topic clusters below (don't invent ad-hoc tags).",
  );
  if (b.user.org_id) {
    lines.push(
      "- **Personal vs team:** `write_memory` is personal-by-default. " +
        "If the user explicitly says \"save this for the team\", \"share with the team\", \"team note\", or similar, " +
        "set `share_with_team=true` on the same call (one tool call instead of two). " +
        "Otherwise leave it false — the user can always share later via the dashboard or `share_memory`. " +
        "When in doubt, default to personal.",
    );
  }
  lines.push("");

  // Topic map: render BEFORE the flat tag lists so the LLM sees the
  // structured clusters first (the map). The flat lists stay as a
  // fallback / detail view. Each cluster shows its name, description,
  // member count, and the tag list so the LLM knows what tags to use
  // when contributing to the cluster.
  if (b.topic_clusters.length > 0) {
    lines.push("## Topic map");
    lines.push(
      "_Topics are clusters of tags that frequently co-occur in this user's memories. " +
        "When writing a memory about one of these topics, prefer the cluster's tags " +
        "to keep the cluster cohesive._",
    );
    lines.push("");
    for (const t of b.topic_clusters) {
      const scopeBadge = t.scope === "team" ? " · _team_" : " · _personal_";
      lines.push(
        `- **${t.name}**${scopeBadge} — ${t.description} (${t.member_count} memories) · tags: ${t.tags.map((tag) => `\`${tag}\``).join(", ")}`,
      );
    }
    lines.push("");
  }

  lines.push("## Personal tags (top)");
  lines.push(renderTagList(b.personal_tags));
  lines.push("");

  if (b.user.org_id) {
    lines.push("## Team tags (top)");
    lines.push(renderTagList(b.team_tags));
    lines.push("");
  }

  lines.push(`## Active this week (last 7 days, personal + team)`);
  lines.push(renderTagList(b.recent_tags));
  lines.push("");

  if (b.active_threads.length > 0) {
    lines.push("## Current open threads");
    for (const t of b.active_threads) {
      const shared = t.shared_with_team ? " · shared" : "";
      // Full memory_id (not slice(0,8)) so an LLM can pass it directly
      // to write_child_memory without a round-trip to look up the full id.
      // The 8-char prefix was a humans-readable choice that broke LLM
      // navigation — see harness baseline 2026-04-23.
      lines.push(
        `- \`${t.memory_id}\` **${t.title}** — ${t.reply_count} ${
          t.reply_count === 1 ? "reply" : "replies"
        } · last activity ${t.last_activity_at}${shared}`,
      );
    }
    lines.push("");
    lines.push(
      "Reply to an open thread with `write_child_memory(parent_memory_id=…)` rather than creating a new top-level memory. " +
        "The IDs above are full UUIDs — pass them verbatim. " +
        "**Do NOT use `update_memory` to add a status update to a teammate's thread** — that overwrites their text. " +
        "Always reply with a child memory; it preserves history and threading.",
    );
    lines.push("");
  }

  // Conventions are now rendered near the top (after the user header)
  // so they don't get drowned out by the topic map / tag lists below.

  lines.push("## Refresh");
  lines.push(
    "This briefing is a snapshot at connect time. If you want a fresh one mid-session, call the `get_memory_briefing` tool.",
  );

  return lines.join("\n");
}
