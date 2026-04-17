// Unit tests: src/memory-service.ts
//
// Tests pure helpers (tokenize, jaccardSimilarity) and DB-driven primitives
// (createMemory dedup, soft-delete, restore, permanent delete, version history)
// against a fresh in-memory SQLite. Faster + more focused than integration tests:
// each test gets its own DB and exercises one path.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONTENT_SIMILARITY_THRESHOLD,
  DEDUP_WINDOW_HOURS,
  TITLE_SIMILARITY_THRESHOLD,
  countMemories,
  createMemory,
  deleteMemory,
  emptyTrash,
  getVersionHistory,
  jaccardSimilarity,
  listMemories,
  readMemoryById,
  restoreMemory,
  softDeleteMemory,
  tokenize,
  updateMemory,
} from "../../src/memory-service.js";
import { makeTestDb, seedUser, type TestDb } from "./db.js";

let h: TestDb;
let userId: string;

beforeEach(() => {
  h = makeTestDb();
  userId = seedUser(h.db).id;
});

afterEach(() => {
  h.close();
});

describe("tokenize", () => {
  it("lowercases and splits on whitespace", () => {
    const t = tokenize("Hello World Foo");
    expect(t.has("hello")).toBe(true);
    expect(t.has("world")).toBe(true);
    expect(t.has("foo")).toBe(true);
  });

  it("strips punctuation", () => {
    const t = tokenize("hello, world! foo-bar.");
    expect([...t].sort()).toEqual(["bar", "foo", "hello", "world"]);
  });

  it("filters out tokens of length <= 2 (stopword-ish)", () => {
    // Only "the" (length 3) and "fox" (length 3) survive; everything else is too short.
    const t = tokenize("a an the to of in on by it fox");
    expect(t.size).toBe(2);
    expect(t.has("the")).toBe(true);
    expect(t.has("fox")).toBe(true);
  });

  it("returns empty set for empty input", () => {
    expect(tokenize("").size).toBe(0);
  });

  it("dedupes repeated words", () => {
    const t = tokenize("foo foo foo bar bar");
    expect(t.size).toBe(2);
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1 for identical sets", () => {
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });

  it("returns 0 for fully disjoint sets", () => {
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["c", "d"]))).toBe(0);
  });

  it("returns 1 for two empty sets (avoid 0/0 trap)", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  it("returns 0 when one side is empty", () => {
    expect(jaccardSimilarity(new Set(["a"]), new Set())).toBe(0);
  });

  it("computes intersection / union correctly for partial overlap", () => {
    // {a,b,c} ∩ {b,c,d} = {b,c}; union = {a,b,c,d}; jaccard = 2/4 = 0.5
    expect(
      jaccardSimilarity(new Set(["a", "b", "c"]), new Set(["b", "c", "d"])),
    ).toBeCloseTo(0.5);
  });

  it("is symmetric", () => {
    const a = new Set(["x", "y", "z"]);
    const b = new Set(["y", "z", "w", "v"]);
    expect(jaccardSimilarity(a, b)).toBeCloseTo(jaccardSimilarity(b, a));
  });
});

describe("dedup constants", () => {
  it("title threshold > content threshold (titles must match more strictly)", () => {
    expect(TITLE_SIMILARITY_THRESHOLD).toBeGreaterThan(CONTENT_SIMILARITY_THRESHOLD);
  });

  it("dedup window is 48h (sanity check; changing this is a behaviour change)", () => {
    expect(DEDUP_WINDOW_HOURS).toBe(48);
  });
});

