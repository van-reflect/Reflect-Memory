// Engineering fixtures.
//
// Mix of: open ticket threads (parent + replies), shipped fixes, standalone
// bug reports, ops runbook-adjacent notes. Heavily tagged with the
// `eng + p<N> + resolved/shipped + <area>` convention so the briefing's
// detected_conventions logic and the future Louvain pass have something
// to cluster around.

import type { FixtureCategory } from "./types.js";

const ENG: FixtureCategory = [
  // ---------------------------------------------------------------- thread A
  // Open auth bug — Tamer files, Van investigates, Van proposes fix.
  // No "resolved" tag yet — this is a live thread the LLM should append to
  // when given a related "I just shipped the fix" prompt.
  {
    ref: "auth-bug-root",
    author: "tamer",
    title: "Auth: oauth token refresh sometimes returns 401 mid-session",
    content:
      "Hit this twice today on Cursor connecting to dev. The MCP session " +
      "starts fine, then ~25 min in we get a 401 on tools/call and the " +
      "client silently disconnects. Token has 2h validity per the JWT, so " +
      "this isn't expiry. Maybe a refresh race between two concurrent " +
      "tool calls? Need to repro with debug logging on.",
    tags: ["eng", "bug", "p1", "auth", "mcp"],
    shared: true,
    created_offset_days: -9,
  },
  {
    ref: "auth-bug-investigation",
    author: "van",
    title: "Auth refresh: confirmed concurrent refresh race",
    content:
      "Reproduced. Two parallel tools/call hit the bearer middleware at the " +
      "same instant; both see the access_token as expired (clock-skew " +
      "edge), both POST /token to refresh. The first wins, second gets " +
      "invalid_grant because the refresh token rotated under it. The " +
      "second tool call then 401s and the SDK drops the connection " +
      "instead of retrying. Two issues here: backend doesn't serialise " +
      "refreshes, client doesn't retry on 401.",
    tags: ["eng", "bug", "p1", "auth", "mcp", "investigation"],
    parent_ref: "auth-bug-root",
    created_offset_days: -7,
  },
  {
    ref: "auth-bug-mitigation-decision",
    author: "tamer",
    title: "Auth refresh: going with serialised-refresh + client retry",
    content:
      "Discussed with Van. Two changes: (1) refresh-token rotation gets a " +
      "per-user mutex on the server so concurrent refreshes serialise " +
      "instead of dueling; (2) MCP transport gets a one-shot retry on 401 " +
      "after re-fetching the access_token. Both small, both ship together " +
      "as one PR. Van picks it up.",
    tags: ["eng", "decision", "auth", "mcp"],
    parent_ref: "auth-bug-root",
    created_offset_days: -5,
  },

  // ---------------------------------------------------------------- thread B
  // Shipped — full lifecycle, useful for "show me the resolution" scenarios.
  {
    ref: "search-bug-root",
    author: "tamer",
    title: "Dashboard search: case-insensitive flag broken on tag field",
    content:
      "Searching for 'AUTH' returns nothing; searching for 'auth' returns " +
      "the 14 expected hits. The COLLATE NOCASE clause is on title and " +
      "content but not on the json_each(tags) join. Easy fix. Filing.",
    tags: ["eng", "bug", "p2", "dashboard", "search"],
    shared: true,
    created_offset_days: -16,
  },
  {
    ref: "search-bug-fix",
    author: "van",
    title: "Dashboard search: COLLATE NOCASE applied to tag join",
    content:
      "One-line SQL change in lib/memory-service.ts. Tests added in " +
      "search.test.ts cover lower/upper/mixed-case for title, content, " +
      "and tag fields. Shipped to dev, smoke green, promoted to prod. " +
      "ref: " +
      "search-bug-root.",
    tags: ["eng", "bug", "p2", "dashboard", "search", "resolved", "shipped"],
    parent_ref: "search-bug-root",
    created_offset_days: -14,
  },

  // ---------------------------------------------------------------- thread C
  // Multi-author thread — Van files, Tamer replies. Tests team-side reading.
  {
    ref: "billing-overage-root",
    author: "van",
    title: "Billing: overage events double-counting on Stripe sync",
    content:
      "Customer reported their April invoice shows ~2× the operations " +
      "they made. Pulled monthly_usage for them — totals look right at " +
      "DB layer. The issue is in the sync job: it pushes BOTH the running " +
      "monthly delta AND the overage delta as separate Stripe usage " +
      "records. They overlap. Need to pick one or compute the diff.",
    tags: ["eng", "bug", "p0", "billing", "stripe"],
    shared: true,
    created_offset_days: -3,
  },
  {
    ref: "billing-overage-rootcause",
    author: "tamer",
    title: "Billing: confirmed double-count is in stripe-sync.ts:142",
    content:
      "Read through stripe-sync.ts. Line 142 emits a 'overage_ops' record " +
      "but the metered subscription on Stripe's side is configured against " +
      "'total_ops', so Stripe sums them. Two fixes possible: (a) drop the " +
      "overage record entirely, OR (b) reconfigure Stripe to use overage " +
      "and stop reporting total_ops. (a) is safer — keeps Stripe schema " +
      "stable. Going with (a) once Van confirms.",
    tags: ["eng", "bug", "p0", "billing", "stripe", "investigation"],
    parent_ref: "billing-overage-root",
    created_offset_days: -2,
  },

  // ---------------------------------------------------------------- standalones
  // No threads — useful as "no related context, write top-level" candidates.
  {
    ref: "ws-flake",
    author: "tamer",
    title: "SSE: sometimes no events fire after 30 min of idle dashboard",
    content:
      "Dashboard's live indicator goes grey if I leave it open in a tab " +
      "overnight. Reload fixes it. Probably a keepalive issue — Caddy or " +
      "the EventSource is dropping the connection without the client " +
      "noticing. Not urgent; come back to this.",
    tags: ["eng", "bug", "p3", "dashboard", "sse"],
    shared: true,
    created_offset_days: -22,
  },
  {
    ref: "deploy-flake",
    author: "van",
    title: "GH Actions: deploy job sporadically times out on rsync",
    content:
      "About 1 in 10 deploys hangs at 'rsync /opt/reflect/dev/api'. The " +
      "VM responds fine to manual SSH. Think it's GH runner-side network " +
      "instability. Re-running fixes it every time. Filing for visibility " +
      "but not blocking.",
    tags: ["eng", "infra", "ci", "p3"],
    shared: true,
    created_offset_days: -11,
  },
  {
    ref: "db-migration-template",
    author: "tamer",
    title: "Migration pattern: idempotent schema bumps via _migrations table",
    content:
      "Reminder for future-me on how migrations work in this codebase: " +
      "every migration block in src/index.ts checks _migrations for its " +
      "name first; if not present, applies + records. Means re-running " +
      "the API on a populated DB is always safe. Don't forget the record " +
      "INSERT — that's the easy mistake.",
    tags: ["eng", "db", "migration", "runbook"],
    shared: false,
    created_offset_days: -30,
  },
  {
    ref: "test-coverage-note",
    author: "tamer",
    title: "Test coverage gap: agent-key resolution has no integration test",
    content:
      "Spotted while debugging the OAuth migration: resolveAgentKeyUser " +
      "in oauth-store.ts has unit coverage but nothing exercises the full " +
      "agent-key → user-id → memory-write path against the real DB. Worth " +
      "a small integration test next time we touch that code.",
    tags: ["eng", "tests", "tech-debt"],
    shared: true,
    created_offset_days: -19,
  },
  {
    ref: "perf-tag-search",
    author: "van",
    title: "Perf: get_memories_by_tag is slow on >5k tags",
    content:
      "Profiled on a customer's instance with ~12k memories and ~5k " +
      "distinct tags. The json_each scan goes quadratic. Adding an " +
      "auxiliary tag-to-memory mapping table would make this O(log n) but " +
      "is a real schema change. Park until we have a customer actually " +
      "feeling pain, or until clusters land and reduce the per-tag query " +
      "frequency.",
    tags: ["eng", "perf", "db", "p2"],
    shared: true,
    created_offset_days: -25,
  },
  {
    ref: "mcp-tool-desc-limit",
    author: "tamer",
    title: "OpenAPI: ChatGPT rejects descriptions over 300 chars",
    content:
      "Hit this when shipping the threading + briefing actions. ChatGPT's " +
      "CustomGPT importer hard-fails on operation descriptions > 300 " +
      "chars. We had three at 591/334/603. Tightened them; added a " +
      "regression test in agent-threading-briefing.test.ts that walks " +
      "/openapi.json and asserts no operation exceeds the limit.",
    tags: ["eng", "api", "openapi", "chatgpt", "resolved", "shipped"],
    shared: true,
    created_offset_days: -1,
  },
];

export default ENG;
