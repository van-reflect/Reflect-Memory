// Cluster naming service: given a Louvain-detected tag cluster, ask an
// LLM for a 1-3 word topic name + a one-line description. Cached in
// tag_cluster_cache (see migration 022) so we don't pay the LLM cost on
// every briefing build.
//
// Cache invalidation policy:
//   - Stale after 24h (handles slow drift).
//   - The cluster_hash is sha256(sorted_tags) — adding/removing one tag
//     in a cluster generates a new hash and forces a fresh name (correct
//     because the cluster's identity has materially changed).
//   - We never delete stale rows here — they can stay; lookups always
//     filter on freshness.
//
// Cost model: ~$0.001 per cluster with Haiku. A typical user has 5-8
// clusters, so a full briefing rebuild costs ~$0.01. Cached aggressively.
//
// Failure mode: if the LLM call fails (network, rate-limit, parse), we
// return a fallback "<top-3-tags>" name + an empty description so the
// briefing still renders. We log the error but do NOT block briefing
// generation — naming is a polish layer, not load-bearing.

import type Database from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";
import type { TagCluster } from "./tag-clustering.js";

export interface NamedCluster extends TagCluster {
  name: string;
  description: string;
  /** True if the name came from a fresh LLM call this build (vs cache). */
  freshly_named: boolean;
}

const DEFAULT_MODEL = process.env.RM_CLUSTER_NAMING_MODEL ?? "claude-haiku-4-5";
const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Render a stable scope key. Personal scope is just `personal`; team
 * scope is `team:<team_id>` so different teams have separate cache rows
 * for the same user.
 */
function scopeKey(scope: "personal" | "team", teamId: string | null): string {
  if (scope === "personal") return "personal";
  if (!teamId) return "team:none";
  return `team:${teamId}`;
}

interface CachedRow {
  cluster_hash: string;
  name: string;
  description: string;
  computed_at: string;
}

function loadCachedClusters(
  db: Database.Database,
  userId: string,
  scopeStr: string,
): Map<string, CachedRow> {
  const rows = db
    .prepare(
      `SELECT cluster_hash, name, description, computed_at
       FROM tag_cluster_cache
       WHERE user_id = ? AND scope = ?`,
    )
    .all(userId, scopeStr) as CachedRow[];
  const cutoff = Date.now() - STALE_AFTER_MS;
  const fresh = new Map<string, CachedRow>();
  for (const r of rows) {
    if (Date.parse(r.computed_at) > cutoff) {
      fresh.set(r.cluster_hash, r);
    }
  }
  return fresh;
}

