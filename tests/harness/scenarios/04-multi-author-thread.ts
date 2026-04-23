// Scenario 04: multi-author-thread.
//
// Run as Van. The corpus has an open thread Tamer started about the auth
// bug, shared with the team. Van has investigated and is now writing up
// what he found. The LLM should reply to the thread (write_child_memory
// against auth-bug-root, which Tamer owns), demonstrating that team-shared
// thread reply works regardless of parent ownership.
//
// Hard assertions:
//   - write_child_memory called
//   - parent_memory_id is auth-bug-root (Tamer-owned, team-shared)
//   - did NOT call write_memory at top level
//
// Rubric:
//   - Did the LLM correctly identify the thread despite a different author?
//   - Score 0-10 on the appropriateness of the reply.

import type { Scenario } from "./types.js";
import { calledTool } from "./types.js";

const scenario: Scenario = {
  name: "multi-author-thread",
  description:
    "As Van: reply to a team-shared thread Tamer started. " +
    "Tests that team threading works across authors.",
  author: "van",
  prompt:
    "Update on the auth refresh thing — I dug into it more and confirmed my " +
    "earlier hunch. The race is definitely between the bearer middleware's " +
    "two concurrent token-refresh attempts (clock-skew edge case makes both " +
    "treat the access token as expired at the same instant). Tamer and I " +
    "agreed on the mitigation already. I'll pick up the implementation " +
    "tomorrow morning. Capture this status update.",
  assertions: [
    (t) => ({
      name: "called write_child_memory",
      pass: calledTool(t, "write_child_memory"),
      detail: calledTool(t, "write_child_memory")
        ? undefined
        : `tools called: ${t.toolUses.map((u) => u.name).join(", ") || "(none)"}`,
    }),
    (t) => ({
      name: "did NOT create a new top-level (avoided fragmenting the thread)",
      pass: !calledTool(t, "write_memory"),
      detail: calledTool(t, "write_memory")
        ? "Created a separate top-level memory instead of replying to the existing thread."
        : undefined,
    }),
    (t, ctx) => {
      // Pass if any write_child_memory call lands on auth-bug-root —
      // recovery from a wrong-id first attempt is valid behavior.
      const expected = ctx.refToId["auth-bug-root"];
      const calls = t.toolUses.filter((u) => u.name === "write_child_memory");
      if (calls.length === 0) {
        return {
          name: "any write_child_memory landed on auth-bug-root (cross-author)",
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
        name: "any write_child_memory landed on auth-bug-root (cross-author)",
        pass: matched,
        detail: matched ? undefined : `parent ids tried: ${ids.join(", ")} (expected ${expected})`,
      };
    },
  ],
  rubric: [
    {
      id: "cross_author_thread",
      question:
        "Did the LLM correctly identify the open thread on this topic even though " +
        "the parent memory was authored by a different team member (Tamer, not Van)?",
      type: "yes_no",
    },
    {
      id: "team_appropriate_tone",
      question:
        "Score 0-10: how appropriate is the reply for a teammate adding a status " +
        "update to a colleague's thread? Consider tone, level of detail, and clarity.",
      type: "score_0_10",
    },
  ],
};

export default scenario;
