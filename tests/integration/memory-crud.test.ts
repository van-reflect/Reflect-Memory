// Phase 2.1 — Memory CRUD integration tests.
// Covers PUT /agent/memories/:id (update), DELETE /agent/memories/:id (soft delete),
// POST /memories/:id/restore, DELETE /memories/:id/permanent, DELETE /memories/trash,
// and version history. Runs against the ephemeral server spawned by global-setup.

import { describe, it, expect } from "vitest";
import { api, uniqueTag, withAgentKey } from "../helpers";

interface Memory {
  id: string;
  title: string;
  content: string;
  tags: string[];
  allowed_vendors: string[];
  origin: string;
  memory_type: string;
  created_at: string;
  updated_at: string;
  version?: number;
}

async function createCursorMemory(tag: string, overrides: Partial<Memory> = {}): Promise<Memory> {
  const r = await api<Memory>("POST", "/agent/memories", {
    token: withAgentKey("cursor"),
    body: {
      title: `seed ${tag}`,
      content: `unique seed body for ${tag} containing distinguishing words zebra orchid`,
      tags: [tag],
      allowed_vendors: ["*"],
      memory_type: "semantic",
      ...overrides,
    },
  });
  if (r.status !== 201) {
    throw new Error(`createCursorMemory failed: ${r.status} ${r.text}`);
  }
  return r.json;
}

describe("PUT /agent/memories/:id (update)", () => {
  it("happy path: title/content/tags/allowed_vendors update is reflected in subsequent GET", async () => {
    const tag = uniqueTag("upd");
    const m = await createCursorMemory(tag);

    const newTag = `${tag}-renamed`;
    const upd = await api<Memory>("PUT", `/agent/memories/${m.id}`, {
      token: withAgentKey("cursor"),
      body: {
        title: `updated title ${tag}`,
        content: `updated content body for ${tag} with totally different vocabulary like piano`,
        tags: [newTag],
        allowed_vendors: ["cursor"],
      },
    });
    expect(upd.status).toBe(200);
    expect(upd.json.id).toBe(m.id);
    expect(upd.json.title).toBe(`updated title ${tag}`);
    expect(upd.json.tags).toEqual([newTag]);
    expect(upd.json.allowed_vendors).toEqual(["cursor"]);

    const got = await api<Memory>("GET", `/agent/memories/${m.id}`, { token: withAgentKey("cursor") });
    expect(got.status).toBe(200);
    expect(got.json.title).toBe(`updated title ${tag}`);
    expect(got.json.tags).toEqual([newTag]);
  });

  it("update preserves id, origin, and memory_type", async () => {
    const tag = uniqueTag("upd");
    const m = await createCursorMemory(tag, { memory_type: "episodic" });

    const upd = await api<Memory>("PUT", `/agent/memories/${m.id}`, {
      token: withAgentKey("cursor"),
      body: {
        title: `episodic-renamed ${tag}`,
        content: `freshly rewritten body ${tag}`,
        tags: [tag],
        allowed_vendors: ["*"],
      },
    });
    expect(upd.status).toBe(200);
    expect(upd.json.id).toBe(m.id);
    expect(upd.json.origin).toBe(m.origin);
    expect(upd.json.memory_type).toBe("episodic");
  });

  it("update bumps updated_at", async () => {
    const tag = uniqueTag("upd");
    const m = await createCursorMemory(tag);

    // Wait at least 1s so the timestamp visibly differs (sqlite timestamps are 1s precision).
    await new Promise((r) => setTimeout(r, 1100));

    const upd = await api<Memory>("PUT", `/agent/memories/${m.id}`, {
      token: withAgentKey("cursor"),
      body: {
        title: `bumped ${tag}`,
        content: `new body ${tag}`,
        tags: [tag],
        allowed_vendors: ["*"],
      },
    });
    expect(upd.status).toBe(200);
    expect(new Date(upd.json.updated_at).getTime()).toBeGreaterThan(
      new Date(m.updated_at).getTime(),
    );
  });

  it("agent cannot update a memory created by a different vendor -> 403", async () => {
    const tag = uniqueTag("upd");
    const m = await createCursorMemory(tag);
    const upd = await api("PUT", `/agent/memories/${m.id}`, {
      token: withAgentKey("claude"),
      body: {
        title: `hijack ${tag}`,
        content: `hijack ${tag}`,
        tags: [tag],
        allowed_vendors: ["*"],
      },
    });
    expect(upd.status).toBe(403);
  });

  it("update on nonexistent id -> 404", async () => {
    const tag = uniqueTag("upd");
    const r = await api("PUT", "/agent/memories/00000000-0000-0000-0000-000000000000", {
      token: withAgentKey("cursor"),
      body: {
        title: `x ${tag}`,
        content: `x ${tag}`,
        tags: [tag],
        allowed_vendors: ["*"],
      },
    });
    expect(r.status).toBe(404);
  });

  it("update on trashed memory -> 404", async () => {
    const tag = uniqueTag("upd");
    const m = await createCursorMemory(tag);

    const del = await api("DELETE", `/agent/memories/${m.id}`, { token: withAgentKey("cursor") });
    expect(del.status).toBe(200);

    const upd = await api("PUT", `/agent/memories/${m.id}`, {
      token: withAgentKey("cursor"),
      body: {
        title: `posthumous ${tag}`,
        content: `posthumous ${tag}`,
        tags: [tag],
        allowed_vendors: ["*"],
      },
    });
    expect(upd.status).toBe(404);
  });

  it("update with empty title -> 400", async () => {
    const tag = uniqueTag("upd");
    const m = await createCursorMemory(tag);
    const upd = await api("PUT", `/agent/memories/${m.id}`, {
      token: withAgentKey("cursor"),
      body: { title: "", content: "x", tags: [tag], allowed_vendors: ["*"] },
    });
    expect(upd.status).toBe(400);
  });

  it("update with empty allowed_vendors -> 400", async () => {
    const tag = uniqueTag("upd");
    const m = await createCursorMemory(tag);
    const upd = await api("PUT", `/agent/memories/${m.id}`, {
      token: withAgentKey("cursor"),
      body: { title: "x", content: "x", tags: [tag], allowed_vendors: [] },
    });
    expect(upd.status).toBe(400);
  });
});

