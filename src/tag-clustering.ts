// Tag clustering via Louvain community detection over the tag
// co-occurrence graph.
//
// Why Louvain:
//   - Maximises modularity — each cluster has more internal edges than
//     would be expected by chance.
//   - Resolution-tunable (the `resolution` parameter) — we lean toward
//     larger clusters (resolution ~1.0) so the briefing surfaces a
//     handful of meaningful topics instead of dozens of tiny ones.
//   - Fast: O(E log V) typical, runs in milliseconds on our 50-200 tag
//     graphs.
//   - graphology + graphology-communities-louvain is a small dep with
//     no native bindings.
//
// What this module does NOT do:
//   - Name the clusters (cluster-naming.ts handles that — one LLM call
//     per cluster, cached).
//   - Score "active" vs "stale" clusters (briefing v2 layer applies
//     recency).

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { TagCooccurrenceRow } from "./memory-graph.js";

// graphology + graphology-communities-louvain ship as CJS-default-export
// packages and fight Node16 module resolution if imported with `import x
// from "..."`. createRequire sidesteps the resolution mismatch entirely
// and gives us the runtime constructor / function we want.
const require_ = createRequire(import.meta.url);
const Graph = require_("graphology") as new (
  options?: { type?: string; multi?: boolean },
) => GraphologyGraph;
const louvain = require_("graphology-communities-louvain") as (
  graph: GraphologyGraph,
  options?: { resolution?: number; rng?: () => number },
) => Record<string, number>;

interface GraphologyGraph {
  addNode(key: string, attrs?: Record<string, unknown>): void;
  addEdge(source: string, target: string, attrs?: Record<string, unknown>): void;
  hasNode(key: string): boolean;
}

export interface TagCluster {
  /** Stable hash of the sorted member tag list — used as cache key. */
  cluster_hash: string;
  /** Member tags in the cluster, sorted alphabetically for stability. */
  tags: string[];
  /** Sum of vertex weights (per-tag memory counts) inside the cluster. */
  size: number;
  /** Sum of edge weights inside the cluster (intra-cluster cohesion). */
  internal_weight: number;
}

export interface ClusterTagsOptions {
  /**
   * Louvain resolution parameter. >1 → smaller clusters; <1 → larger.
   * Default 1.0 — community-standard "natural" resolution.
   */
  resolution?: number;
  /**
   * Minimum cluster size (number of tags). Trivial 1-2 tag clusters
   * are dropped — they're not worth surfacing in the briefing. Default 3.
   */
  minClusterSize?: number;
  /**
   * Random seed for the Louvain shuffle step. Defaults to deterministic.
   * (graphology-communities-louvain uses `Math.random` by default —
   * setting this lets us reproduce results across invocations.)
   */
  rng?: () => number;
}

/**
 * Cluster a set of tags into communities using Louvain over the
 * co-occurrence graph.
 *
 * Returns clusters sorted by size descending. Trivial clusters (below
 * minClusterSize) are dropped. The cluster_hash is a stable digest of
 * the sorted member-tag list so a cache lookup can survive small
 * non-structural changes (a single new memory adding one cooccurrence
 * shouldn't invalidate the cluster).
 */
export function clusterTags(
  pairs: TagCooccurrenceRow[],
  tagFrequencies: Map<string, number>,
  opts: ClusterTagsOptions = {},
): TagCluster[] {
  const minClusterSize = opts.minClusterSize ?? 3;

  if (pairs.length === 0 || tagFrequencies.size === 0) return [];

  const g = new Graph({ type: "undirected", multi: false });
  for (const [tag, freq] of tagFrequencies) {
    g.addNode(tag, { weight: freq });
  }
  for (const p of pairs) {
    if (!g.hasNode(p.tag_a) || !g.hasNode(p.tag_b)) continue;
    g.addEdge(p.tag_a, p.tag_b, { weight: p.count });
  }

  // Louvain assigns each node a community id (integer).
  const communities = louvain(g, {
    resolution: opts.resolution ?? 1.0,
    rng: opts.rng,
  });

  // Group tags by community.
  const buckets = new Map<number, string[]>();
  for (const [node, community] of Object.entries(communities)) {
    const bucket = buckets.get(community) ?? [];
    bucket.push(node);
    buckets.set(community, bucket);
  }

  // Build TagCluster records: filter trivials, compute size + internal weight.
  const clusters: TagCluster[] = [];
  for (const tags of buckets.values()) {
    if (tags.length < minClusterSize) continue;
    const sorted = [...tags].sort();
    const tagSet = new Set(sorted);
    const size = sorted.reduce((s, t) => s + (tagFrequencies.get(t) ?? 0), 0);
    let internalWeight = 0;
    for (const p of pairs) {
      if (tagSet.has(p.tag_a) && tagSet.has(p.tag_b)) {
        internalWeight += p.count;
      }
    }
    const cluster_hash = createHash("sha256")
      .update(sorted.join("|"))
      .digest("hex")
      .slice(0, 16);
    clusters.push({ cluster_hash, tags: sorted, size, internal_weight: internalWeight });
  }

  // Sort: largest cohesion first (size + internal_weight as a soft signal).
  clusters.sort(
    (a, b) =>
      b.size + b.internal_weight - (a.size + a.internal_weight),
  );
  return clusters;
}
