// Scenario 07: cross-reference.
//
// User's prompt explicitly mentions another memory by topic ("the auth bug").
// The model should:
//   1. Find the auth bug thread in the corpus.
//   2. Either reference its UUID in the new memory's content, OR write
//      the new memory as a child of the auth-bug thread.
//
// Tests whether the LLM uses the graph (or simple search) to make
// connections rather than treating each prompt as isolated.

import type { Scenario } from "./types.js";
import { firstToolCall } from "./types.js";

const scenario: Scenario = {
  name: "cross-reference",
  description:
    "Prompt mentions another memory by topic. Model should find + cross-reference it " +
    "(via parent_memory_id OR by mentioning the UUID in content).",
  author: "tamer",
  prompt:
    "Quick capture: the auth bug refresh-race fix we shipped is now visible " +
    "in our auth metrics — error rate dropped from 0.4% to under 0.05% over " +
    "the last 24h. Worth recording that the fix worked as expected.",
  assertions: [
    // Removed the "must call a read tool" assertion: the briefing's open-
    // threads section + topic map IS the read. If the model has the
    // auth-bug-root in context already and goes straight to a correct
    // write_child_memory, that's MORE efficient, not a failure. The
    // connection assertion below is what actually matters.
    (t, ctx) => {
      // Pass if the new memory connects to the auth-bug thread by ANY of:
      //   - write_child_memory with parent = auth-bug-root OR any of its
      //     existing children (model going "one level too deep" still
      //     captures intent — server rejects 2nd-level threading anyway,
      //     so a successful write was correctly scoped)
      //   - write_memory whose content mentions auth-bug-root's UUID OR
      //     any of its known children's UUIDs OR a `ref_<8>` tag
      const root = ctx.refToId["auth-bug-root"];
      const childCandidates = [
        ctx.refToId["auth-bug-investigation"],
        ctx.refToId["auth-bug-mitigation-decision"],
      ].filter(Boolean);
      const validParents = new Set([root, ...childCandidates]);

      const child = firstToolCall(t, "write_child_memory");
      const top = firstToolCall(t, "write_memory");

      let connected = false;
      let detail = "no write call found";
      if (child) {
        const got =
          (child.input.parent_memory_id as string | undefined) ??
          (child.input.id as string | undefined) ??
          (child.input.parentMemoryId as string | undefined);
        connected = !!got && validParents.has(got);
        detail = `child.parent=${got}, valid parents in thread: [${[...validParents].join(", ")}]`;
      } else if (top) {
        const content = (top.input.content as string | undefined) ?? "";
        const tags = (top.input.tags as string[] | undefined) ?? [];
        const mentionsAny = [...validParents].some((id) => content.includes(id));
        const refTagAny = [...validParents].some((id) =>
          tags.includes(`ref_${id.slice(0, 8)}`),
        );
        connected = mentionsAny || refTagAny;
        detail = `content mentions thread member: ${mentionsAny}, ref tag: ${refTagAny}`;
      }
      return {
        name: "new memory connects to the auth-bug thread (child OR content/tag mention)",
        pass: connected,
        detail,
      };
    },
  ],
  rubric: [
    {
      id: "found_referenced_memory",
      question:
        "Did the LLM find and recognise the existing auth-bug memory in the corpus " +
        "(rather than treating the prompt as completely new)?",
      type: "yes_no",
    },
    {
      id: "connection_quality",
      question:
        "Score 0-10: how cleanly did the model connect the new memory to the " +
        "existing auth-bug thread? Best = wrote as child OR explicitly cited the " +
        "parent's UUID in content. Worst = wrote in isolation with no link.",
      type: "score_0_10",
    },
  ],
};

export default scenario;
