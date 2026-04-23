// Scenario 01: reply-to-existing-thread.
//
// Setup: the corpus has an open thread on the auth-token-refresh bug
// (auth-bug-root + 2 children). Tamer was the original author. The user
// prompt is "I just shipped the fix" — the LLM should recognise the open
// thread (it's in the briefing under "Current open threads") and append a
// reply via write_child_memory under auth-bug-root, NOT create a new
// top-level memory.
//
// Hard assertions:
//   - write_child_memory called at least once
//   - write_memory NOT called (no orphan top-level entry)
//   - the parent_memory_id matches auth-bug-root's seeded id
//
// Rubric:
//   - Did the LLM identify there was an open thread on this topic?
//   - Did it follow the team's tagging convention?
//   - Score 0-10: how natural / well-placed does the reply feel?

import type { Scenario } from "./types.js";
import { calledTool } from "./types.js";

const scenario: Scenario = {
  name: "reply-to-existing-thread",
  description:
    "User reports shipping a fix that maps onto an open thread already in the briefing. " +
    "LLM should append as a child via write_child_memory, not create a new top-level memory.",
  author: "tamer",
  prompt:
    "Quick note: I just shipped the fix for the auth oauth token refresh bug. " +
    "Server now serialises refresh requests per user with a mutex, and the MCP " +
    "transport retries once on a 401. Both went out together as one PR, smoke " +
    "green on dev and prod. Record this.",
  assertions: [
    (t) => ({
      name: "called write_child_memory",
      pass: calledTool(t, "write_child_memory"),
      detail: calledTool(t, "write_child_memory")
        ? undefined
        : `tools called: ${t.toolUses.map((u) => u.name).join(", ") || "(none)"}`,
    }),
    (t) => ({
      name: "did NOT call write_memory (avoided creating new top-level)",
      pass: !calledTool(t, "write_memory"),
      detail: calledTool(t, "write_memory")
        ? "Wrote a top-level memory instead of (or in addition to) replying."
        : undefined,
    }),
    (t, ctx) => {
      // Pass if ANY write_child_memory call lands on the right parent —
      // not just the first. Recovery from a wrong-id first attempt is
      // valid model behavior; we measure intent (final outcome), not
      // first-try perfection. Step count is a separate efficiency signal.
      const expected = ctx.refToId["auth-bug-root"];
      const calls = t.toolUses.filter((u) => u.name === "write_child_memory");
      if (calls.length === 0) {
        return {
          name: "any write_child_memory landed on auth-bug-root id",
          pass: false,
          detail: "no write_child_memory call",
        };
      }
      const ids = calls.map(
        (c) =>
          (c.input.parent_memory_id as string | undefined) ??
          (c.input.id as string | undefined) ??
          (c.input.parentMemoryId as string | undefined),
      );
      const matched = ids.some((id) => id === expected);
      return {
        name: "any write_child_memory landed on auth-bug-root id",
        pass: matched,
        detail: matched ? undefined : `parent ids tried: ${ids.join(", ")} (expected ${expected})`,
      };
    },
    (t) => {
      // Check tags on the LAST write_child_memory call (the one that
      // actually persisted, in case there were retries).
      const calls = t.toolUses.filter((u) => u.name === "write_child_memory");
      const last = calls[calls.length - 1];
      if (!last) return { name: "child memory tagged with eng + resolved/shipped", pass: false };
      const tags = (last.input.tags as string[] | undefined) ?? [];
      const tagSet = new Set(tags.map((s) => s.toLowerCase()));
      const hasEng = tagSet.has("eng");
      const hasResolved = tagSet.has("resolved") || tagSet.has("shipped");
      return {
        name: "child memory tagged with eng + resolved/shipped",
        pass: hasEng && hasResolved,
        detail: `tags=[${tags.join(", ")}]`,
      };
    },
  ],
  rubric: [
    {
      id: "recognized_thread",
      question:
        "Did the LLM identify (in its thinking, content, or tool choice) that there " +
        "was an existing open thread on this topic in the briefing?",
      type: "yes_no",
    },
    {
      id: "followed_convention",
      question:
        "Did the LLM follow the team's tagging convention for resolved engineering " +
        "tickets (eng + resolved/shipped, plus relevant area tags like auth/mcp)?",
      type: "yes_no",
    },
    {
      id: "naturalness",
      question:
        "Score 0-10: how natural would this reply feel to a teammate reading the " +
        "thread? Consider tone, level of detail, and whether it reads as a " +
        "continuation of the thread.",
      type: "score_0_10",
    },
  ],
};

export default scenario;
