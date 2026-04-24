// Scenario 08: supersession.
//
// User asks the model to record an updated position on a topic that has
// an existing decision memory in the corpus (the "decision-storage-v1"
// fixture: "SQLite for v0, defer Postgres until multi-tenant"). The new
// info is "we're now planning to migrate to Postgres next quarter."
//
// Expected behaviors (any of):
//   - write_child_memory under decision-storage-v1 with the new position
//     (cleanest — preserves the original decision in its thread)
//   - write_memory that explicitly references the prior decision's UUID
//     in content (acceptable — supersession is recorded but not threaded)
//
// What it should NOT do:
//   - update_memory on the original decision (overwrites history)
//   - write a brand-new top-level memory with no link to the prior

import type { Scenario } from "./types.js";
import { calledTool, firstToolCall } from "./types.js";
// (calledTool kept — used by the no-update-memory assertion below.)

const scenario: Scenario = {
  name: "supersession",
  description:
    "Stale decision being superseded. Model should reply OR reference the " +
    "prior decision, NOT update_memory (which destroys history) or write " +
    "an isolated top-level.",
  author: "tamer",
  prompt:
    "Update on our database decision: we've decided to migrate from SQLite " +
    "to Postgres in Q3, ahead of multi-tenant launch. Reasons: anticipated " +
    "scale on the new tier, plus team familiarity. Capture this so the " +
    "earlier 'SQLite for v0' decision isn't the only thing on record.",
  assertions: [
    // Removed the "must call a read tool" assertion (same reasoning as
    // cross-reference): the briefing's topic map + open threads IS the
    // read for the model. What matters is whether the new memory is
    // structurally LINKED to the prior decision.
    (t) => ({
      name: "did NOT use update_memory (preserves history)",
      pass: !calledTool(t, "update_memory"),
      detail: calledTool(t, "update_memory")
        ? "Called update_memory — destroys the original decision text."
        : undefined,
    }),
    (t, ctx) => {
      const expected = ctx.refToId["decision-storage-v1"];
      const child = firstToolCall(t, "write_child_memory");
      const top = firstToolCall(t, "write_memory");

      let linked = false;
      let detail = "no write call found";
      if (child) {
        const got =
          (child.input.parent_memory_id as string | undefined) ??
          (child.input.id as string | undefined) ??
          (child.input.parentMemoryId as string | undefined);
        linked = got === expected;
        detail = `child.parent_memory_id=${got} expected=${expected}`;
      } else if (top) {
        const content = (top.input.content as string | undefined) ?? "";
        linked = content.includes(expected);
        detail = `top-level write; content mentions prior=${linked}`;
      }
      return {
        name: "new memory links to the superseded decision (child OR content reference)",
        pass: linked,
        detail,
      };
    },
  ],
  rubric: [
    {
      id: "recognised_supersession",
      question:
        "Did the LLM recognise this is a supersession of an existing decision " +
        "(rather than a fresh isolated note)?",
      type: "yes_no",
    },
    {
      id: "supersession_quality",
      question:
        "Score 0-10: how well does the recorded memory preserve both positions " +
        "(old + new)? Best = both queryable + explicitly linked. Worst = old " +
        "decision lost or new decision floating in isolation.",
      type: "score_0_10",
    },
  ],
};

export default scenario;
