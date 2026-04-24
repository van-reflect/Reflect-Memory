// Scenario 02: create-new-top-level.
//
// The user prompt is about something orthogonal to all open threads — a
// new product idea. The briefing's open-threads list has nothing related.
// The LLM should write a top-level memory (write_memory), NOT shoehorn it
// into an existing thread.
//
// This is the inverse of scenario 01: there we wanted append, here we want
// new. Tests that the LLM doesn't over-reply.
//
// Hard assertions:
//   - write_memory called at least once
//   - write_child_memory NOT called
//
// Rubric:
//   - Did the LLM correctly judge there was no related open thread?
//   - Score 0-10 on memory placement & tagging.

import type { Scenario } from "./types.js";
import { calledTool, firstToolCall } from "./types.js";

const scenario: Scenario = {
  name: "create-new-top-level",
  description:
    "User shares a new product idea unrelated to any open thread. " +
    "LLM should create a top-level write_memory, not force it into a thread.",
  author: "tamer",
  prompt:
    "Random idea I want to capture: what if we offered a 'memory inbox' — " +
    "a public submission link where customers can drop questions or feedback " +
    "and they automatically land as memories in the team pool tagged " +
    "`feedback` + `inbound`. Lower-friction than email. Worth thinking about, " +
    "not building yet. Save this thought.",
  assertions: [
    (t) => ({
      name: "called write_memory (top-level)",
      pass: calledTool(t, "write_memory"),
      detail: calledTool(t, "write_memory")
        ? undefined
        : `tools called: ${t.toolUses.map((u) => u.name).join(", ") || "(none)"}`,
    }),
    (t) => ({
      name: "did NOT call write_child_memory (no forced thread)",
      pass: !calledTool(t, "write_child_memory"),
      detail: calledTool(t, "write_child_memory")
        ? "Created a child reply for an unrelated idea."
        : undefined,
    }),
    (t) => {
      const call = firstToolCall(t, "write_memory");
      if (!call) return { name: "tagged with idea or feedback (semantic match)", pass: false };
      const tags = (call.input.tags as string[] | undefined) ?? [];
      const tagSet = new Set(tags.map((s) => s.toLowerCase()));
      const semanticMatch =
        tagSet.has("idea") || tagSet.has("feedback") || tagSet.has("product");
      return {
        name: "tagged with idea/feedback/product (semantic fit)",
        pass: semanticMatch,
        detail: `tags=[${tags.join(", ")}]`,
      };
    },
  ],
  rubric: [
    {
      id: "no_forced_thread",
      question:
        "Did the LLM correctly judge that there was no related open thread, and " +
        "therefore write a new top-level memory rather than shoehorning the idea " +
        "into an existing thread?",
      type: "yes_no",
    },
    {
      id: "tagging_quality",
      question:
        "Score 0-10: how well-tagged is the new memory? Consider whether the tags " +
        "match the user's existing tag vocabulary visible in the briefing (e.g. " +
        "`idea`, `product`, `feedback`).",
      type: "score_0_10",
    },
  ],
};

export default scenario;
