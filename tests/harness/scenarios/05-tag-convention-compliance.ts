// Scenario 05: tag-convention-compliance.
//
// User files a fresh engineering bug report. The briefing's
// detected_conventions section explicitly tells the LLM that tickets use
// `p0/p1/p2/p3` priority tags. The LLM should follow that convention when
// creating the new memory.
//
// Hard assertions:
//   - write_memory called (this is a fresh standalone bug, no thread to
//     append to — the dashboard SSE flake mentioned in the prompt is
//     deliberately a different topic from any existing memory)
//   - tags include `eng` AND a priority tag (p0/p1/p2/p3) AND `bug`
//
// Rubric:
//   - Did the LLM follow the team's tagging conventions detected in the
//     briefing?

import type { Scenario } from "./types.js";
import { calledTool, firstToolCall } from "./types.js";

const scenario: Scenario = {
  name: "tag-convention-compliance",
  description:
    "Fresh bug report. LLM must apply the eng + p<N> + bug convention from " +
    "the briefing's detected_conventions section.",
  author: "tamer",
  prompt:
    "Filing a new bug for tracking: when a user uploads a memory with a " +
    "very long title (>500 chars), the dashboard truncates display but the " +
    "tooltip shows nothing useful — just '[truncated]'. Should show the " +
    "full title on hover. Low-priority cosmetic issue, dashboard area. " +
    "Capture it.",
  assertions: [
    (t) => ({
      name: "called write_memory (fresh top-level bug)",
      pass: calledTool(t, "write_memory"),
      detail: calledTool(t, "write_memory")
        ? undefined
        : `tools called: ${t.toolUses.map((u) => u.name).join(", ") || "(none)"}`,
    }),
    (t) => {
      const call = firstToolCall(t, "write_memory");
      if (!call) return { name: "tags include eng + bug + priority", pass: false };
      const tags = (call.input.tags as string[] | undefined) ?? [];
      const tagSet = new Set(tags.map((s) => s.toLowerCase()));
      const hasEng = tagSet.has("eng");
      const hasBug = tagSet.has("bug");
      const hasPriority = ["p0", "p1", "p2", "p3"].some((p) => tagSet.has(p));
      return {
        name: "tags include eng + bug + priority (p0-p3)",
        pass: hasEng && hasBug && hasPriority,
        detail: `tags=[${tags.join(", ")}] eng=${hasEng} bug=${hasBug} priority=${hasPriority}`,
      };
    },
    (t) => {
      // Bonus check: it's a low-priority cosmetic issue, so we'd expect
      // p2 or p3, not p0/p1. This is a "nice to have" assertion separate
      // from the hard convention check above.
      const call = firstToolCall(t, "write_memory");
      if (!call) return { name: "priority is p2 or p3 (matches 'low-priority')", pass: false };
      const tags = (call.input.tags as string[] | undefined) ?? [];
      const tagSet = new Set(tags.map((s) => s.toLowerCase()));
      const lowPriority = tagSet.has("p2") || tagSet.has("p3");
      return {
        name: "priority tag is p2 or p3 (matches 'low-priority cosmetic')",
        pass: lowPriority,
        detail: `tags=[${tags.join(", ")}]`,
      };
    },
  ],
  rubric: [
    {
      id: "convention_match",
      question:
        "Did the LLM follow the team's tagging conventions visible in the briefing — " +
        "specifically: `eng` for engineering, a `p0`-`p3` priority tag, and a `bug` " +
        "tag where applicable?",
      type: "yes_no",
    },
    {
      id: "tag_appropriateness",
      question:
        "Score 0-10: how well do the chosen tags match the user's existing tag " +
        "vocabulary visible in the briefing? Consider area tags (dashboard, " +
        "search, etc.) too, not just convention compliance.",
      type: "score_0_10",
    },
  ],
};

export default scenario;