function upsertCachedCluster(
  db: Database.Database,
  userId: string,
  scopeStr: string,
  cluster: TagCluster,
  name: string,
  description: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tag_cluster_cache
       (user_id, scope, cluster_hash, name, description, tags, member_count, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, scope, cluster_hash) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       tags = excluded.tags,
       member_count = excluded.member_count,
       computed_at = excluded.computed_at`,
  ).run(
    userId,
    scopeStr,
    cluster.cluster_hash,
    name,
    description,
    JSON.stringify(cluster.tags),
    cluster.size,
    now,
  );
}

/**
 * Fallback name when LLM naming fails or no API key is configured.
 * Picks the top 3 tags by alphabetical order (a stable proxy — the
 * cluster's own ordering uses size which we don't have here).
 */
function fallbackName(cluster: TagCluster): { name: string; description: string } {
  const top = cluster.tags.slice(0, 3).join("/");
  // Description intentionally compact — the briefing renders memory count
  // separately, so duplicating it here is noise.
  return {
    name: top,
    description: `${cluster.tags.length} co-occurring tags`,
  };
}

/**
 * Build a single naming prompt for the cluster. The prompt is small and
 * structured; we ask for strict JSON to make parsing deterministic.
 */
function buildNamingPrompt(cluster: TagCluster, sampleTitles: string[]): string {
  return [
    "Below is a cluster of tags that frequently co-occur on memories in a personal/team memory system. Plus a few sample memory titles from that cluster.",
    "",
    "Give the cluster a SHORT topic name (1-3 words, Title Case) and a ONE-LINE description (≤ 12 words) that captures what the cluster is about.",
    "",
    "Respond with strict JSON only, no markdown, no commentary:",
    '{"name": "<1-3 word title>", "description": "<one-line description>"}',
    "",
    "## Tags in cluster",
    cluster.tags.join(", "),
    "",
    sampleTitles.length > 0
      ? "## Sample memory titles\n" + sampleTitles.map((t) => `- ${t}`).join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Pull up to N memory titles whose tags overlap heavily with the cluster.
 * Used as context for the naming prompt.
 */
function getSampleTitles(
  db: Database.Database,
  userId: string,
  scope: "personal" | "team",
  teamId: string | null,
  cluster: TagCluster,
  limit: number,
): string[] {
  let scopeClause: string;
  let scopeArgs: unknown[];
  if (scope === "personal") {
    scopeClause = "m.user_id = ?";
    scopeArgs = [userId];
  } else {
    if (!teamId) return [];
    scopeClause = "m.shared_with_team_id = ?";
    scopeArgs = [teamId];
  }

  const tagsJson = JSON.stringify(cluster.tags);
  const rows = db
    .prepare(
      `SELECT m.title, COUNT(*) AS overlap
       FROM memories m, json_each(m.tags) t
       WHERE ${scopeClause}
         AND m.deleted_at IS NULL
         AND t.value IN (SELECT value FROM json_each(?))
       GROUP BY m.id
       ORDER BY overlap DESC, m.created_at DESC
       LIMIT ?`,
    )
    .all(...scopeArgs, tagsJson, limit) as { title: string; overlap: number }[];
  return rows.map((r) => r.title);
}

async function nameOneCluster(
  anthropic: Anthropic,
  cluster: TagCluster,
  sampleTitles: string[],
): Promise<{ name: string; description: string }> {
  const resp = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 200,
    system: "You name clusters of tags. Strict JSON output, no commentary.",
    messages: [{ role: "user", content: buildNamingPrompt(cluster, sampleTitles) }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const parsed = JSON.parse(text) as { name: string; description: string };
  if (typeof parsed.name !== "string" || typeof parsed.description !== "string") {
    throw new Error("LLM returned invalid shape");
  }
  return {
    name: parsed.name.trim(),
    description: parsed.description.trim(),
  };
}

export interface NameClustersOptions {
  /** Override Anthropic API key (otherwise reads ANTHROPIC_API_KEY). */
  anthropicKey?: string;
  /** Skip LLM calls entirely; use fallback names. Useful for tests. */
  fallbackOnly?: boolean;
  /** Max sample titles to send the LLM per cluster. Default 5. */
  sampleTitlesPerCluster?: number;
}

/**
 * Resolve names for a list of clusters. Cached results returned
 * immediately; missing/stale clusters get a fresh LLM call (in
 * parallel, with a global try/catch per cluster so one failure doesn't
 * sink the others).
 *
 * Returns clusters in the same order as the input.
 */
export async function nameClusters(
  db: Database.Database,
  userId: string,
  scope: "personal" | "team",
  teamId: string | null,
  clusters: TagCluster[],
  opts: NameClustersOptions = {},
): Promise<NamedCluster[]> {
  if (clusters.length === 0) return [];
  const scopeStr = scopeKey(scope, teamId);
  const cached = loadCachedClusters(db, userId, scopeStr);

  const apiKey = opts.anthropicKey ?? process.env.ANTHROPIC_API_KEY;
  const useLlm = !opts.fallbackOnly && apiKey;
  const anthropic = useLlm ? new Anthropic({ apiKey }) : null;
  const samples = opts.sampleTitlesPerCluster ?? 5;

  // For each cluster: cached → use it; else compute (LLM or fallback).
  const named = await Promise.all(
    clusters.map(async (cluster): Promise<NamedCluster> => {
      const hit = cached.get(cluster.cluster_hash);
      if (hit) {
        return {
          ...cluster,
          name: hit.name,
          description: hit.description,
          freshly_named: false,
        };
      }
      if (!anthropic) {
        // No API key configured — fallback names. Do NOT cache: if the
        // operator adds a key later we want naming to retry immediately.
        const f = fallbackName(cluster);
        return { ...cluster, ...f, freshly_named: true };
      }
      try {
        const titles = getSampleTitles(db, userId, scope, teamId, cluster, samples);
        const nd = await nameOneCluster(anthropic, cluster, titles);
        upsertCachedCluster(db, userId, scopeStr, cluster, nd.name, nd.description);
        return { ...cluster, ...nd, freshly_named: true };
      } catch (err) {
        // LLM call failed (rate limit, network, parse). Use the fallback
        // for this build but DO NOT cache it — next session will retry.
        // Caching a fallback would lock us out for 24h on every cluster
        // that briefly failed, which is most painful exactly when the
        // user has many new clusters and we get rate-limited bursting.
        console.warn(
          `[cluster-naming] LLM naming failed for cluster ${cluster.cluster_hash} (${cluster.tags.length} tags): ${(err as Error).message} — using fallback (will retry next session)`,
        );
        const f = fallbackName(cluster);
        return { ...cluster, ...f, freshly_named: true };
      }
    }),
  );

  return named;
}
