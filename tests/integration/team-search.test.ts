// Team Shared search integration tests.
// Provisions a team in the test DB, drops the primary test user onto it,
// seeds a handful of shared memories (mix of authors, tags, bodies), then
// exercises GET /orgs/:id/memories?term=... across the four match axes
// the ticket asks for: title, content, tags, author name.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, getTestServer } from "../helpers";

interface TeamMemoryEntry {
  id: string;
  title: string;
  content: string;
  tags: string[];
  author_email: string;
  author_first_name: string | null;
  author_last_name: string | null;
  shared_at: string | null;
}

interface ListResponse {
  memories: TeamMemoryEntry[];
  total: number;
  term?: string;
}

let orgId: string;
let teammateUserId: string;
let ownerUserId: string;
const seededMemoryIds: string[] = [];

beforeAll(() => {
  const { dbPath, ownerEmail } = getTestServer();
  const db = new Database(dbPath);
  try {
    ownerUserId = (
      db.prepare("SELECT id FROM users WHERE email = ?").get(ownerEmail) as
        | { id: string }
        | undefined
    )?.id!;
    expect(ownerUserId).toBeTruthy();

    orgId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO orgs (id, name, owner_id, plan, created_at, updated_at)
       VALUES (?, ?, ?, 'team', ?, ?)`,
    ).run(orgId, "Search-Test-Team", ownerUserId, now, now);

    db.prepare(
      `UPDATE users SET org_id = ?, org_role = 'owner', first_name = 'Olivia', last_name = 'Owner' WHERE id = ?`,
    ).run(orgId, ownerUserId);

    teammateUserId = randomUUID();
    db.prepare(
      `INSERT INTO users (id, email, role, plan, org_id, org_role, first_name, last_name, created_at, updated_at)
       VALUES (?, ?, 'user', 'team', ?, 'member', 'Tammy', 'Teammate', ?, ?)`,
    ).run(teammateUserId, "tammy-search@test.local", orgId, now, now);

    interface Seed {
      author: string;
      title: string;
      content: string;
      tags: string[];
    }
    const seeds: Seed[] = [
      {
        author: ownerUserId,
        title: "Stripe webhook idempotency notes",
        content: "We dedupe via event.id; replays are safe.",
        tags: ["stripe", "billing"],
      },
      {
        author: ownerUserId,
        title: "Onboarding runbook",
        content: "Step 1 is the email DNS fix. Then add SSO.",
        tags: ["onboarding", "ops"],
      },
      {
        author: teammateUserId,
        title: "Frontend bundle audit",
        content: "Tailwind v4 shaved 40% off the CSS bundle.",
        tags: ["frontend", "performance"],
      },
      {
        author: teammateUserId,
        title: "Unrelated scratch note",
        content: "Nothing special here.",
        tags: ["scratch"],
      },
    ];

    for (const s of seeds) {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO memories
          (id, user_id, title, content, tags, origin, allowed_vendors,
           created_at, updated_at, shared_with_org_id, shared_at)
         VALUES (?, ?, ?, ?, ?, 'api', '["*"]', ?, ?, ?, ?)`,
      ).run(
        id,
        s.author,
        s.title,
        s.content,
        JSON.stringify(s.tags),
        now,
        now,
        orgId,
        now,
      );
      seededMemoryIds.push(id);
    }
  } finally {
    db.close();
  }
});

afterAll(() => {
  const { dbPath } = getTestServer();
  const db = new Database(dbPath);
  try {
    const placeholders = seededMemoryIds.map(() => "?").join(",");
    if (seededMemoryIds.length > 0) {
      db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(
        ...seededMemoryIds,
      );
    }
    db.prepare("DELETE FROM users WHERE id = ?").run(teammateUserId);
    db.prepare("UPDATE users SET org_id = NULL, org_role = NULL WHERE id = ?").run(
      ownerUserId,
    );
    db.prepare("DELETE FROM orgs WHERE id = ?").run(orgId);
  } finally {
    db.close();
  }
});

describe("GET /orgs/:id/memories (search)", () => {
  it("returns the full pool when no term is provided", async () => {
    const r = await api<ListResponse>("GET", `/orgs/${orgId}/memories`);
    expect(r.status).toBe(200);
    expect(r.json.memories.length).toBe(seededMemoryIds.length);
    expect(r.json.term).toBeUndefined();
  });

  it("matches on title (case-insensitive)", async () => {
    const r = await api<ListResponse>("GET", `/orgs/${orgId}/memories?term=STRIPE`);
    expect(r.status).toBe(200);
    expect(r.json.term).toBe("STRIPE");
    expect(r.json.memories.map((m) => m.title)).toEqual([
      "Stripe webhook idempotency notes",
    ]);
    expect(r.json.total).toBe(1);
  });

  it("matches on content body", async () => {
    const r = await api<ListResponse>("GET", `/orgs/${orgId}/memories?term=tailwind`);
    expect(r.status).toBe(200);
    expect(r.json.memories.map((m) => m.title)).toEqual(["Frontend bundle audit"]);
  });

  it("matches on tags (substring)", async () => {
    const r = await api<ListResponse>(
      "GET",
      `/orgs/${orgId}/memories?term=performance`,
    );
    expect(r.status).toBe(200);
    expect(r.json.memories.map((m) => m.title)).toEqual(["Frontend bundle audit"]);
  });

  it("matches on author first name", async () => {
    const r = await api<ListResponse>("GET", `/orgs/${orgId}/memories?term=Tammy`);
    expect(r.status).toBe(200);
    const titles = r.json.memories.map((m) => m.title).sort();
    expect(titles).toEqual(["Frontend bundle audit", "Unrelated scratch note"].sort());
  });

  it("matches on author email fragment", async () => {
    const r = await api<ListResponse>(
      "GET",
      `/orgs/${orgId}/memories?term=tammy-search`,
    );
    expect(r.status).toBe(200);
    expect(r.json.memories.length).toBe(2);
  });

  it("returns empty set (not an error) when nothing matches", async () => {
    const r = await api<ListResponse>(
      "GET",
      `/orgs/${orgId}/memories?term=xyzzy-no-match-expected`,
    );
    expect(r.status).toBe(200);
    expect(r.json.memories).toEqual([]);
    expect(r.json.total).toBe(0);
  });

  it("whitespace-only term is treated as no-term (full list)", async () => {
    const r = await api<ListResponse>(
      "GET",
      `/orgs/${orgId}/memories?term=${encodeURIComponent("   ")}`,
    );
    expect(r.status).toBe(200);
    expect(r.json.memories.length).toBe(seededMemoryIds.length);
    expect(r.json.term).toBeUndefined();
  });

  it("escapes SQL LIKE wildcards so % matches the literal char, not everything", async () => {
    // One seed contains "40%"; if escape were missing, LIKE '%%%' would
    // match every row. Properly escaped, LIKE '%\%%' matches only rows
    // that contain a literal "%".
    const r = await api<ListResponse>(
      "GET",
      `/orgs/${orgId}/memories?term=${encodeURIComponent("%")}`,
    );
    expect(r.status).toBe(200);
    expect(r.json.memories.length).toBe(1);
    expect(r.json.memories[0].title).toBe("Frontend bundle audit");
  });
});