describe("GET /agent/memories/:id/versions", () => {
  it("returns history with at least one entry per write", async () => {
    const tag = uniqueTag("ver");
    const m = await createCursorMemory(tag);

    await api("PUT", `/agent/memories/${m.id}`, {
      token: withAgentKey("cursor"),
      body: {
        title: `v2 ${tag}`,
        content: `v2 body ${tag} with novel terms harpsichord and dolphin`,
        tags: [tag],
        allowed_vendors: ["*"],
      },
    });

    const r = await api<{ versions: Array<{ title: string }>; current_version: number }>(
      "GET",
      `/agent/memories/${m.id}/versions`,
      { token: withAgentKey("cursor") },
    );
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.versions)).toBe(true);
    expect(r.json.versions.length).toBeGreaterThanOrEqual(1);
    expect(r.json.current_version).toBeGreaterThanOrEqual(2);
  });

  it("freshly-created memory has empty version history and current_version=1", async () => {
    const tag = uniqueTag("ver");
    const m = await createCursorMemory(tag);
    const r = await api<{ versions: unknown[]; current_version: number }>(
      "GET",
      `/agent/memories/${m.id}/versions`,
      { token: withAgentKey("cursor") },
    );
    expect(r.status).toBe(200);
    expect(r.json.versions).toEqual([]);
    expect(r.json.current_version).toBe(1);
  });

  it("versions of nonexistent id -> 404", async () => {
    const r = await api("GET", "/agent/memories/00000000-0000-0000-0000-000000000000/versions", {
      token: withAgentKey("cursor"),
    });
    expect(r.status).toBe(404);
  });
});

describe("DELETE /agent/memories/:id (soft delete)", () => {
  it("soft delete returns 200 with deleted=true and removes memory from agent reads", async () => {
    const tag = uniqueTag("del");
    const m = await createCursorMemory(tag);

    const del = await api<{ deleted: boolean; id: string; title: string }>(
      "DELETE",
      `/agent/memories/${m.id}`,
      { token: withAgentKey("cursor") },
    );
    expect(del.status).toBe(200);
    expect(del.json.deleted).toBe(true);
    expect(del.json.id).toBe(m.id);

    const got = await api("GET", `/agent/memories/${m.id}`, { token: withAgentKey("cursor") });
    expect(got.status).toBe(404);
  });

  it("soft delete twice -> second returns 404", async () => {
    const tag = uniqueTag("del");
    const m = await createCursorMemory(tag);

    const first = await api("DELETE", `/agent/memories/${m.id}`, { token: withAgentKey("cursor") });
    expect(first.status).toBe(200);

    const second = await api("DELETE", `/agent/memories/${m.id}`, { token: withAgentKey("cursor") });
    expect(second.status).toBe(404);
  });

  it("agent cannot delete memory created by a different vendor -> 403", async () => {
    const tag = uniqueTag("del");
    const m = await createCursorMemory(tag);
    const del = await api("DELETE", `/agent/memories/${m.id}`, { token: withAgentKey("claude") });
    expect(del.status).toBe(403);
  });

  it("delete nonexistent -> 404", async () => {
    const r = await api("DELETE", "/agent/memories/00000000-0000-0000-0000-000000000000", {
      token: withAgentKey("cursor"),
    });
    expect(r.status).toBe(404);
  });
});

