// Unit tests for memory-graph helpers (Phase A iter 4).

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb, seedUser, type TestDb } from "./db.js";
import {
  getBacklinks,
  getGraphAround,
  getTagCooccurrence,
} from "../../src/memory-graph.js";

let t: TestDb;

beforeEach(() => {
  t = makeTestDb();
});
afterEach(() => {
  t.close();
});

interface SeedMemoryOpts {
  userId: string;
  title?: string;
  content?: string;
  tags?: string[];
  parentId?: string | null;
  /** Org-wide-share scope. Sets shared_with_org_id (post-migration 026
   *  this is what the runtime calls "org-shared"). Param name kept for
   *  back-compat with tests that pre-date the migration. */
  sharedWithTeamId?: string | null;
  /** Sub-team-share scope. Sets shared_with_team_id — visible only to
   *  members of that sub-team. Use `seedSubteam` to mint one. */
  sharedWithSubteamId?: string | null;
  createdAt?: string;
}

function seedMemory(opts: SeedMemoryOpts): string {
  const id = randomUUID();
  const now = opts.createdAt ?? new Date().toISOString();
  const sharedAt =
    opts.sharedWithTeamId || opts.sharedWithSubteamId ? now : null;
  t.db.prepare(
    `INSERT INTO memories
       (id, user_id, title, content, tags, origin, allowed_vendors, memory_type,
        created_at, updated_at,
        shared_with_org_id, shared_with_team_id, shared_at, parent_memory_id)
     VALUES (?, ?, ?, ?, ?, 'user', '["*"]', 'semantic', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.userId,
    opts.title ?? `mem-${id.slice(0, 6)}`,
    opts.content ?? "body",
    JSON.stringify(opts.tags ?? []),
    now,
    now,
    opts.sharedWithTeamId ?? null,
    opts.sharedWithSubteamId ?? null,
    sharedAt,
    opts.parentId ?? null,
  );
  return id;
}

/** Seed a sub-team inside an existing org. Returns the sub-team id. */
function seedSubteam(orgId: string, name?: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  t.db.prepare(
    `INSERT INTO teams (id, org_id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, orgId, name ?? `subteam-${id.slice(0, 6)}`, now, now);
  return id;
}

/** Pin a user to a sub-team (users.team_id post-migration 026). */
function setUserSubteam(userId: string, subteamId: string | null): void {
  t.db.prepare(`UPDATE users SET team_id = ? WHERE id = ?`).run(subteamId, userId);
}

function seedTeam(): string {
  const orgId = randomUUID();
  // Need an owner user to satisfy teams.owner_id FK; create then assign.
  const owner = seedUser(t.db);
  const now = new Date().toISOString();
  t.db.prepare(
    `INSERT INTO orgs (id, name, owner_id, plan, created_at, updated_at)
     VALUES (?, ?, ?, 'team', ?, ?)`,
  ).run(orgId, `team-${orgId.slice(0, 6)}`, owner.id, now, now);
  t.db.prepare(`UPDATE users SET org_id = ?, org_role = 'owner' WHERE id = ?`).run(
    orgId,
    owner.id,
  );
  return orgId;
}

describe("getBacklinks", () => {
  it("finds children via parent_memory_id", () => {
    const u = seedUser(t.db);
    const root = seedMemory({ userId: u.id, title: "root" });
    const c1 = seedMemory({ userId: u.id, title: "c1", parentId: root });
    const c2 = seedMemory({ userId: u.id, title: "c2", parentId: root });

    const backlinks = getBacklinks(t.db, u.id, root);
    const ids = backlinks.map((b) => b.id);
    expect(ids).toContain(c1);
    expect(ids).toContain(c2);
    for (const b of backlinks) expect(b.relation).toBe("child");
  });

  it("finds memories that mention the target id in their content", () => {
    const u = seedUser(t.db);
    const target = seedMemory({ userId: u.id, title: "target" });
    const ref = seedMemory({
      userId: u.id,
      title: "ref",
      content: `See related memory ${target} for background.`,
    });
    const unrelated = seedMemory({ userId: u.id, title: "unrelated", content: "nope" });

    const backlinks = getBacklinks(t.db, u.id, target);
    const ids = backlinks.map((b) => b.id);
    expect(ids).toContain(ref);
    expect(ids).not.toContain(unrelated);
    expect(backlinks.find((b) => b.id === ref)?.relation).toBe("references");
  });

  it("respects team-shared visibility (sees teammate's references)", () => {
    const orgId = seedTeam();
    const tamer = seedUser(t.db, { orgId });
    const van = seedUser(t.db, { orgId });
    t.db.prepare(`UPDATE users SET org_role = 'owner' WHERE id = ?`).run(tamer.id);
    t.db.prepare(`UPDATE users SET org_role = 'member' WHERE id = ?`).run(van.id);

    const tamerMem = seedMemory({ userId: tamer.id, sharedWithTeamId: orgId });
    const vanRef = seedMemory({
      userId: van.id,
      content: `Tracking against ${tamerMem}`,
      sharedWithTeamId: orgId,
    });

    // Tamer's perspective should include Van's reference.
    const backlinks = getBacklinks(t.db, tamer.id, tamerMem);
    expect(backlinks.map((b) => b.id)).toContain(vanRef);
  });

  it("excludes memories the caller cannot see", () => {
    const u = seedUser(t.db);
    const stranger = seedUser(t.db);
    const target = seedMemory({ userId: u.id });
    seedMemory({ userId: stranger.id, content: `mentions ${target}` });

    const backlinks = getBacklinks(t.db, u.id, target);
    expect(backlinks).toEqual([]);
  });

  it("respects sub-team-shared visibility (post migration-026)", () => {
    // Two teammates in the same org but only one is on the Engineering
    // sub-team; the other is on Sales. A sub-team-scoped memory by the
    // eng member must be visible to other eng members and invisible to
    // the sales member, even though they share an org.
    const orgId = seedTeam();
    const eng = seedSubteam(orgId, "Engineering");
    const sales = seedSubteam(orgId, "Sales");
    const engA = seedUser(t.db, { orgId });
    const engB = seedUser(t.db, { orgId });
    const salesA = seedUser(t.db, { orgId });
    setUserSubteam(engA.id, eng);
    setUserSubteam(engB.id, eng);
    setUserSubteam(salesA.id, sales);

    const target = seedMemory({ userId: engA.id, sharedWithSubteamId: eng });
    const teammateRef = seedMemory({
      userId: engB.id,
      content: `following up on ${target}`,
      sharedWithSubteamId: eng,
    });
    // Sales member references it too but their own memory isn't in any
    // pool engA can see.
    seedMemory({ userId: salesA.id, content: `from sales ${target}` });

    // engA sees the teammate's reference (sub-team-shared by engB).
    const fromEngA = getBacklinks(t.db, engA.id, target);
    expect(fromEngA.map((b) => b.id)).toContain(teammateRef);

    // salesA can't even see the target memory itself, let alone backlinks.
    expect(getGraphAround(t.db, salesA.id, target)).toBeNull();
  });
});

describe("getGraphAround", () => {
  it("returns null when the center memory is not visible to caller", () => {
    const u = seedUser(t.db);
    const stranger = seedUser(t.db);
    const m = seedMemory({ userId: stranger.id });
    expect(getGraphAround(t.db, u.id, m)).toBeNull();
  });

  it("returns center + parent + children + siblings", () => {
    const u = seedUser(t.db);
    const root = seedMemory({ userId: u.id, title: "root" });
    const a = seedMemory({ userId: u.id, title: "a", parentId: root });
    const b = seedMemory({ userId: u.id, title: "b", parentId: root });
    const c = seedMemory({ userId: u.id, title: "c", parentId: root });

    // From child b: parent = root, siblings = [a, c], children = []
    const around = getGraphAround(t.db, u.id, b);
    expect(around).not.toBeNull();
    expect(around!.center.id).toBe(b);
    expect(around!.parent?.id).toBe(root);
    expect(around!.siblings.map((s) => s.id).sort()).toEqual([a, c].sort());
    expect(around!.children).toEqual([]);

    // From the root: parent = null, siblings = [], children = [a, b, c]
    const aroundRoot = getGraphAround(t.db, u.id, root);
    expect(aroundRoot!.parent).toBeNull();
    expect(aroundRoot!.siblings).toEqual([]);
    expect(aroundRoot!.children.map((c) => c.id).sort()).toEqual([a, b, c].sort());
  });

  it("surfaces tag-similar memories above the threshold", () => {
    const u = seedUser(t.db);
    const center = seedMemory({
      userId: u.id,
      title: "center",
      tags: ["eng", "auth", "p1"],
    });
    const heavyOverlap = seedMemory({
      userId: u.id,
      title: "heavy",
      tags: ["eng", "auth", "bug"],
    }); // shares 2: eng, auth
    const lightOverlap = seedMemory({
      userId: u.id,
      title: "light",
      tags: ["eng", "dashboard"],
    }); // shares 1: eng
    const noOverlap = seedMemory({
      userId: u.id,
      title: "none",
      tags: ["product", "marketing"],
    });

    const around = getGraphAround(t.db, u.id, center, { minSharedTags: 2 });
    const ids = around!.tag_similar.map((t) => t.id);
    expect(ids).toContain(heavyOverlap);
    expect(ids).not.toContain(lightOverlap);
    expect(ids).not.toContain(noOverlap);
    const heavy = around!.tag_similar.find((t) => t.id === heavyOverlap)!;
    expect(heavy.shared_tag_count).toBe(2);
  });

  it("populates references (memories the center mentions) and referenced_by (the inverse)", () => {
    const u = seedUser(t.db);
    const a = seedMemory({ userId: u.id, title: "A" });
    const b = seedMemory({ userId: u.id, title: "B", content: `See ${a}` });
    const c = seedMemory({ userId: u.id, title: "C", content: `Both ${a} and ${b}` });

    // Around B: B references A; B is referenced by C
    const around = getGraphAround(t.db, u.id, b);
    expect(around!.references.map((r) => r.id)).toEqual([a]);
    expect(around!.referenced_by.map((r) => r.id)).toEqual([c]);
  });
});

describe("getTagCooccurrence", () => {
  it("returns dedupe pairs with a < b", () => {
    const u = seedUser(t.db);
    seedMemory({ userId: u.id, tags: ["a", "b"] });
    seedMemory({ userId: u.id, tags: ["a", "b", "c"] });
    seedMemory({ userId: u.id, tags: ["b", "c"] });

    const { pairs, tagFrequencies } = getTagCooccurrence(t.db, {
      scope: "personal",
      userId: u.id,
    });
    // pairs: (a,b)=2, (a,c)=1, (b,c)=2 — all with a < b
    expect(pairs.length).toBe(3);
    for (const p of pairs) expect(p.tag_a < p.tag_b).toBe(true);
    const ab = pairs.find((p) => p.tag_a === "a" && p.tag_b === "b");
    expect(ab?.count).toBe(2);
    expect(tagFrequencies.get("a")).toBe(2);
    expect(tagFrequencies.get("b")).toBe(3);
  });

  it("scope=team returns only team-shared cooccurrences", () => {
    const orgId = seedTeam();
    const owner = seedUser(t.db, { orgId });
    seedMemory({ userId: owner.id, tags: ["x", "y"], sharedWithTeamId: orgId });
    seedMemory({ userId: owner.id, tags: ["y", "z"] }); // not shared

    const { pairs } = getTagCooccurrence(t.db, {
      scope: "team",
      userId: owner.id,
      orgId,
    });
    // Only the (x,y) pair (the shared one) should appear.
    expect(pairs.length).toBe(1);
    expect(pairs[0]).toMatchObject({ tag_a: "x", tag_b: "y", count: 1 });
  });

  it("scope=team unions org-wide and sub-team-shared cooccurrences", () => {
    const orgId = seedTeam();
    const eng = seedSubteam(orgId, "Engineering");
    const owner = seedUser(t.db, { orgId });
    setUserSubteam(owner.id, eng);
    // Org-wide-shared row contributes (a,b).
    seedMemory({ userId: owner.id, tags: ["a", "b"], sharedWithTeamId: orgId });
    // Sub-team-shared row contributes (c,d) — must surface for an
    // eng-team caller.
    seedMemory({ userId: owner.id, tags: ["c", "d"], sharedWithSubteamId: eng });
    // Personal-only row must NOT surface.
    seedMemory({ userId: owner.id, tags: ["e", "f"] });

    const { pairs } = getTagCooccurrence(t.db, {
      scope: "team",
      userId: owner.id,
      orgId,
      subteamId: eng,
    });
    const pairKeys = pairs.map((p) => `${p.tag_a}-${p.tag_b}`).sort();
    expect(pairKeys).toEqual(["a-b", "c-d"]);
  });

  it("filters out low-count pairs and low-frequency tags", () => {
    const u = seedUser(t.db);
    seedMemory({ userId: u.id, tags: ["a", "b"] });
    seedMemory({ userId: u.id, tags: ["a", "b"] });
    seedMemory({ userId: u.id, tags: ["a", "rare"] }); // rare appears only once

    const { pairs } = getTagCooccurrence(t.db, {
      scope: "personal",
      userId: u.id,
      minCount: 2,
      minTagFrequency: 2,
    });
    // (a,b) has count=2, both tags frequency >= 2. (a,rare) has count=1 → drop.
    expect(pairs.length).toBe(1);
    expect(pairs[0]).toMatchObject({ tag_a: "a", tag_b: "b", count: 2 });
  });
});
