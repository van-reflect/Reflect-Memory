// Daily/weekly session summaries. Tagged `session_summary` consistently so
// the briefing's detected_conventions logic flags it. Some have child
// memories that act as "follow-ups from the session" — useful for testing
// thread-vs-top-level decisions.

import type { FixtureCategory } from "./types.js";

const SESSIONS: FixtureCategory = [
  // ---------------- a recent session with two follow-up children
  {
    ref: "session-2026-04-21",
    author: "tamer",
    title: "Session 2026-04-21: knowledge graph research + plan",
    content:
      "Spent the morning reading the knowledge-graph landscape — " +
      "GraphRAG, LightRAG, Graphiti, WorldDB, Mem0, Letta, the SQLite " +
      "graph libs. Wrote up findings. Key conclusion: Phase 1 is " +
      "essentially free (recursive CTEs over what we already have). " +
      "Phase 2-4 should wait for usage signal. Built the implementation " +
      "plan in the afternoon — graph-tag-system. Test harness is the " +
      "main scope, not the feature itself.",
    tags: ["session_summary", "graph", "research"],
    shared: false,
    created_offset_days: -2,
  },
  {
    ref: "session-2026-04-21-followup-fixtures",
    author: "tamer",
    title: "Follow-up: fixture corpus design for the harness",
    content:
      "Ended the day brainstorming what the harness fixture corpus needs " +
      "to look like. Conclusion: 5 categories (engineering, decisions, " +
      "runbooks, sessions, noise), 60-90 memories total, ~30% authored " +
      "by Van so multi-author scenarios are testable, ~30% shared with " +
      "team. The harness has to seed a richer corpus than my real one or " +
      "the cluster pass won't have anything to find.",
    tags: ["session_summary", "harness", "fixtures"],
    parent_ref: "session-2026-04-21",
    created_offset_days: -2,
  },
  {
    ref: "session-2026-04-21-followup-driver",
    author: "tamer",
    title: "Follow-up: claude CLI driver fell over, pivoting to self-rolled",
    content:
      "Tried to drive the harness via `claude --print --output-format " +
      "stream-json`. Hangs reliably, debug log shows no API call attempt. " +
      "Pivoting to a self-rolled TypeScript MCP client + Anthropic SDK " +
      "as agreed in the plan's risk section. ~150 LOC, ran in 6.5s on " +
      "first try. Real Cursor remains the human spot-check.",
    tags: ["session_summary", "harness", "driver"],
    parent_ref: "session-2026-04-21",
    created_offset_days: -1,
  },

  // ---------------- earlier sessions, threadless summaries
  {
    ref: "session-2026-04-20",
    author: "tamer",
    title: "Session 2026-04-20: shipped openapi 300-char fix",
    content:
      "ChatGPT CustomGPT importer was rejecting our action manifest. " +
      "Tightened three operation descriptions, added a regression test " +
      "that walks /openapi.json. Also shipped the team-thread-permissions " +
      "fix (Van couldn't reply to my shared memory). Both through dev → " +
      "main with smoke green.",
    tags: ["session_summary", "shipped"],
    shared: false,
    created_offset_days: -3,
  },
  {
    ref: "session-2026-04-19",
    author: "tamer",
    title: "Session 2026-04-19: dashboard markdown rendering + research kickoff",
    content:
      "Added react-markdown rendering for memory content in the dashboard " +
      "(was rendering raw markdown source before). Started the knowledge " +
      "graph research doc — read most of the GraphRAG family this " +
      "evening.",
    tags: ["session_summary", "dashboard", "research"],
    shared: false,
    created_offset_days: -4,
  },
  {
    ref: "session-2026-04-15",
    author: "tamer",
    title: "Session 2026-04-15: realtime SSE + team search + threading",
    content:
      "Big day. Three features through dev → prod: (1) SSE live-update " +
      "for the dashboard, (2) team-shared search across title/content/" +
      "tags/author, (3) one-level memory threading (parent_memory_id). " +
      "Also fixed a DMARC issue blocking outbound email and added " +
      "multi-admin support via RM_OWNER_EMAILS.",
    tags: ["session_summary", "shipped", "sse", "search", "threading"],
    shared: false,
    created_offset_days: -8,
  },
  {
    ref: "session-2026-04-10",
    author: "van",
    title: "Session 2026-04-10: oncall shift, two customer issues",
    content:
      "Quiet shift. Two customer pings: (1) someone confused about how " +
      "the briefing differs from get_latest_memory — wrote a clarifying " +
      "FAQ entry; (2) someone hit the 401 mid-session bug — confirmed " +
      "it's the auth refresh race (filed as auth-bug-root). No fires.",
    tags: ["session_summary", "oncall", "support"],
    shared: false,
    created_offset_days: -13,
  },
];

export default SESSIONS;
