// Slack agent + tool dispatch coverage:
//   - buildAgentTools.execute() returns the right shapes for each tool
//     against a real test DB.
//   - runSlackAgentTurn loops on tool_use stop_reason and stops on end_turn.
//   - Slack mention syntax <@U...> is stripped from user input before LLM.
//   - System prompt encodes mode (DM vs channel) + speaker.
//   - Tool errors are caught and serialised, not thrown.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { getTestServer } from "../helpers";
import { _resetMasterKeyCacheForTests } from "../../src/llm-key-crypto";
import { buildAgentTools } from "../../src/slack-agent-tools";
import { runSlackAgentTurn } from "../../src/slack-agent";
import { createMemory, readMemoryById } from "../../src/memory-service";

process.env.RM_LLM_KEY_ENCRYPTION_KEY = getTestServer().llmKeyMasterKey;
_resetMasterKeyCacheForTests();

function openDb(): Database.Database {
  return new Database(getTestServer().dbPath);
}

function getOwnerUserId(): string {
  const db = openDb();
  const row = db
    .prepare(`SELECT id FROM users WHERE email = ?`)
    .get(getTestServer().ownerEmail) as { id: string } | undefined;
  db.close();
  if (!row) throw new Error("Test owner user not found");
  return row.id;
}

// ---------------------------------------------------------------------------
// Tool dispatch tests (no LLM involved; pure function calls)
// ---------------------------------------------------------------------------

