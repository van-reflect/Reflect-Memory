// Scenario 09: briefing-only-navigation.
//
// User asks "what areas does this user have memories about?" — the
// briefing's topic map should be enough to answer this WITHOUT any tool
// calls. Tests whether the briefing alone is a useful map.
//
// Hard assertions:
//   - Zero tool calls (model answered from briefing alone)
//   - Final answer mentions at least 3 distinct topic-cluster names
//     from what's in the briefing (e.g. "engineering", "operations",
//     "decisions", "dashboard", etc.)
//
// Rubric:
//   - Did the LLM use the topic map from the briefing as its source of
//     truth for the answer?

import type { Scenario } from "./types.js";

const scenario: Scenario = {
  name: "briefing-only-navigation",
  description:
    "Pure navigation question that should be answerable from the briefing's " +
    "topic map alone — no tool calls required. Tests whether the briefing is " +
    "a useful first-contact map.",
  author: "tamer",
  prompt:
    "Without using any tools, give me a quick rundown of what topic areas I " +
    "have memories about. Just the high-level themes — I want to see the " +
    "shape of the corpus.",
  maxSteps: 3, // sane cap; if the model uses tools, we want to know
  assertions: [
    (t) => ({
      name: "answered with zero tool calls (briefing was sufficient)",
      pass: t.toolUses.length === 0,
      detail: `tool calls: ${t.toolUses.map((u) => u.name).join(", ") || "(none)"}`,
    }),
    (t) => {
      // Look for distinct topic-cluster-flavored words in the answer.
      // This is fuzzy — we accept any of the canonical cluster themes
      // we expect to see in Tamer's briefing (Operations, Auth, API,
      // Decisions, Dashboard, Engineering, Customer/Feedback, Research,
      // Production, Sales).
      const text = t.finalAssistantText.toLowerCase();
      const themes = [
        "engineering",
        "operations",
        "decision",
        "dashboard",
        "auth",
        "api",
        "customer",
        "feedback",
        "research",
        "deploy",
        "infra",
        "billing",
        "marketing",
        "private",
      ];
      const hits = themes.filter((th) => text.includes(th));
      return {
        name: "answer mentions ≥ 3 distinct topic themes from the briefing",
        pass: hits.length >= 3,
        detail: `hits: [${hits.join(", ")}] (${hits.length})`,
      };
    },
  ],
  rubric: [
    {
      id: "used_topic_map",
      question:
        "Did the LLM clearly base its answer on the briefing's topic map (vs. " +
        "guessing or asking for clarification)?",
      type: "yes_no",
    },
    {
      id: "completeness",
      question:
        "Score 0-10: how complete and accurate is the LLM's summary of the " +
        "user's topic areas based on what was in the briefing? Penalise " +
        "hallucinations or missed major themes.",
      type: "score_0_10",
    },
  ],
};

export default scenario;
