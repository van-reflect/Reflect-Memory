// Phase 2.3 — Agent key restrictions.
// Covers route whitelist (only /health, /whoami, /query, /agent/*, /mcp* allowed),
// origin tagging, and vendor scoping (allowed_vendors filtering across read paths).

import { describe, it, expect } from "vitest";
import { api, uniqueTag, withAgentKey } from "../helpers";

interface MemoryRecord {
  id: string;
  origin: string;
  allowed_vendors: string[];
  tags: string[];
}

describe("agent route whitelist", () => {
  // Routes that an agent key MUST NOT be able to call. Mix of methods + endpoints.
  const forbidden: Array<{ method: string; path: string; body?: unknown }> = [
    { method: "POST", path: "/memories", body: { title: "x", content: "x", tags: ["x"], allowed_vendors: ["*"] } },
    { method: "POST", path: "/memories/list", body: { limit: 5 } },
    { method: "GET", path: "/api/keys" },
    { method: "POST", path: "/api/keys", body: { label: "agent-cant-do-this" } },
    { method: "GET", path: "/usage" },
    { method: "GET", path: "/usage/check" },
    { method: "POST", path: "/billing/checkout", body: { plan: "pro" } },
    { method: "GET", path: "/admin/check" },
    { method: "GET", path: "/admin/users" },
    { method: "GET", path: "/admin/metrics" },
    { method: "DELETE", path: "/memories/trash" },
  ];

  it.each(forbidden)("$method $path with agent key -> 403", async ({ method, path, body }) => {
    const r = await api(method, path, { token: withAgentKey("cursor"), body });
    expect(r.status).toBe(403);
  });

  it("agent key on /health -> 200 (allowed)", async () => {
    const r = await api("GET", "/health", { token: withAgentKey("cursor") });
    expect(r.status).toBe(200);
  });

  it("agent key on /whoami -> 200 with role=agent + correct vendor", async () => {
    const r = await api<{ role: string; vendor: string | null }>("GET", "/whoami", {
      token: withAgentKey("claude"),
    });
    expect(r.status).toBe(200);
    expect(r.json.role).toBe("agent");
    expect(r.json.vendor).toBe("claude");
  });

  it("agent key on /agent/memories/* -> not 403", async () => {
    const tag = uniqueTag("agent-allowed");
    const w = await api("POST", "/agent/memories", {
      token: withAgentKey("cursor"),
      body: {
        title: `allowed ${tag}`,
        content: `agent-write-allowed ${tag}`,
        tags: [tag],
        allowed_vendors: ["*"],
      },
    });
    expect(w.status).not.toBe(403);
    expect(w.status).toBe(201);
  });
});

describe("origin tagging", () => {
  it("memory written by cursor agent has origin=cursor", async () => {
    const tag = uniqueTag("origin-c");
    const w = await api<MemoryRecord>("POST", "/agent/memories", {
      token: withAgentKey("cursor"),
      body: {
        title: `origin cursor ${tag}`,
        content: `cursor-origin-payload ${tag}`,
        tags: [tag],
        allowed_vendors: ["*"],
      },
    });
    expect(w.status).toBe(201);
    expect(w.json.origin).toBe("cursor");
  });

  it("memory written by claude agent has origin=claude", async () => {
    const tag = uniqueTag("origin-cl");
    const w = await api<MemoryRecord>("POST", "/agent/memories", {
      token: withAgentKey("claude"),
      body: {
        title: `origin claude ${tag}`,
        content: `claude-origin-payload ${tag}`,
        tags: [tag],
        allowed_vendors: ["*"],
      },
    });
    expect(w.status).toBe(201);
    expect(w.json.origin).toBe("claude");
  });
});

