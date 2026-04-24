// Unit tests for tag-clustering (Louvain over co-occurrence).

import { describe, expect, it } from "vitest";
import { clusterTags } from "../../src/tag-clustering.js";
import type { TagCooccurrenceRow } from "../../src/memory-graph.js";

describe("clusterTags", () => {
  it("returns empty when there are no tags or pairs", () => {
    expect(clusterTags([], new Map())).toEqual([]);
    expect(
      clusterTags([], new Map([["lonely", 1]])),
    ).toEqual([]);
  });

  it("groups two well-connected sub-graphs into separate clusters", () => {
    // Cluster A: eng, auth, mcp, bug all interconnected
    // Cluster B: marketing, demo, video, pricing all interconnected
    const tagFrequencies = new Map<string, number>([
      ["eng", 10],
      ["auth", 8],
      ["mcp", 7],
      ["bug", 6],
      ["marketing", 5],
      ["demo", 4],
      ["video", 3],
      ["pricing", 4],
    ]);
    const pairs: TagCooccurrenceRow[] = [
      // dense intra-A
      { tag_a: "auth", tag_b: "eng", count: 5 },
      { tag_a: "bug", tag_b: "eng", count: 5 },
      { tag_a: "auth", tag_b: "bug", count: 4 },
      { tag_a: "eng", tag_b: "mcp", count: 4 },
      { tag_a: "auth", tag_b: "mcp", count: 3 },
      // dense intra-B
      { tag_a: "demo", tag_b: "marketing", count: 4 },
      { tag_a: "marketing", tag_b: "video", count: 3 },
      { tag_a: "demo", tag_b: "video", count: 3 },
      { tag_a: "marketing", tag_b: "pricing", count: 3 },
      // weak inter-A-B
      { tag_a: "eng", tag_b: "marketing", count: 1 },
    ];
    const clusters = clusterTags(pairs, tagFrequencies, { rng: () => 0.42 });
    expect(clusters.length).toBeGreaterThanOrEqual(2);

    const findCluster = (tag: string) =>
      clusters.find((c) => c.tags.includes(tag));
    const engC = findCluster("eng");
    const marketingC = findCluster("marketing");
    expect(engC).toBeTruthy();
    expect(marketingC).toBeTruthy();
    expect(engC).not.toBe(marketingC);
    // Eng cluster should hold its dense neighbours.
    expect(engC!.tags).toEqual(expect.arrayContaining(["eng", "auth"]));
    expect(marketingC!.tags).toEqual(
      expect.arrayContaining(["marketing", "demo"]),
    );
  });

  it("drops trivial clusters below minClusterSize", () => {
    const tagFrequencies = new Map<string, number>([
      ["a", 5],
      ["b", 5],
      ["lonely", 2],
    ]);
    const pairs: TagCooccurrenceRow[] = [{ tag_a: "a", tag_b: "b", count: 4 }];
    const clusters = clusterTags(pairs, tagFrequencies, { minClusterSize: 3 });
    // (a,b) is too small at minClusterSize=3, lonely isolated → all dropped.
    expect(clusters).toEqual([]);
  });

  it("produces a stable cluster_hash for the same tag set across runs", () => {
    const tagFrequencies = new Map<string, number>([
      ["eng", 10],
      ["auth", 8],
      ["mcp", 7],
      ["bug", 6],
    ]);
    const pairs: TagCooccurrenceRow[] = [
      { tag_a: "auth", tag_b: "eng", count: 5 },
      { tag_a: "bug", tag_b: "eng", count: 5 },
      { tag_a: "eng", tag_b: "mcp", count: 4 },
      { tag_a: "auth", tag_b: "bug", count: 3 },
      { tag_a: "auth", tag_b: "mcp", count: 3 },
    ];
    const c1 = clusterTags(pairs, tagFrequencies, { rng: () => 0.5 });
    const c2 = clusterTags(pairs, tagFrequencies, { rng: () => 0.5 });
    expect(c1).toHaveLength(c2.length);
    if (c1.length > 0) {
      expect(c1[0].cluster_hash).toBe(c2[0].cluster_hash);
    }
  });

  it("orders clusters by size + internal_weight descending", () => {
    const tagFrequencies = new Map<string, number>([
      ["a", 10],
      ["b", 10],
      ["c", 10],
      ["x", 1],
      ["y", 1],
      ["z", 1],
    ]);
    const pairs: TagCooccurrenceRow[] = [
      { tag_a: "a", tag_b: "b", count: 8 },
      { tag_a: "b", tag_b: "c", count: 7 },
      { tag_a: "a", tag_b: "c", count: 6 },
      { tag_a: "x", tag_b: "y", count: 1 },
      { tag_a: "y", tag_b: "z", count: 1 },
      { tag_a: "x", tag_b: "z", count: 1 },
    ];
    const clusters = clusterTags(pairs, tagFrequencies, { minClusterSize: 3 });
    // Heavier cluster (a,b,c) comes first.
    expect(clusters[0].tags).toEqual(expect.arrayContaining(["a", "b", "c"]));
    if (clusters.length > 1) {
      const heavySum = clusters[0].size + clusters[0].internal_weight;
      const lightSum = clusters[1].size + clusters[1].internal_weight;
      expect(heavySum).toBeGreaterThanOrEqual(lightSum);
    }
  });
});
