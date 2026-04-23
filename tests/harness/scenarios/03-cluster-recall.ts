// Scenario 03: cluster-recall.
//
// User asks "what do we know about <topic>?" — a navigation prompt that
// should make the LLM use a search/listing tool rather than guess from
// memory. The corpus has a cluster of billing-related memories
// (billing-overage thread + 2 children, plus mentions). The LLM should
// surface those.
//
// Hard assertions:
//   - At least one read tool called (search_memories | get_memories_by_tag |
//     read_memories | read_thread)
//   - The response references at least one specific seeded memory by topic
//     (we check the final assistant text for keyword presence — "stripe",
//     "double-count", or the ticket title)
//
// Rubric:
//   - Did the LLM use the right tool to search the corpus?
//   - Score 0-10: did the answer accurately summarize the billing context?

import type { Scenario } from "./types.js";
import { calledTool } from "./types.js";

const scenario: Scenario = {
  name: "cluster-recall",
  description:
    "Navigation question. LLM should use a search/list tool to surface the " +
    "billing cluster and answer with specifics from the corpus.",
  author: "tamer",
  prompt:
    "What do we currently know about the Stripe billing situation? Are there " +
    "any open issues, decisions, or context I should be aware of? Give me a " +
    "short summary based on what's in memory.",
  assertions: [
    (t) => {
      const searchTools = [
        "search_memories",
        "get_memories_by_tag",
        "read_memories",
        "read_thread",
        "get_memory_briefing",
        "browse_memories",
      ];
      const used = searchTools.filter((tool) => calledTool(t, tool));
      return {
        name: "called at least one read/search tool",
        pass: used.length > 0,
        detail: `read tools used: ${used.join(", ") || "(none)"}`,
      };
    },
    (t) => {
      // The response should mention something specific from the billing
      // cluster — we look for any of these keywords in the final assistant
      // text (case-insensitive). This catches both "stripe", "billing",
      // "double-count", "overage", or the ticket subject.
      const text = t.finalAssistantText.toLowerCase();
      const keywords = ["stripe", "double-count", "double count", "overage", "billing"];
      const hits = keywords.filter((k) => text.includes(k));
      return {
        name: "final answer references billing-cluster specifics",
        pass: hits.length >= 2,
        detail: `keyword hits: [${hits.join(", ")}] in ${t.finalAssistantText.length} chars`,
      };
    },
  ],
  rubric: [
    {
      id: "tool_choice",
      question:
        "Did the LLM pick a sensible tool to navigate the corpus (search_memories or " +
        "get_memories_by_tag are ideal here; read_thread is good if it identified the " +
        "billing thread first)?",
      type: "yes_no",
    },
    {
      id: "answer_accuracy",
      question:
        "Score 0-10: how accurately and concisely does the final answer summarize the " +
        "billing-related memories in the corpus? Penalise hallucinations or missed " +
        "items.",
      type: "score_0_10",
    },
  ],
};

export default scenario;
