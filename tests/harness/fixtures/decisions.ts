// Architectural / product decisions, mostly shared with the team.
// Includes one superseded chain so the harness can later test "supersession"
// scenarios where the LLM should recognise an earlier decision was reversed.

import type { FixtureCategory } from "./types.js";

const DECISIONS: FixtureCategory = [
  // ---------------------------------- supersession chain (3 memories)
  {
    ref: "decision-storage-v1",
    author: "tamer",
    title: "Decision: SQLite for v0, defer Postgres until multi-tenant",
    content:
      "Picking SQLite for the initial deploy. WAL mode handles our read " +
      "concurrency, schema is simple enough that we won't need a migration " +
      "framework yet, and a single-file DB makes the private-deploy story " +
      "trivial. Will revisit when we hit either: (a) horizontal-scale " +
      "needs, or (b) multi-region deploy.",
    tags: ["decision", "architecture", "db", "v0"],
    shared: true,
    created_offset_days: -120,
  },
  {
    ref: "decision-storage-v2-confirm",
    author: "van",
    title: "Decision: confirming SQLite is still right at ~500 memories",
    content:
      "Reviewed perf. Reads p99 < 5ms, writes p99 < 12ms with WAL on, " +
      "FTS5 indexes warm. We are nowhere near a Postgres trigger. Holding " +
      "on the v0 decision; revisit at 50k memories or first multi-region " +
      "customer ask, whichever comes first.",
    tags: ["decision", "architecture", "db"],
    shared: true,
    created_offset_days: -45,
  },
  {
    ref: "decision-graph-db-rejected",
    author: "tamer",
    title: "Decision: NOT adopting Neo4j/Graphiti for the knowledge graph",
    content:
      "Read the landscape (see knowledge-graph-research). Graphiti is the " +
      "best fit on paper but requires Neo4j/FalkorDB which is a real " +
      "operational burden for private-deploy customers. Phase 1 of the " +
      "graph evolution stays SQLite-native — recursive CTEs over " +
      "parent_memory_id + tag co-occurrence + Louvain clustering. Defer " +
      "any external graph DB until usage proves it's needed.",
    tags: ["decision", "architecture", "graph", "db"],
    shared: true,
    created_offset_days: -2,
  },

  // ---------------------------------- product decisions
  {
    ref: "decision-private-deploy-tier",
    author: "tamer",
    title: "Decision: private-deploy is a paid tier, not a free option",
    content:
      "Two reasons: (1) support cost — every private deploy is a " +
      "long-tail support relationship; (2) signals seriousness — " +
      "self-hosters who pay are real customers. Pricing TBD but " +
      "starts at >= $500/mo per deploy.",
    tags: ["decision", "product", "pricing", "private-deploy"],
    shared: true,
    created_offset_days: -28,
  },
  {
    ref: "decision-mcp-as-default",
    author: "tamer",
    title: "Decision: MCP is the primary integration surface, REST is secondary",
    content:
      "Customer onboarding so far is 100% MCP-first (Cursor + Claude " +
      "Desktop). REST API exists for ChatGPT CustomGPTs and webhooks but " +
      "we don't lead with it. Implication: the briefing on " +
      "initialize.instructions is the key UX surface — it's what every " +
      "real user sees first.",
    tags: ["decision", "product", "mcp", "api"],
    shared: true,
    created_offset_days: -38,
  },
  {
    ref: "decision-no-vector-yet",
    author: "tamer",
    title: "Decision: no vector search until corpus density justifies it",
    content:
      "Hand-tagged + threaded structure is doing more than vector would at " +
      "this scale. Adding embeddings = pick a model + storage + " +
      "reindexing pipeline + LLM cost on every write. Wait until the " +
      "harness shows search recall is the bottleneck (currently it's " +
      "navigation, not recall).",
    tags: ["decision", "architecture", "search", "vector"],
    shared: true,
    created_offset_days: -7,
  },

  // ---------------------------------- team / process decisions
  {
    ref: "decision-dev-main-branches",
    author: "tamer",
    title: "Decision: dev → main promotion model, no PR queue",
    content:
      "Two-branch flow: feature branches PR into dev, dev gets promoted " +
      "to main once green + smoke-tested. Keeps prod clean without " +
      "blocking iteration. Works at our team size; revisit at >5 active " +
      "contributors.",
    tags: ["decision", "process", "ci", "deploy"],
    shared: true,
    created_offset_days: -90,
  },
  {
    ref: "decision-test-policy",
    author: "van",
    title: "Decision: integration tests must accompany every API change",
    content:
      "We've shipped a couple of regressions caught only by manual smoke. " +
      "New rule: any change to src/server.ts routes or src/memory-service " +
      "ships with at least one integration test in tests/integration/. " +
      "Enforced by code review, not CI (yet).",
    tags: ["decision", "process", "tests", "quality"],
    shared: true,
    created_offset_days: -33,
  },
];

export default DECISIONS;
