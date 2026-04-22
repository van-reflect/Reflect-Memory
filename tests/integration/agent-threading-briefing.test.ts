// ChatGPT/agent parity tests: threading + briefing on the /agent/* surface.
//
// Threading + briefing landed for users (dashboard) and via MCP. ChatGPT
// CustomGPTs use the OAuth-protected HTTP API instead of MCP, so the
// /agent/* routes need their own surface for these features. This file
// proves three things end-to-end against the ephemeral test server:
//
//   1. POST /agent/memories/:id/children  — write a reply via agent path
//   2. GET  /agent/memories/:id/thread    — read a thread via agent path
//   3. GET  /agent/briefing               — get the briefing via agent path
//
// Also verifies the OpenAPI spec exposes all three operations so ChatGPT
// can discover them when re-importing the action manifest.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, getTestServer, withAgentKey } from "../helpers";

interface MemoryResponse {
  id: string;
  title: string;
  content: string;
  tags: string[];
  parent_memory_id?: string | null;
  shared_with_team_id?: string | null;
  allowed_vendors?: string[];
}

interface ThreadResponse {
  parent: MemoryResponse;
  children: MemoryResponse[];
}

interface BriefingResponse {
  user: { id: string; email: string | null };
  totals: {
    personal_memories: number;
    personal_memories_shared: number;
    team_pool_total: number;
  };
  personal_tags: Array<{ tag: string; count: number }>;
  team_tags: Array<{ tag: string; count: number }>;
  recent_tags: Array<{ tag: string; count: number }>;
  active_threads: Array<{ memory_id: string; reply_count: number }>;
  detected_conventions: string[];
}

const seededIds: string[] = [];
let parentId: string;
let childId: string;

beforeAll(async () => {
  // Use the agent (cursor) key to write memories, exercising the agent path
  // end-to-end. Track ids for cleanup.
  const agentKey = withAgentKey("cursor");

  const parent = await api<MemoryResponse>("POST", "/agent/memories", {
    token: agentKey,
    body: {
      title: "agent-threading-parent",
      content: "Parent body",
      tags: ["agent-threading-test", "p1"],
      allowed_vendors: ["*"],
    },
  });
  expect(parent.status).toBe(201);
  parentId = parent.json.id;
  seededIds.push(parentId);

  const child = await api<MemoryResponse>(
    "POST",
    `/agent/memories/${parentId}/children`,
    {
      token: agentKey,
      body: {
        title: "agent-threading-reply",
        content: "Reply body",
        tags: ["agent-threading-test"],
        allowed_vendors: ["*"],
      },
    },
  );
  expect(child.status).toBe(201);
  childId = child.json.id;
  seededIds.push(childId);
});

