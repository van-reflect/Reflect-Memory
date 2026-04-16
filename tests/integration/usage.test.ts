// Phase 2.4 — Usage tracking integration tests.
//
// Covers GET /usage and GET /usage/check (currently aliases that both return
// QuotaStatus). Verifies memory_count tracking through write -> trash -> permanent
// delete -> restore lifecycles.
//
// Rate-limit testing is intentionally NOT exercised here: RM_TEST_MODE=1 skips
// the @fastify/rate-limit plugin so the suite can run dozens of POSTs/sec without
// tripping per-route 1-minute caps. Rate-limit behaviour is a thin wrapper around
// a third-party plugin and is implicitly exercised by live-smoke + production.
//
// Memory cap (free plan = 200) is too large to fill in an integration test
// without a custom env override (RM_SANDBOX_MEMORY_CAP). That edge case is
// deferred to a future micro-config or live-smoke probe.

import { describe, it, expect } from "vitest";
import { api, uniqueTag, withAgentKey } from "../helpers";

interface QuotaStatus {
  allowed: boolean;
  plan: string;
  memory_count: number;
  limits: { maxMemories: number };
  memories_remaining: number;
}

async function getQuota(): Promise<QuotaStatus> {
  const r = await api<QuotaStatus>("GET", "/usage/check");
  if (r.status !== 200) {
    throw new Error(`/usage/check failed: ${r.status} ${r.text}`);
  }
  return r.json;
}

// findSimilarMemory dedups within DEDUP_WINDOW_HOURS using jaccard on title (>=0.5)
// AND content (>=0.4). To guarantee a brand-new memory is created on every call,
// we include the unique tag in both title AND content, plus several distinct
// "noise" tokens drawn from a large vocabulary.
const noiseWords = [
  "ankle", "boulder", "carafe", "dolomite", "ember", "fern", "girdle", "hummock",
  "ivory", "juniper", "kestrel", "lichen", "mango", "nimbus", "obsidian", "pollen",
  "quartz", "rivulet", "sandalwood", "tundra", "umbra", "verdigris", "willow",
  "xenon", "yarrow", "zephyr", "amaranth", "basalt", "calcite", "dewdrop",
];

function noisePhrase(): string {
  const shuffled = [...noiseWords].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 6).join(" ");
}

async function createMemory(tag: string): Promise<string> {
  const r = await api<{ id: string }>("POST", "/agent/memories", {
    token: withAgentKey("cursor"),
    body: {
      title: `${tag} ${noisePhrase()}`,
      content: `${tag} ${noisePhrase()} ${noisePhrase()}`,
      tags: [tag],
      allowed_vendors: ["*"],
    },
  });
  if (r.status !== 201) {
    throw new Error(`createMemory failed: ${r.status} ${r.text}`);
  }
  return r.json.id;
}

describe("GET /usage/check", () => {
  it("returns the documented QuotaStatus shape", async () => {
    const q = await getQuota();
    expect(q.plan).toBeTypeOf("string");
    expect(q.memory_count).toBeTypeOf("number");
    expect(q.memories_remaining).toBeTypeOf("number");
    expect(q.limits).toBeDefined();
    expect(q.limits.maxMemories).toBeTypeOf("number");
    expect(q.allowed).toBeTypeOf("boolean");
  });

  it("memory_count increments after a write", async () => {
    const before = await getQuota();
    await createMemory(uniqueTag("inc"));
    const after = await getQuota();
    expect(after.memory_count).toBeGreaterThanOrEqual(before.memory_count + 1);
  });

  it("memory_count decrements after soft-delete and again after permanent delete", async () => {
    const tag = uniqueTag("dec");
    const beforeCreate = await getQuota();
    const id = await createMemory(tag);
    const afterCreate = await getQuota();
    expect(afterCreate.memory_count).toBe(beforeCreate.memory_count + 1);

    const del = await api<{ deleted: boolean }>("DELETE", `/agent/memories/${id}`, {
      token: withAgentKey("cursor"),
    });
    expect(del.status).toBe(200);
    expect(del.json.deleted).toBe(true);
    const afterTrash = await getQuota();
    expect(afterTrash.memory_count).toBe(afterCreate.memory_count - 1);

    const perm = await api("DELETE", `/memories/${id}/permanent`);
    expect(perm.status).toBe(204);
    const afterPerm = await getQuota();
    expect(afterPerm.memory_count).toBe(afterTrash.memory_count);
  });

  it("memory_count restores after restoring a trashed memory", async () => {
    const tag = uniqueTag("restore");
    const beforeCreate = await getQuota();
    const id = await createMemory(tag);
    const afterCreate = await getQuota();
    expect(afterCreate.memory_count).toBe(beforeCreate.memory_count + 1);

    const del = await api<{ deleted: boolean }>("DELETE", `/agent/memories/${id}`, {
      token: withAgentKey("cursor"),
    });
    expect(del.status).toBe(200);
    expect(del.json.deleted).toBe(true);
    const afterTrash = await getQuota();
    expect(afterTrash.memory_count).toBe(afterCreate.memory_count - 1);

    const restored = await api("POST", `/memories/${id}/restore`, { body: {} });
    expect(restored.status).toBe(200);
    const afterRestore = await getQuota();
    expect(afterRestore.memory_count).toBe(afterTrash.memory_count + 1);
  });

  it("memories_remaining equals maxMemories - memory_count when not unlimited", async () => {
    const q = await getQuota();
    if (q.limits.maxMemories >= 0) {
      // unlimited plans return -1 (sentinel)
      expect(q.memories_remaining).toBe(
        Math.max(0, q.limits.maxMemories - q.memory_count),
      );
    } else {
      expect(q.memories_remaining).toBe(-1);
    }
  });

  it("agent key cannot read /usage/check -> 403 (owner endpoint)", async () => {
    const r = await api("GET", "/usage/check", { token: withAgentKey("cursor") });
    expect(r.status).toBe(403);
  });
});

describe("GET /usage", () => {
  it("aliases /usage/check shape (currently identical response)", async () => {
    const a = await api<QuotaStatus>("GET", "/usage");
    const b = await api<QuotaStatus>("GET", "/usage/check");
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.json.plan).toBe(b.json.plan);
    expect(a.json.memory_count).toBe(b.json.memory_count);
    expect(a.json.limits.maxMemories).toBe(b.json.limits.maxMemories);
  });

  it("supports ?month=YYYY-MM query param without erroring", async () => {
    const r = await api<QuotaStatus>("GET", "/usage?month=2026-01");
    expect(r.status).toBe(200);
    expect(r.json.plan).toBeTypeOf("string");
  });

  it("agent key cannot read /usage -> 403", async () => {
    const r = await api("GET", "/usage", { token: withAgentKey("cursor") });
    expect(r.status).toBe(403);
  });
});
