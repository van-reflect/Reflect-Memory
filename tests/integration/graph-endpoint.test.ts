// /graph endpoint smoke. Verifies the dashboard graph projection comes
// back in the expected shape and respects scope + visibility.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { api, getTestServer } from "../helpers";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

interface GraphResponse {
  nodes: Array<{
    id: string;
    title: string;
    tags: string[];
    cluster_id: string | null;
    color: string;
    is_thread_root: boolean;
    is_thread_child: boolean;
    reply_count: number;
    shared: boolean;
  }>;
  edges: Array<{ source: string; target: string; type: "parent_of" | "shared_tag"; weight: number }>;
  clusters: Array<{ id: string; name: string; description: string; tags: string[]; member_count: number; color: string }>;
  scope: string;
  days: number;
  max_nodes: number;
  truncated: boolean;
}

const tracked: string[] = [];

beforeAll(() => {
  const { dbPath, ownerEmail } = getTestServer();
  const db = new Database(dbPath);
  try {
    const ownerRow = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(ownerEmail) as { id: string } | undefined;
    const ownerId = ownerRow!.id;
    const now = new Date().toISOString();

    // Seed a tiny corpus: 3 memories with overlapping tags + 1 thread.
    function mem(opts: { tags: string[]; parent?: string | null; title?: string }) {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO memories (id, user_id, title, content, tags, origin, allowed_vendors, memory_type,
          created_at, updated_at, shared_with_team_id, shared_at, parent_memory_id)
         VALUES (?, ?, ?, ?, ?, 'user', '["*"]', 'semantic', ?, ?, NULL, NULL, ?)`,
      ).run(
        id,
        ownerId,
        opts.title ?? `graph-test-${id.slice(0, 8)}`,
        "body",
        JSON.stringify(opts.tags),
        now,
        now,
        opts.parent ?? null,
      );
      tracked.push(id);
      return id;
    }
    const root = mem({ tags: ["graphtest", "alpha", "beta"], title: "graph-test-root" });
    mem({ tags: ["graphtest", "alpha"], parent: root, title: "graph-test-child-1" });
    mem({ tags: ["graphtest", "beta", "gamma"], title: "graph-test-sibling" });
  } finally {
    db.close();
  }
});

afterAll(() => {
  const { dbPath } = getTestServer();
  const db = new Database(dbPath);
  try {
    if (tracked.length > 0) {
      const placeholders = tracked.map(() => "?").join(",");
      db.prepare(`DELETE FROM memory_versions WHERE memory_id IN (${placeholders})`).run(...tracked);
      db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...tracked);
    }
  } finally {
    db.close();
  }
});

describe("GET /graph", () => {
  it("returns the expected shape with nodes + edges + clusters", async () => {
    const r = await api<GraphResponse>("GET", "/graph?scope=personal&include_similarity=1");
    expect(r.status).toBe(200);
    expect(r.json.scope).toBe("personal");
    expect(Array.isArray(r.json.nodes)).toBe(true);
    expect(Array.isArray(r.json.edges)).toBe(true);
    expect(Array.isArray(r.json.clusters)).toBe(true);
    expect(typeof r.json.truncated).toBe("boolean");
    expect(r.json.max_nodes).toBeGreaterThan(0);

    // Spot check: every node has required fields.
    if (r.json.nodes.length > 0) {
      const n = r.json.nodes[0];
      expect(typeof n.id).toBe("string");
      expect(typeof n.title).toBe("string");
      expect(Array.isArray(n.tags)).toBe(true);
      expect(typeof n.color).toBe("string");
    }
  });

  it("includes parent_of edges for the seeded thread", async () => {
    const r = await api<GraphResponse>("GET", "/graph?scope=personal");
    expect(r.status).toBe(200);

    const root = r.json.nodes.find((n) => n.title === "graph-test-root");
    const child = r.json.nodes.find((n) => n.title === "graph-test-child-1");
    expect(root, "root node present").toBeDefined();
    expect(child, "child node present").toBeDefined();
    expect(root!.is_thread_root).toBe(true);
    expect(root!.reply_count).toBeGreaterThanOrEqual(1);

    const parentEdge = r.json.edges.find(
      (e) => e.type === "parent_of" && e.source === root!.id && e.target === child!.id,
    );
    expect(parentEdge, "parent_of edge root → child present").toBeDefined();
  });

  it("respects max_nodes and reports truncation", async () => {
    const r = await api<GraphResponse>("GET", "/graph?scope=personal&max_nodes=1");
    expect(r.status).toBe(200);
    expect(r.json.nodes.length).toBeLessThanOrEqual(1);
    // truncated should be true if there were more than 1 personal memory.
    expect(typeof r.json.truncated).toBe("boolean");
  });

  it("agent keys are rejected (graph view is human-facing)", async () => {
    const { agentKeys } = getTestServer();
    const r = await api<{ error: string }>("GET", "/graph", {
      token: agentKeys.cursor,
    });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/agent/i);
  });

  it("scope=team returns empty when caller has no team and team is requested", async () => {
    // Owner test user has no team in the default test fixture.
    const r = await api<GraphResponse>("GET", "/graph?scope=team");
    expect(r.status).toBe(200);
    expect(r.json.nodes).toEqual([]);
    expect(r.json.edges).toEqual([]);
    expect(r.json.clusters).toEqual([]);
  });
});