afterAll(() => {
  const { dbPath } = getTestServer();
  const db = new Database(dbPath);
  try {
    if (seededIds.length > 0) {
      const placeholders = seededIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM memory_versions WHERE memory_id IN (${placeholders})`).run(
        ...seededIds,
      );
      db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(
        ...seededIds,
      );
    }
  } finally {
    db.close();
  }
});

describe("POST /agent/memories/:id/children", () => {
  it("created child carries parent_memory_id (verified in setup, asserted here)", () => {
    expect(childId).toBeTruthy();
    expect(childId).not.toBe(parentId);
  });

  it("rejects grandchildren (one-level enforcement)", async () => {
    const r = await api<{ error?: string }>(
      "POST",
      `/agent/memories/${childId}/children`,
      {
        token: withAgentKey("cursor"),
        body: {
          title: "grandchild",
          content: "should fail",
          tags: [],
          allowed_vendors: ["*"],
        },
      },
    );
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/one level/i);
  });

  it("404 when parent does not exist", async () => {
    const r = await api<{ error?: string }>(
      "POST",
      `/agent/memories/${randomUUID()}/children`,
      {
        token: withAgentKey("cursor"),
        body: {
          title: "ghost",
          content: "x",
          tags: [],
          allowed_vendors: ["*"],
        },
      },
    );
    expect(r.status).toBe(404);
  });
});

describe("GET /agent/memories/:id/thread", () => {
  it("returns parent + children when given the parent id", async () => {
    const r = await api<ThreadResponse>(
      "GET",
      `/agent/memories/${parentId}/thread`,
      { token: withAgentKey("cursor") },
    );
    expect(r.status).toBe(200);
    expect(r.json.parent.id).toBe(parentId);
    expect(r.json.children.map((c) => c.id)).toContain(childId);
  });

  it("returns the same thread when given a child id (roots at parent)", async () => {
    const r = await api<ThreadResponse>(
      "GET",
      `/agent/memories/${childId}/thread`,
      { token: withAgentKey("cursor") },
    );
    expect(r.status).toBe(200);
    expect(r.json.parent.id).toBe(parentId);
    expect(r.json.children.some((c) => c.id === childId)).toBe(true);
  });

  it("404 when memory id does not exist", async () => {
    const r = await api("GET", `/agent/memories/${randomUUID()}/thread`, {
      token: withAgentKey("cursor"),
    });
    expect(r.status).toBe(404);
  });
});

describe("GET /agent/briefing", () => {
  it("returns structured briefing with our seed tags + threads visible", async () => {
    const r = await api<BriefingResponse>("GET", "/agent/briefing", {
      token: withAgentKey("cursor"),
    });
    expect(r.status).toBe(200);
    expect(r.json.user).toBeTruthy();
    const personalByTag = Object.fromEntries(
      r.json.personal_tags.map((t) => [t.tag, t.count]),
    );
    expect(personalByTag["agent-threading-test"]).toBeGreaterThanOrEqual(2);
    expect(personalByTag["p1"]).toBeGreaterThanOrEqual(1);
    const thread = r.json.active_threads.find((t) => t.memory_id === parentId);
    expect(thread).toBeDefined();
    expect(thread?.reply_count).toBeGreaterThanOrEqual(1);
  });

  it("returns markdown when ?format=markdown", async () => {
    const r = await api<unknown>("GET", "/agent/briefing?format=markdown", {
      token: withAgentKey("cursor"),
    });
    expect(r.status).toBe(200);
    expect(r.text).toContain("# Reflect Memory — session briefing");
  });

  it("respects top_tags query param", async () => {
    const r = await api<BriefingResponse>(
      "GET",
      "/agent/briefing?top_tags=1",
      { token: withAgentKey("cursor") },
    );
    expect(r.status).toBe(200);
    expect(r.json.personal_tags.length).toBe(1);
  });
});

describe("OpenAPI spec coverage (what ChatGPT actually sees)", () => {
  it("/openapi.json declares writeChildMemory / readThread / getMemoryBriefing", async () => {
    interface Spec {
      paths: Record<string, Record<string, { operationId?: string }>>;
    }
    const r = await api<Spec>("GET", "/openapi.json", { token: null });
    expect(r.status).toBe(200);

    const ops = new Set<string>();
    for (const methods of Object.values(r.json.paths)) {
      for (const op of Object.values(methods)) {
        if (op.operationId) ops.add(op.operationId);
      }
    }

    for (const required of ["writeChildMemory", "readThread", "getMemoryBriefing"]) {
      expect(ops.has(required), `missing operation in openapi.json: ${required}`).toBe(true);
    }
  });

  it("each new operation is on the expected path", async () => {
    interface Spec {
      paths: Record<string, Record<string, { operationId?: string }>>;
    }
    const r = await api<Spec>("GET", "/openapi.json", { token: null });

    expect(r.json.paths["/agent/memories/{id}/children"]?.post?.operationId).toBe(
      "writeChildMemory",
    );
    expect(r.json.paths["/agent/memories/{id}/thread"]?.get?.operationId).toBe(
      "readThread",
    );
    expect(r.json.paths["/agent/briefing"]?.get?.operationId).toBe("getMemoryBriefing");
  });
});
