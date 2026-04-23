// Memory briefing: condensed, structured first-contact context for MCP clients.
//
// The MCP `initialize` handshake lets the server hand a free-form `instructions`
// string to the client. Historically we sent nothing. This module builds a
// compact "mindmap" of the user's memory state (identity, tag index, recency,
// open threads, detected conventions) so a connecting LLM can orient itself
// without burning tool calls.
//
// Also exposed via an HTTP route and an MCP tool so clients can refresh
// mid-session.

import type Database from "better-sqlite3";

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
  team_id: string | null;
  team_name: string | null;
  team_role: string | null;
  team_member_count: number;
}

export interface BriefingTotals {
  personal_memories: number;
  personal_memories_shared: number;
  team_pool_total: number;
}

export interface MemoryBriefing {
  user: UserSummary;
  totals: BriefingTotals;
  personal_tags: TagCount[];
  team_tags: TagCount[];
  recent_tags: TagCount[];
  active_threads: ActiveThread[];
  detected_conventions: string[];
  generated_at: string;
}

export interface BriefingOptions {
  topTagsN?: number;
  recencyDays?: number;
  activeThreadsN?: number;
}

const DEFAULT_TOP_TAGS = 30;
const DEFAULT_RECENCY_DAYS = 7;
const DEFAULT_ACTIVE_THREADS = 5;

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function loadUserSummary(db: Database.Database, userId: string): UserSummary {
  const user = db
    .prepare(
      `SELECT id, email, first_name, last_name, role, plan, team_id, team_role
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
        team_id: string | null;
        team_role: string | null;
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
      team_id: null,
      team_name: null,
      team_role: null,
      team_member_count: 0,
    };
  }

  let teamName: string | null = null;
  let teamMemberCount = 0;
  if (user.team_id) {
    const team = db
      .prepare(`SELECT name FROM teams WHERE id = ?`)
      .get(user.team_id) as { name: string } | undefined;
    teamName = team?.name ?? null;
    teamMemberCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM users WHERE team_id = ?`).get(user.team_id) as {
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
    team_id: user.team_id,
    team_name: teamName,
    team_role: user.team_role,
    team_member_count: teamMemberCount,
  };
}

function loadTotals(
  db: Database.Database,
  userId: string,
  teamId: string | null,
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
         WHERE user_id = ? AND deleted_at IS NULL AND shared_with_team_id IS NOT NULL`,
      )
      .get(userId) as { n: number }
  ).n;
  let teamPoolTotal = 0;
  if (teamId) {
    teamPoolTotal = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM memories
           WHERE shared_with_team_id = ? AND deleted_at IS NULL`,
        )
        .get(teamId) as { n: number }
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
  teamId: string,
  limit: number,
): TagCount[] {
  const rows = db
    .prepare(
      `SELECT t.value AS tag, COUNT(*) AS n
       FROM memories m, json_each(m.tags) t
       WHERE m.shared_with_team_id = ? AND m.deleted_at IS NULL
       GROUP BY t.value
       ORDER BY n DESC, t.value ASC
       LIMIT ?`,
    )
    .all(teamId, limit) as { tag: string; n: number }[];
  return rows.map((r) => ({ tag: r.tag, count: r.n }));
}

function loadRecentTags(
  db: Database.Database,
  userId: string,
  teamId: string | null,
  days: number,
  limit: number,
): TagCount[] {
  const since = daysAgoIso(days);
  // Union of user's own + team-visible memories in window. COALESCE handles
  // teamId = null (SQLite won't match NULL = anything).
  const rows = db
    .prepare(
      `SELECT t.value AS tag, COUNT(DISTINCT m.id) AS n
       FROM memories m, json_each(m.tags) t
       WHERE m.deleted_at IS NULL
         AND m.created_at >= ?
         AND (m.user_id = ? OR m.shared_with_team_id = COALESCE(?, ''))
       GROUP BY t.value
       ORDER BY n DESC, t.value ASC
       LIMIT ?`,
    )
    .all(since, userId, teamId ?? "", limit) as { tag: string; n: number }[];
  return rows.map((r) => ({ tag: r.tag, count: r.n }));
}

function loadActiveThreads(
  db: Database.Database,
  userId: string,
  limit: number,
): ActiveThread[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.title, m.shared_with_team_id,
              (SELECT COUNT(*) FROM memories c
               WHERE c.parent_memory_id = m.id AND c.deleted_at IS NULL) AS reply_count,
              COALESCE(
                (SELECT MAX(c.updated_at) FROM memories c
                 WHERE c.parent_memory_id = m.id AND c.deleted_at IS NULL),
                m.updated_at
              ) AS last_activity_at
       FROM memories m
       WHERE m.user_id = ?
         AND m.parent_memory_id IS NULL
         AND m.deleted_at IS NULL
       ORDER BY reply_count DESC, last_activity_at DESC
       LIMIT ?`,
    )
    .all(userId, limit) as {
      id: string;
      title: string;
      shared_with_team_id: string | null;
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
      shared_with_team: r.shared_with_team_id !== null,
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

  const priorityTags = ["p0", "p1", "p2", "p3"].filter(has);
  if (priorityTags.length >= 2) {
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
 * Compute the full briefing structure. Synchronous; runs several small SQL
 * queries against the same DB handle.
 */
export function buildMemoryBriefing(
  db: Database.Database,
  userId: string,
  opts: BriefingOptions = {},
): MemoryBriefing {
  const topTagsN = opts.topTagsN ?? DEFAULT_TOP_TAGS;
  const recencyDays = opts.recencyDays ?? DEFAULT_RECENCY_DAYS;
  const activeThreadsN = opts.activeThreadsN ?? DEFAULT_ACTIVE_THREADS;

  const user = loadUserSummary(db, userId);
  const totals = loadTotals(db, userId, user.team_id);
  const personalTags = loadPersonalTags(db, userId, topTagsN);
  const teamTags = user.team_id
    ? loadTeamTags(db, user.team_id, topTagsN)
    : [];
  const recentTags = loadRecentTags(
    db,
    userId,
    user.team_id,
    recencyDays,
    topTagsN,
  );
  const activeThreads = loadActiveThreads(db, userId, activeThreadsN);
  const detectedConventions = detectConventions(personalTags, teamTags);

  return {
    user,
    totals,
    personal_tags: personalTags,
    team_tags: teamTags,
    recent_tags: recentTags,
    active_threads: activeThreads,
    detected_conventions: detectedConventions,
    generated_at: new Date().toISOString(),
  };
}

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
      }, role: ${user.team_role ?? "member"})`
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

  lines.push("## Personal tags (top)");
  lines.push(renderTagList(b.personal_tags));
  lines.push("");

  if (b.user.team_id) {
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
        "The IDs above are full UUIDs — pass them verbatim.",
    );
    lines.push("");
  }

  if (b.detected_conventions.length > 0) {
    lines.push("## Detected conventions");
    for (const c of b.detected_conventions) {
      lines.push(`- ${c}`);
    }
    lines.push("");
  }

  lines.push("## Refresh");
  lines.push(
    "This briefing is a snapshot at connect time. If you want a fresh one mid-session, call the `get_memory_briefing` tool.",
  );

  return lines.join("\n");
}
