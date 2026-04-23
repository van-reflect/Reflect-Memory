// Scenario 10: cluster-write.
//
// User captures a short note that maps cleanly to one of the briefing's
// named topic clusters. The model should use the cluster's tag vocabulary
// VERBATIM rather than inventing tags.
//
// The corpus includes a "Production Operations" / "Operations Runbooks"
// cluster with tags like `runbook, ops, deploy, incident, infra, ci`.
// The prompt is a deploy-rollback runbook entry; the model should pick
// from those tags.

import type { Scenario } from "./types.js";
import { firstToolCall, calledTool } from "./types.js";

const scenario: Scenario = {
  name: "cluster-write",
  description:
    "Capture a runbook note that maps to the Operations Runbooks cluster. " +
    "Model should reuse the cluster's tag vocabulary verbatim.",
  author: "tamer",
  prompt:
    "Quick runbook addition: when the dashboard service shows OOM kills " +
    "in the systemd journal, the fix is to bump RM_DASHBOARD_NODE_OPTIONS " +
    "to '--max-old-space-size=2048' and restart the service. Capture this " +
    "for future-me.",
  assertions: [
    (t) => ({
      name: "called write_memory (runbook entries are top-level)",
      pass: calledTool(t, "write_memory"),
      detail: calledTool(t, "write_memory")
        ? undefined
        : `tools called: ${t.toolUses.map((u) => u.name).join(", ") || "(none)"}`,
    }),
    (t) => {
      // Should include `runbook` (the umbrella tag for runbook entries
      // per existing fixtures + briefing).
      const call = firstToolCall(t, "write_memory");
      if (!call) return { name: "tag includes `runbook`", pass: false };
      const tags = (call.input.tags as string[] | undefined) ?? [];
      const tagSet = new Set(tags.map((s) => s.toLowerCase()));
      return {
        name: "tag includes `runbook`",
        pass: tagSet.has("runbook"),
        detail: `tags=[${tags.join(", ")}]`,
      };
    },
    (t) => {
      // Should pick from the operations cluster's vocabulary (ops/
      // deploy/incident/infra/dashboard) rather than inventing.
      const call = firstToolCall(t, "write_memory");
      if (!call) return { name: "uses tags from the operations cluster vocabulary", pass: false };
      const tags = (call.input.tags as string[] | undefined) ?? [];
      const tagSet = new Set(tags.map((s) => s.toLowerCase()));
      const clusterVocab = ["ops", "deploy", "incident", "infra", "ci", "dashboard"];
      const hits = clusterVocab.filter((v) => tagSet.has(v));
      return {
        name: "uses ≥ 1 tag from the operations cluster vocabulary (ops/deploy/incident/infra/ci/dashboard)",
        pass: hits.length >= 1,
        detail: `cluster-vocab tags hit: [${hits.join(", ")}] / total tags: [${tags.join(", ")}]`,
      };
    },
  ],
  rubric: [
    {
      id: "used_cluster_vocab",
      question:
        "Did the LLM pick tags from the existing Operations Runbooks cluster's " +
        "vocabulary rather than inventing new ad-hoc tags?",
      type: "yes_no",
    },
    {
      id: "tag_quality",
      question:
        "Score 0-10: how well do the chosen tags fit the corpus's vocabulary " +
        "and the runbook convention? Penalise overly-creative tags or " +
        "missing the runbook umbrella.",
      type: "score_0_10",
    },
  ],
};

export default scenario;