describe("POST /memories/:id/restore", () => {
  it("restore brings a soft-deleted memory back to readable state (owner key)", async () => {
    const tag = uniqueTag("restore");
    const m = await createCursorMemory(tag);

    await api("DELETE", `/agent/memories/${m.id}`, { token: withAgentKey("cursor") });

    const restored = await api<Memory>("POST", `/memories/${m.id}/restore`, { body: {} });
    expect(restored.status).toBe(200);
    expect(restored.json.id).toBe(m.id);

    const got = await api<Memory>("GET", `/agent/memories/${m.id}`, { token: withAgentKey("cursor") });
    expect(got.status).toBe(200);
  });

  it("restore on a non-trashed memory -> 404", async () => {
    const tag = uniqueTag("restore");
    const m = await createCursorMemory(tag);
    const r = await api("POST", `/memories/${m.id}/restore`, { body: {} });
    expect(r.status).toBe(404);
  });

  it("restore on nonexistent id -> 404", async () => {
    const r = await api("POST", "/memories/00000000-0000-0000-0000-000000000000/restore", {
      body: {},
    });
    expect(r.status).toBe(404);
  });
});

describe("DELETE /memories/:id/permanent", () => {
  it("permanent delete returns 204 and prevents restore (owner key)", async () => {
    const tag = uniqueTag("perm");
    const m = await createCursorMemory(tag);
    await api("DELETE", `/agent/memories/${m.id}`, { token: withAgentKey("cursor") });

    const perm = await api("DELETE", `/memories/${m.id}/permanent`, {});
    expect(perm.status).toBe(204);

    const got = await api("GET", `/agent/memories/${m.id}`, { token: withAgentKey("cursor") });
    expect(got.status).toBe(404);

    const restored = await api("POST", `/memories/${m.id}/restore`, { body: {} });
    expect(restored.status).toBe(404);
  });

  it("permanent delete on nonexistent id -> 404", async () => {
    const r = await api("DELETE", "/memories/00000000-0000-0000-0000-000000000000/permanent", {});
    expect(r.status).toBe(404);
  });
});

describe("DELETE /memories/trash (empty trash)", () => {
  it("empty trash deletes only soft-deleted memories and returns count", async () => {
    const tagA = uniqueTag("trash-a");
    const tagB = uniqueTag("trash-b");
    const tagKeep = uniqueTag("keep");

    const a = await createCursorMemory(tagA);
    const b = await createCursorMemory(tagB);
    const keep = await createCursorMemory(tagKeep);

    await api("DELETE", `/agent/memories/${a.id}`, { token: withAgentKey("cursor") });
    await api("DELETE", `/agent/memories/${b.id}`, { token: withAgentKey("cursor") });

    const r = await api<{ deleted: number }>("DELETE", "/memories/trash", {});
    expect(r.status).toBe(200);
    expect(r.json.deleted).toBeGreaterThanOrEqual(2);

    // Subsequent empty-trash returns 0 (or whatever count of others trashed in parallel,
    // but we expect at least our 2 to no longer be restorable).
    const restoreA = await api("POST", `/memories/${a.id}/restore`, { body: {} });
    expect(restoreA.status).toBe(404);
    const restoreB = await api("POST", `/memories/${b.id}/restore`, { body: {} });
    expect(restoreB.status).toBe(404);

    // The kept memory is still readable.
    const got = await api("GET", `/agent/memories/${keep.id}`, { token: withAgentKey("cursor") });
    expect(got.status).toBe(200);
  });

  it("empty trash with nothing to delete returns deleted=0", async () => {
    // Sequential single-fork pool means by this point either trash is empty
    // or contains only memories from later tests in this file. Empty it then re-check.
    await api("DELETE", "/memories/trash", {});
    const r = await api<{ deleted: number }>("DELETE", "/memories/trash", {});
    expect(r.status).toBe(200);
    expect(r.json.deleted).toBe(0);
  });
});
