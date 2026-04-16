import { describe, it, expect } from "vitest";
import { api, uniqueTag, withAgentKey } from "../helpers";

describe("health and auth", () => {
  it("GET /health returns 200 with status ok", async () => {
    const r = await api<{ status: string; service: string }>("GET", "/health", { token: null });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("ok");
    expect(r.json.service).toBe("reflect-memory");
  });

  it("GET /health has application/json content-type", async () => {
    const r = await api("GET", "/health", { token: null });
    expect(r.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("missing Authorization -> 401", async () => {
    const r = await api("GET", "/whoami", { token: null });
    expect(r.status).toBe(401);
  });

  it("invalid token -> 401", async () => {
    const r = await api("GET", "/whoami", { token: "rm_live_invalid_0000000000000000" });
    expect(r.status).toBe(401);
  });

  it("malformed header (no Bearer) -> 401", async () => {
    const server = (await import("../helpers")).getTestServer();
    const res = await fetch(`${server.baseUrl}/whoami`, {
      headers: { Authorization: server.apiKey },
    });
    expect(res.status).toBe(401);
  });

  it("owner API key -> 200 role=user", async () => {
    const r = await api<{ role: string; vendor: string | null }>("GET", "/whoami");
    expect(r.status).toBe(200);
    expect(r.json.role).toBe("user");
    expect(r.json.vendor).toBeNull();
  });

  it("agent key -> 200 role=agent vendor=cursor", async () => {
    const r = await api<{ role: string; vendor: string | null }>("GET", "/whoami", {
      token: withAgentKey("cursor"),
    });
    expect(r.status).toBe(200);
    expect(r.json.role).toBe("agent");
    expect(r.json.vendor).toBe("cursor");
  });
});

describe("memory write + read (CI-test-mode bypass)", () => {
  it("POST /agent/memories writes and survives (RM_TEST_MODE bypasses quarantine)", async () => {
    const tag = uniqueTag("ci");
    const w = await api<{ id: string; title: string; memory_type: string }>(
      "POST",
      "/agent/memories",
      {
        token: withAgentKey("cursor"),
        body: {
          title: `CI write ${tag}`,
          content: `integration test ${tag}`,
          tags: [tag],
          allowed_vendors: ["*"],
          memory_type: "semantic",
        },
      },
    );
    expect(w.status).toBe(201);
    expect(w.json.id).toBeTruthy();
    expect(w.json.memory_type).toBe("semantic");

    const r = await api<{ id: string; title: string }>(
      "GET",
      `/agent/memories/${w.json.id}`,
      { token: withAgentKey("cursor") },
    );
    expect(r.status).toBe(200);
    expect(r.json.id).toBe(w.json.id);
  });

  it("GET /agent/memories/latest?tag=X returns the written memory", async () => {
    const tag = uniqueTag("ci");
    await api("POST", "/agent/memories", {
      token: withAgentKey("cursor"),
      body: {
        title: `CI latest ${tag}`,
        content: "x",
        tags: [tag],
        allowed_vendors: ["*"],
      },
    });
    const r = await api<{ id: string; tags: string[] }>(
      "GET",
      `/agent/memories/latest?tag=${tag}`,
      { token: withAgentKey("cursor") },
    );
    expect(r.status).toBe(200);
    expect(r.json.tags).toContain(tag);
  });

  it("POST /agent/memories/by-tag returns written memories", async () => {
    const tag = uniqueTag("ci");
    // findSimilarMemory uses jaccard >= 0.5 (title) AND >= 0.4 (content) to dedup.
    // Titles and contents must therefore share <50% / <40% tokens respectively.
    const fixtures = [
      { type: "semantic" as const, title: `alpha note ${tag}`, content: `Paris is the capital of France. Tag ${tag}.` },
      { type: "episodic" as const, title: `beta moment ${tag}`, content: `Yesterday we shipped the v2 migration. Tag ${tag}.` },
      { type: "procedural" as const, title: `gamma recipe ${tag}`, content: `To deploy: build, test, push. Tag ${tag}.` },
    ];
    for (const f of fixtures) {
      await api("POST", "/agent/memories", {
        token: withAgentKey("cursor"),
        body: {
          title: f.title,
          content: f.content,
          tags: [tag],
          allowed_vendors: ["*"],
          memory_type: f.type,
        },
      });
    }
    const r = await api<{ memories: Array<{ id: string; tags: string[] }> }>(
      "POST",
      "/agent/memories/by-tag",
      { token: withAgentKey("cursor"), body: { tags: [tag], limit: 10 } },
    );
    expect(r.status).toBe(200);
    expect(r.json.memories.length).toBeGreaterThanOrEqual(3);
    for (const m of r.json.memories) {
      expect(m.tags).toContain(tag);
    }
  });
});

describe("input validation", () => {
  it("empty title -> 400", async () => {
    const r = await api("POST", "/agent/memories", {
      token: withAgentKey("cursor"),
      body: { title: "", content: "x", tags: ["x"], allowed_vendors: ["*"] },
    });
    expect(r.status).toBe(400);
  });

  it("invalid memory_type -> 400", async () => {
    const r = await api("POST", "/agent/memories", {
      token: withAgentKey("cursor"),
      body: {
        title: "x",
        content: "x",
        tags: ["x"],
        allowed_vendors: ["*"],
        memory_type: "not_a_type",
      },
    });
    expect(r.status).toBe(400);
  });

  it("missing content -> 400", async () => {
    const r = await api("POST", "/agent/memories", {
      token: withAgentKey("cursor"),
      body: { title: "x", tags: ["x"], allowed_vendors: ["*"] },
    });
    expect(r.status).toBe(400);
  });

  it("nonexistent id -> 404", async () => {
    const r = await api("GET", "/agent/memories/00000000-0000-0000-0000-000000000000", {
      token: withAgentKey("cursor"),
    });
    expect(r.status).toBe(404);
  });
});

describe("error shape", () => {
  it("401 response does not leak stack traces or paths", async () => {
    const r = await api("GET", "/whoami", { token: null });
    const body = r.text.toLowerCase();
    expect(body).not.toContain("stack");
    expect(body).not.toContain("/users/");
    expect(body).not.toContain("node_modules");
    expect(body).not.toMatch(/\.ts:/);
  });
});