describe("vendor scoping (allowed_vendors filtering)", () => {
  it("vendor-locked memory is hidden from other vendors on by-tag", async () => {
    const tag = uniqueTag("vlock");

    // Cursor writes a memory restricted to cursor only.
    const w = await api<MemoryRecord>("POST", "/agent/memories", {
      token: withAgentKey("cursor"),
      body: {
        title: `cursor-only ${tag}`,
        content: `cursor-only-content ${tag}`,
        tags: [tag],
        allowed_vendors: ["cursor"],
      },
    });
    expect(w.status).toBe(201);

    // Cursor sees it.
    const cursorRead = await api<{ memories: MemoryRecord[] }>("POST", "/agent/memories/by-tag", {
      token: withAgentKey("cursor"),
      body: { tags: [tag] },
    });
    expect(cursorRead.status).toBe(200);
    expect(cursorRead.json.memories.some((m) => m.id === w.json.id)).toBe(true);

    // Claude does not.
    const claudeRead = await api<{ memories: MemoryRecord[] }>("POST", "/agent/memories/by-tag", {
      token: withAgentKey("claude"),
      body: { tags: [tag] },
    });
    expect(claudeRead.status).toBe(200);
    expect(claudeRead.json.memories.some((m) => m.id === w.json.id)).toBe(false);
  });

  it('"*" allowed_vendors makes a memory visible to all agents', async () => {
    const tag = uniqueTag("vall");

    const w = await api<MemoryRecord>("POST", "/agent/memories", {
      token: withAgentKey("cursor"),
      body: {
        title: `wildcard ${tag}`,
        content: `wildcard-allowed-vendors ${tag}`,
        tags: [tag],
        allowed_vendors: ["*"],
      },
    });
    expect(w.status).toBe(201);

    const claudeRead = await api<{ memories: MemoryRecord[] }>("POST", "/agent/memories/by-tag", {
      token: withAgentKey("claude"),
      body: { tags: [tag] },
    });
    expect(claudeRead.status).toBe(200);
    expect(claudeRead.json.memories.some((m) => m.id === w.json.id)).toBe(true);
  });

  it("vendor-locked memory is hidden from other vendors on GET /agent/memories/:id", async () => {
    const tag = uniqueTag("vget");
    const w = await api<MemoryRecord>("POST", "/agent/memories", {
      token: withAgentKey("cursor"),
      body: {
        title: `cursor-private ${tag}`,
        content: `cursor-private-body ${tag}`,
        tags: [tag],
        allowed_vendors: ["cursor"],
      },
    });
    expect(w.status).toBe(201);

    const claudeGet = await api("GET", `/agent/memories/${w.json.id}`, {
      token: withAgentKey("claude"),
    });
    // Either 403 (forbidden) or 404 (treated as not-found) is acceptable; both prevent leak.
    expect([403, 404]).toContain(claudeGet.status);
  });

  it("vendor-locked memory is hidden from other vendors on /agent/memories/latest", async () => {
    const tag = uniqueTag("vlatest");
    await api("POST", "/agent/memories", {
      token: withAgentKey("cursor"),
      body: {
        title: `latest cursor-only ${tag}`,
        content: `latest-cursor-body ${tag}`,
        tags: [tag],
        allowed_vendors: ["cursor"],
      },
    });

    const r = await api<{ id?: string; tags?: string[] }>(
      "GET",
      `/agent/memories/latest?tag=${tag}`,
      { token: withAgentKey("claude") },
    );
    // /latest returns 404 when no matching memory found for this tag+vendor combo.
    expect([404, 200]).toContain(r.status);
    if (r.status === 200) {
      // If a memory comes back, it must NOT be the cursor-locked one.
      expect(r.json.tags ?? []).not.toContain(tag);
    }
  });

  it("vendor-locked memory is hidden from other vendors on browse/search", async () => {
    const tag = uniqueTag("vbrowse");
    await api("POST", "/agent/memories", {
      token: withAgentKey("cursor"),
      body: {
        title: `browse cursor-only ${tag}`,
        content: `unique-browse-content-${tag} flamingo telescope`,
        tags: [tag],
        allowed_vendors: ["cursor"],
      },
    });

    const browse = await api<{ memories: Array<{ tags: string[] }> }>(
      "POST",
      "/agent/memories/browse",
      { token: withAgentKey("claude"), body: { filter: { by: "tags", tags: [tag] } } },
    );
    expect(browse.status).toBe(200);
    for (const m of browse.json.memories ?? []) {
      expect(m.tags).not.toContain(tag);
    }

    const search = await api<{ memories: Array<{ tags: string[] }> }>(
      "POST",
      "/agent/memories/search",
      { token: withAgentKey("claude"), body: { term: `unique-browse-content-${tag}` } },
    );
    expect(search.status).toBe(200);
    for (const m of search.json.memories ?? []) {
      expect(m.tags).not.toContain(tag);
    }
  });

  it("cursor sees its own memory on browse + search (positive control)", async () => {
    const tag = uniqueTag("vbrowse-pos");
    const w = await api<MemoryRecord>("POST", "/agent/memories", {
      token: withAgentKey("cursor"),
      body: {
        title: `browse-positive ${tag}`,
        content: `unique-positive-content-${tag} narwhal kaleidoscope`,
        tags: [tag],
        allowed_vendors: ["cursor"],
      },
    });
    expect(w.status).toBe(201);

    const browse = await api<{ memories: Array<{ id: string }> }>(
      "POST",
      "/agent/memories/browse",
      { token: withAgentKey("cursor"), body: { filter: { by: "tags", tags: [tag] } } },
    );
    expect(browse.status).toBe(200);
    expect(browse.json.memories.some((m) => m.id === w.json.id)).toBe(true);

    const search = await api<{ memories: Array<{ id: string }> }>(
      "POST",
      "/agent/memories/search",
      { token: withAgentKey("cursor"), body: { term: `unique-positive-content-${tag}` } },
    );
    expect(search.status).toBe(200);
    expect(search.json.memories.some((m) => m.id === w.json.id)).toBe(true);
  });
});