describe("buildAgentTools.execute (unit, real DB)", () => {
  let userId: string;
  const seededIds: string[] = [];

  beforeAll(() => {
    userId = getOwnerUserId();
    const db = openDb();
    // Seed a couple of memories the tools can find.
    // Distinct titles + bodies to dodge findSimilarMemory's dedup heuristic.
    const m1 = createMemory(db, userId, {
      title: `Slack agent seed alpha ${randomUUID()}`,
      content: `Alpha entry. zebra-keyword-${randomUUID()}. discussing herd behaviour.`,
      tags: ["test", "slack-agent-test"],
      allowed_vendors: ["*"],
      memory_type: "semantic",
      origin: "user",
    });
    const m2 = createMemory(db, userId, {
      title: `Slack agent seed beta ${randomUUID()}`,
      content: `Beta entry. completely different prose with the zebra-keyword in it. ${randomUUID()}`,
      tags: ["test", "slack-agent-test"],
      allowed_vendors: ["*"],
      memory_type: "semantic",
      origin: "user",
    });
    seededIds.push(m1.id, m2.id);
    db.close();
  });

  afterEach(() => {
    // Tests within this describe shouldn't mutate, but reset just in case
    // future additions do.
  });

  it("search_memories returns count + memories shape", async () => {
    const db = openDb();
    const tools = buildAgentTools({ db, reflectUserId: userId });
    const out = await tools.execute("search_memories", { term: "zebra", limit: 5 });
    db.close();
    const parsed = JSON.parse(out) as { count: number; memories: { id: string; title: string }[] };
    expect(parsed.count).toBeGreaterThanOrEqual(2);
    expect(parsed.memories.some((m) => m.title.includes("alpha"))).toBe(true);
    expect(parsed.memories.some((m) => m.title.includes("beta"))).toBe(true);
  });

  it("search_memories rejects empty term", async () => {
    const db = openDb();
    const tools = buildAgentTools({ db, reflectUserId: userId });
    const out = await tools.execute("search_memories", { term: "" });
    db.close();
    expect(JSON.parse(out)).toEqual({ error: "term is required" });
  });

  it("read_memories returns recent memories", async () => {
    const db = openDb();
    const tools = buildAgentTools({ db, reflectUserId: userId });
    const out = await tools.execute("read_memories", { limit: 3 });
    db.close();
    const parsed = JSON.parse(out) as { count: number; memories: unknown[] };
    expect(parsed.count).toBeGreaterThan(0);
    expect(parsed.memories.length).toBeLessThanOrEqual(3);
  });

  it("get_memories_by_tag filters correctly", async () => {
    const db = openDb();
    const tools = buildAgentTools({ db, reflectUserId: userId });
    const out = await tools.execute("get_memories_by_tag", {
      tags: ["slack-agent-test"],
      limit: 5,
    });
    db.close();
    const parsed = JSON.parse(out) as { count: number; memories: { tags: string[] }[] };
    expect(parsed.count).toBeGreaterThanOrEqual(2);
    for (const m of parsed.memories) {
      expect(m.tags).toContain("slack-agent-test");
    }
  });

  it("get_memories_by_tag rejects empty tag list", async () => {
    const db = openDb();
    const tools = buildAgentTools({ db, reflectUserId: userId });
    const out = await tools.execute("get_memories_by_tag", { tags: [] });
    db.close();
    expect(JSON.parse(out)).toEqual({ error: "tags is required (non-empty array)" });
  });

  it("get_memory_by_id returns the memory or 'not found'", async () => {
    const db = openDb();
    const tools = buildAgentTools({ db, reflectUserId: userId });
    const ok = await tools.execute("get_memory_by_id", { id: seededIds[0] });
    expect((JSON.parse(ok) as { id: string }).id).toBe(seededIds[0]);

    const missing = await tools.execute("get_memory_by_id", { id: randomUUID() });
    expect(JSON.parse(missing)).toEqual({ error: "Memory not found" });
    db.close();
  });

  it("read_team_memories returns the 'no team' note when user is solo", async () => {
    const db = openDb();
    const tools = buildAgentTools({ db, reflectUserId: userId });
    // The owner test user has no org_id by default.
    const out = await tools.execute("read_team_memories", {});
    db.close();
    const parsed = JSON.parse(out) as { count: number; note?: string };
    expect(parsed.count).toBe(0);
    expect(parsed.note).toMatch(/not on a team/i);
  });

  it("read_thread returns parent + children", async () => {
    const db = openDb();
    const tools = buildAgentTools({ db, reflectUserId: userId });
    const out = await tools.execute("read_thread", { parent_id: seededIds[0] });
    db.close();
    const parsed = JSON.parse(out) as {
      parent: { id: string };
      children: unknown[];
    };
    expect(parsed.parent.id).toBe(seededIds[0]);
    expect(Array.isArray(parsed.children)).toBe(true);
  });

  it("get_graph_around returns a graph or 'not found'", async () => {
    const db = openDb();
    const tools = buildAgentTools({ db, reflectUserId: userId });
    const ok = await tools.execute("get_graph_around", { memory_id: seededIds[0] });
    db.close();
    const parsed = JSON.parse(ok) as Record<string, unknown>;
    // getGraphAround returns a graph object with at least a `center` field.
    expect(parsed).toHaveProperty("center");
  });

  it("unknown tool name returns an error", async () => {
    const db = openDb();
    const tools = buildAgentTools({ db, reflectUserId: userId });
    const out = await tools.execute("definitely_not_a_tool", {});
    db.close();
    expect(JSON.parse(out)).toEqual({ error: "Unknown tool: definitely_not_a_tool" });
  });

  // -------------------------------------------------------------------------
  // Write tools
  // -------------------------------------------------------------------------

  it("write_memory creates a personal memory by default (not shared)", async () => {
    const db = openDb();
    const tools = buildAgentTools({ db, reflectUserId: userId });
    const out = await tools.execute("write_memory", {
      title: `Slack write test ${randomUUID()}`,
      content: `Test content ${randomUUID()}`,
      tags: ["test", "slack-write-test"],
    });
    db.close();
    const parsed = JSON.parse(out) as {
      ok: boolean;
      memory: { id: string; shared_with_org_id: string | null };
      shared_with_org_id: string | null;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.memory.id).toBeTruthy();
    expect(parsed.shared_with_org_id).toBeNull();
    expect(parsed.memory.shared_with_org_id).toBeNull();
  });

  it("write_memory rejects empty title or content", async () => {
    const db = openDb();
    const tools = buildAgentTools({ db, reflectUserId: userId });
    const out = await tools.execute("write_memory", { title: "", content: "ok", tags: [] });
    db.close();
    expect(JSON.parse(out)).toEqual({ error: "title and content are required" });
  });

  it("write_child_memory creates a child under a parent", async () => {
    const db = openDb();
    const tools = buildAgentTools({ db, reflectUserId: userId });
    const out = await tools.execute("write_child_memory", {
      parent_id: seededIds[0],
      title: `Child reply ${randomUUID()}`,
      content: `Child content ${randomUUID()}`,
      tags: ["test", "reply"],
    });
    db.close();
    const parsed = JSON.parse(out) as {
      ok: boolean;
      memory: { id: string; parent_memory_id: string | null };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.memory.parent_memory_id).toBe(seededIds[0]);
  });

  it("update_memory replaces title + content + tags wholesale", async () => {
    const db = openDb();
    // First create something we can mutate.
    const created = await buildAgentTools({ db, reflectUserId: userId }).execute(
      "write_memory",
      {
        title: `To update ${randomUUID()}`,
        content: `Original content ${randomUUID()}`,
        tags: ["test", "to-update"],
      },
    );
    const createdId = (JSON.parse(created) as { memory: { id: string } }).memory.id;

    const tools = buildAgentTools({ db, reflectUserId: userId });
    const out = await tools.execute("update_memory", {
      id: createdId,
      title: "Updated title",
      content: "Updated content body",
      tags: ["test", "updated"],
    });
    db.close();
    const parsed = JSON.parse(out) as {
      ok: boolean;
      memory: { title: string; content: string; tags: string[] };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.memory.title).toBe("Updated title");
    expect(parsed.memory.content).toBe("Updated content body");
    expect(parsed.memory.tags).toContain("updated");
  });

  it("update_memory refuses to update a memory the user doesn't own", async () => {
    const db = openDb();
    const tools = buildAgentTools({ db, reflectUserId: userId });
    const out = await tools.execute("update_memory", {
      id: randomUUID(),
      title: "x",
      content: "x",
      tags: [],
    });
    db.close();
    expect(JSON.parse(out)).toMatchObject({ error: expect.stringMatching(/not found/i) });
  });

  it("share_memory returns 'not on team' when the user is solo", async () => {
    const db = openDb();
    // Owner test user has no team.
    const created = await buildAgentTools({ db, reflectUserId: userId }).execute(
      "write_memory",
      {
        title: `To share ${randomUUID()}`,
        content: `Share me ${randomUUID()}`,
        tags: ["test", "to-share"],
      },
    );
    const createdId = (JSON.parse(created) as { memory: { id: string } }).memory.id;

    const tools = buildAgentTools({ db, reflectUserId: userId });
    const out = await tools.execute("share_memory", { id: createdId, share: true });
    db.close();
    expect(JSON.parse(out)).toMatchObject({ error: expect.stringMatching(/not on a team/i) });
  });

  it("delete_memory returns a preview when confirm=false (does NOT delete)", async () => {
    const db = openDb();
    const created = await buildAgentTools({ db, reflectUserId: userId }).execute(
      "write_memory",
      {
        title: `To preview-delete ${randomUUID()}`,
        content: `Some body ${randomUUID()}`,
        tags: ["test", "to-delete"],
      },
    );
    const createdId = (JSON.parse(created) as { memory: { id: string } }).memory.id;

    const tools = buildAgentTools({ db, reflectUserId: userId });
    const previewOut = await tools.execute("delete_memory", { id: createdId, confirm: false });
    const preview = JSON.parse(previewOut) as {
      ok: boolean;
      preview: { id: string; title: string };
      instruction: string;
    };
    expect(preview.ok).toBe(true);
    expect(preview.preview.id).toBe(createdId);
    expect(preview.instruction).toMatch(/destructive/i);

    // Memory still exists and is not soft-deleted.
    const stillThere = readMemoryById(db, userId, createdId);
    expect(stillThere?.deleted_at).toBeFalsy();
    db.close();
  });

  it("delete_memory with confirm=true actually soft-deletes", async () => {
    const db = openDb();
    const created = await buildAgentTools({ db, reflectUserId: userId }).execute(
      "write_memory",
      {
        title: `To really delete ${randomUUID()}`,
        content: `Some body ${randomUUID()}`,
        tags: ["test", "to-delete"],
      },
    );
    const createdId = (JSON.parse(created) as { memory: { id: string } }).memory.id;

    const tools = buildAgentTools({ db, reflectUserId: userId });
    const out = await tools.execute("delete_memory", { id: createdId, confirm: true });
    const parsed = JSON.parse(out) as { ok: boolean; deleted: boolean; id: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.deleted).toBe(true);

    // Memory is soft-deleted (readMemoryById still returns the row, deleted_at set).
    const post = readMemoryById(db, userId, createdId);
    expect(post?.deleted_at).toBeTruthy();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// runSlackAgentTurn — orchestration tests with a stubbed Anthropic client
// ---------------------------------------------------------------------------

interface StubResponse {
  stop_reason: "end_turn" | "tool_use";
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
}

function makeStubAnthropic(scriptedResponses: StubResponse[]): {
  client: unknown;
  callCount: () => number;
  capturedSystem: () => string | null;
  capturedMessages: () => unknown[];
} {
  let callCount = 0;
  let capturedSystem: string | null = null;
  let lastMessages: unknown[] = [];
  const client = {
    messages: {
      create: async (args: { system?: string; messages: unknown[] }) => {
        capturedSystem = args.system ?? null;
        lastMessages = args.messages;
        const idx = callCount++;
        const resp = scriptedResponses[idx] ?? scriptedResponses[scriptedResponses.length - 1];
        return resp;
      },
    },
  };
  return {
    client,
    callCount: () => callCount,
    capturedSystem: () => capturedSystem,
    capturedMessages: () => lastMessages,
  };
}

describe("runSlackAgentTurn (orchestration, stubbed Anthropic)", () => {
  it("returns final text on a single end_turn response", async () => {
    const stub = makeStubAnthropic([
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Hello!" }],
      },
    ]);
    const db = openDb();
    const result = await runSlackAgentTurn({
      apiKey: "stub",
      db,
      reflectUserId: getOwnerUserId(),
      isDirectMessage: true,
      email: getTestServer().ownerEmail,
      realName: "Test Owner",
      newUserMessage: "<@U02ABCXYZ123> hi",
      history: [],
      anthropicClient: stub.client as never,
    });
    db.close();
    expect(result.replyText).toBe("Hello!");
    expect(result.steps).toBe(0);
    expect(result.toolCallCount).toBe(0);
    expect(result.stopReason).toBe("end_turn");
    // History gets the cleaned user text (mention stripped) + assistant reply.
    expect(result.updatedHistory.at(-1)).toEqual({ role: "assistant", content: "Hello!" });
    expect(result.updatedHistory.at(-2)).toEqual({ role: "user", content: "hi" });
    // System prompt encodes mode + speaker.
    expect(stub.capturedSystem()).toMatch(/Mode: DM/);
    expect(stub.capturedSystem()).toMatch(/Test Owner/);
  });

  it("loops on tool_use, executes the tool, then returns final text", async () => {
    const stub = makeStubAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "search_memories",
            input: { term: "zebra", limit: 3 },
          },
        ],
      },
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Found 2 memories about zebra." }],
      },
    ]);
    const db = openDb();
    const result = await runSlackAgentTurn({
      apiKey: "stub",
      db,
      reflectUserId: getOwnerUserId(),
      isDirectMessage: false,
      email: getTestServer().ownerEmail,
      realName: null,
      newUserMessage: "search for zebra",
      history: [],
      anthropicClient: stub.client as never,
    });
    db.close();
    expect(result.replyText).toMatch(/zebra/i);
    expect(result.steps).toBe(1);
    expect(result.toolCallCount).toBe(1);
    expect(stub.callCount()).toBe(2);
    // System encodes channel mode this time.
    expect(stub.capturedSystem()).toMatch(/Mode: channel/);
  });

  it("falls back to a default reply text when the model returns no text", async () => {
    const stub = makeStubAnthropic([
      {
        stop_reason: "end_turn",
        content: [], // no text blocks
      },
    ]);
    const db = openDb();
    const result = await runSlackAgentTurn({
      apiKey: "stub",
      db,
      reflectUserId: getOwnerUserId(),
      isDirectMessage: true,
      email: getTestServer().ownerEmail,
      realName: null,
      newUserMessage: "hi",
      history: [],
      anthropicClient: stub.client as never,
    });
    db.close();
    expect(result.replyText).toMatch(/couldn't produce/i);
  });
});
