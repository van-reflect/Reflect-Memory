// Scenario 06: avoid-duplication.
//
// User asks the model to record something that's near-duplicate with an
// existing memory in the corpus. The model should:
//   1. Search/read first to discover the existing memory.
//   2. Either: NOT write at all (telling the user it's already recorded),
//      OR write a child reply under the existing memory.
//
// What it should NOT do: blindly write a new top-level memory creating
// a duplicate.
//
// Tests memory-awareness — does the LLM check before writing?

import type { Scenario } from "./types.js";
import { calledTool, firstToolCall } from "./types.js";

const scenario: Scenario = {
  name: "avoid-duplication",
  description:
    "Prompt is near-duplicate of an existing fixture (the OpenAPI 300-char-limit ticket). " +
    "Model should read first, then either skip writing or reply as a child.",
  author: "tamer",
  prompt:
    "Note for tracking: ChatGPT's CustomGPT importer has a 300-character " +
    "limit on operation descriptions. We hit it a few days ago — three " +
    "operations were over (591/334/603 chars). Capture this so we don't " +
    "forget the limit exists.",
  assertions: [
    (t) => {
      // Should call at least one read tool before writing.
      const readTools = [
        "search_memories",
        "get_memories_by_tag",
        "read_memories",
        "browse_memories",
        "get_topic_cluster",
        "get_memory_briefing",
      ];
      const usedReads = readTools.filter((tool) => calledTool(t, tool));
      return {
        name: "called at least one read tool before writing",
        pass: usedReads.length > 0,
        detail: `read tools used: ${usedReads.join(", ") || "(none)"}`,
      };
    },
    (t) => {
      // Either no top-level write, OR a child write (acceptable).
      const wroteTop = calledTool(t, "write_memory");
      const wroteChild = calledTool(t, "write_child_memory");
      // Pass if we either skipped writing entirely or wrote a child.
      const ok = !wroteTop || (wroteTop && !wroteChild ? false : true);
      // Stricter: explicitly disallow a brand-new top-level when no child was made.
      const acceptable = !wroteTop || wroteChild;
      return {
        name: "did not create a duplicate top-level memory",
        pass: acceptable,
        detail: `wrote_memory=${wroteTop}, wrote_child=${wroteChild}`,
      };
    },
  ],
  rubric: [
    {
      id: "discovered_duplicate",
      question:
        "Did the LLM identify (in its tool calls or response) that the OpenAPI 300-char " +
        "limit was already covered by an existing memory in the corpus?",
      type: "yes_no",
    },
    {
      id: "behavior_quality",
      question:
        "Score 0-10: how well did the model handle the near-duplicate? " +
        "Best = surfaced the existing memory and asked / decided not to duplicate. " +
        "Acceptable = wrote a child reply that adds context. " +
        "Poor = blindly wrote a new top-level duplicate.",
      type: "score_0_10",
    },
  ],
};

export default scenario;