describe("createMemory: insert path", () => {
  it("creates a memory with the correct shape", () => {
    const m = createMemory(h.db, userId, {
      title: "alpha bravo charlie delta",
      content: "echo foxtrot golf hotel india juliet",
      tags: ["one", "two"],
      origin: "user",
      allowed_vendors: ["*"],
      memory_type: "semantic",
    });

    expect(m.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(m.title).toBe("alpha bravo charlie delta");
    expect(m.tags).toEqual(["one", "two"]);
    expect(m.allowed_vendors).toEqual(["*"]);
    expect(m.memory_type).toBe("semantic");
    expect(m.created_at).toBe(m.updated_at);
  });

  it("defaults memory_type to semantic when omitted", () => {
    const m = createMemory(h.db, userId, {
      title: "kilo lima mike november",
      content: "oscar papa quebec romeo sierra tango",
      tags: [],
      origin: "user",
      allowed_vendors: ["*"],
    });
    expect(m.memory_type).toBe("semantic");
  });
});

describe("createMemory: dedup path", () => {
  it("merges into existing memory when title+content overlap exceeds thresholds", () => {
    const original = createMemory(h.db, userId, {
      title: "weekly status update for project alpha",
      content: "completed feature x and started on feature y this week",
      tags: ["status"],
      origin: "cursor",
      allowed_vendors: ["*"],
    });

    // Same origin, very similar content+title → should be merged not duplicated.
    const dup = createMemory(h.db, userId, {
      title: "weekly status update for project alpha refresh",
      content: "completed feature x and started on feature y this week with notes",
      tags: ["update"],
      origin: "cursor",
      allowed_vendors: ["*"],
    });

    expect(dup.id).toBe(original.id);
    expect(dup.tags.sort()).toEqual(["status", "update"]);
    expect(countMemories(h.db, userId, { by: "all" }, null)).toBe(1);
  });

  it("does NOT merge across different origins (each surface keeps its own dedup window)", () => {
    createMemory(h.db, userId, {
      title: "weekly status update for project alpha",
      content: "completed feature x and started on feature y this week",
      tags: [],
      origin: "cursor",
      allowed_vendors: ["*"],
    });

    createMemory(h.db, userId, {
      title: "weekly status update for project alpha",
      content: "completed feature x and started on feature y this week",
      tags: [],
      origin: "claude",
      allowed_vendors: ["*"],
    });

    expect(countMemories(h.db, userId, { by: "all" }, null)).toBe(2);
  });

  it("creates separate memories when content diverges (low jaccard)", () => {
    createMemory(h.db, userId, {
      title: "completely different alpha bravo charlie",
      content: "lorem ipsum dolor sit amet consectetur",
      tags: [],
      origin: "user",
      allowed_vendors: ["*"],
    });

    createMemory(h.db, userId, {
      title: "totally unrelated kilo lima mike november",
      content: "quokka platypus narwhal aardvark wombat",
      tags: [],
      origin: "user",
      allowed_vendors: ["*"],
    });

    expect(countMemories(h.db, userId, { by: "all" }, null)).toBe(2);
  });

  it("dedup creates a version snapshot of the prior state", () => {
    const original = createMemory(h.db, userId, {
      title: "weekly status update for project alpha",
      content: "completed feature x and started on feature y this week",
      tags: ["v1"],
      origin: "cursor",
      allowed_vendors: ["*"],
    });

    createMemory(h.db, userId, {
      title: "weekly status update for project alpha refreshed",
      content: "completed feature x and started on feature y this week with extra",
      tags: ["v2"],
      origin: "cursor",
      allowed_vendors: ["*"],
    });

    const versions = getVersionHistory(h.db, userId, original.id);
    expect(versions.length).toBeGreaterThanOrEqual(1);
    // The first archived version should be the original v1 state.
    expect(versions[0]?.title).toBe("weekly status update for project alpha");
  });
});

describe("softDeleteMemory + restoreMemory", () => {
  it("soft-delete removes from default list but row remains", () => {
    const m = createMemory(h.db, userId, {
      title: "alpha bravo charlie",
      content: "delta echo foxtrot golf hotel",
      tags: [],
      origin: "user",
      allowed_vendors: ["*"],
    });

    const deleted = softDeleteMemory(h.db, userId, m.id);
    expect(deleted).not.toBeNull();
    expect(deleted?.id).toBe(m.id);

    // Soft-deleted memories are excluded from "all" filter but still readable
    // by id (so version history / restore can find them) and visible in the trash.
    const all = listMemories(h.db, userId, { by: "all" }, null);
    expect(all.find((x) => x.id === m.id)).toBeUndefined();

    const trashed = listMemories(h.db, userId, { by: "trashed" }, null);
    expect(trashed.find((x) => x.id === m.id)).toBeDefined();

    const row = readMemoryById(h.db, userId, m.id);
    expect(row?.id).toBe(m.id);
  });

  it("soft-delete returns null for nonexistent id", () => {
    expect(
      softDeleteMemory(h.db, userId, "00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
  });

  it("restore brings a trashed memory back to active list", () => {
    const m = createMemory(h.db, userId, {
      title: "kilo lima mike november",
      content: "oscar papa quebec romeo sierra",
      tags: [],
      origin: "user",
      allowed_vendors: ["*"],
    });

    softDeleteMemory(h.db, userId, m.id);
    const restored = restoreMemory(h.db, userId, m.id);
    expect(restored).not.toBeNull();
    expect(readMemoryById(h.db, userId, m.id)?.id).toBe(m.id);
  });

  it("restore returns null for a memory that was never trashed", () => {
    const m = createMemory(h.db, userId, {
      title: "uniform victor whiskey",
      content: "xray yankee zulu alpha bravo",
      tags: [],
      origin: "user",
      allowed_vendors: ["*"],
    });
    expect(restoreMemory(h.db, userId, m.id)).toBeNull();
  });
});

describe("deleteMemory (permanent)", () => {
  it("removes the row entirely; subsequent reads return null", () => {
    const m = createMemory(h.db, userId, {
      title: "alpha bravo charlie",
      content: "delta echo foxtrot golf",
      tags: [],
      origin: "user",
      allowed_vendors: ["*"],
    });

    expect(deleteMemory(h.db, userId, m.id)).toBe(true);
    expect(readMemoryById(h.db, userId, m.id)).toBeNull();
    // Not in trash either — fully gone.
    const trashed = listMemories(h.db, userId, { by: "trashed" }, null);
    expect(trashed.find((x) => x.id === m.id)).toBeUndefined();
  });
});

describe("updateMemory", () => {
  it("creates a version snapshot before mutating", () => {
    const m = createMemory(h.db, userId, {
      title: "alpha bravo charlie",
      content: "delta echo foxtrot golf",
      tags: ["original"],
      origin: "user",
      allowed_vendors: ["*"],
    });

    const beforeVersions = getVersionHistory(h.db, userId, m.id);
    expect(beforeVersions.length).toBe(0);

    updateMemory(h.db, userId, m.id, {
      title: "updated title here",
      content: "updated content here lorem ipsum",
      tags: ["updated"],
      allowed_vendors: ["*"],
    });

    const afterVersions = getVersionHistory(h.db, userId, m.id);
    expect(afterVersions.length).toBe(1);
    expect(afterVersions[0]?.title).toBe("alpha bravo charlie");
  });

  it("returns null when memory does not belong to user", () => {
    const m = createMemory(h.db, userId, {
      title: "alpha bravo charlie",
      content: "delta echo foxtrot golf",
      tags: [],
      origin: "user",
      allowed_vendors: ["*"],
    });
    const other = seedUser(h.db).id;
    const result = updateMemory(h.db, other, m.id, {
      title: "hijack",
      content: "hijack",
      tags: [],
      allowed_vendors: ["*"],
    });
    expect(result).toBeNull();
  });
});

describe("emptyTrash", () => {
  it("permanently removes only trashed memories, leaving active ones intact", () => {
    const active = createMemory(h.db, userId, {
      title: "alpha bravo charlie",
      content: "delta echo foxtrot golf",
      tags: [],
      origin: "user",
      allowed_vendors: ["*"],
    });
    const trashed = createMemory(h.db, userId, {
      title: "kilo lima mike november",
      content: "oscar papa quebec romeo sierra",
      tags: [],
      origin: "user",
      allowed_vendors: ["*"],
    });
    softDeleteMemory(h.db, userId, trashed.id);

    const removed = emptyTrash(h.db, userId);
    expect(removed).toBe(1);

    expect(readMemoryById(h.db, userId, active.id)?.id).toBe(active.id);
    expect(listMemories(h.db, userId, { by: "trashed" }, null)).toHaveLength(0);
  });
});
