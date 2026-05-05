// How-to runbooks. Tagged `runbook + <area>` so they cluster together
// regardless of which area they cover. Mostly personal-pool entries (a
// runbook is usually one person's "I had to figure this out, writing it
// down"), but a few shared ones for incident-response patterns.

import type { FixtureCategory } from "./types.js";

const RUNBOOKS: FixtureCategory = [
  {
    ref: "runbook-deploy-rollback",
    author: "tamer",
    title: "Runbook: rolling back a bad prod deploy in under 5 min",
    content:
      "1) On the VM as root: `cd /opt/reflect/prod/api && git log -3` " +
      "to find last-known-good SHA. 2) `git checkout <sha> && npm run " +
      "build && systemctl restart reflect-api`. 3) Verify " +
      "https://api.reflectmemory.com/health returns 200. 4) Open a " +
      "post-mortem child memory under whatever broke; tag with " +
      "`incident` + `resolved` once stable.",
    tags: ["runbook", "deploy", "incident", "ops"],
    shared: true,
    created_offset_days: -55,
  },
  {
    ref: "runbook-add-team-member",
    author: "tamer",
    title: "Runbook: provisioning a new team member end-to-end",
    content:
      "Dashboard → Settings → Team → Invite. Choose role (member/owner). " +
      "They get an email; on first login the OAuth handshake creates " +
      "their user row + assigns org_id. Their MCP connector URL is the " +
      "same; they auth with their own personal API key from the dashboard.",
    tags: ["runbook", "onboarding", "team", "auth"],
    shared: false,
    created_offset_days: -42,
  },
  {
    ref: "runbook-debug-mcp-401",
    author: "van",
    title: "Runbook: debugging a customer 'MCP returns 401' report",
    content:
      "1) Confirm their connector URL is BASE/mcp not BASE. 2) Confirm " +
      "they're using `Authorization: Bearer <key>` not the old " +
      "`X-API-Key`. 3) Check key is active (not revoked) in " +
      "dashboard → API Keys. 4) Check timestamp on their last_used_at — " +
      "if never used, their key is wrong. 5) curl initialize against MCP " +
      "with their key to confirm — see the snippet in our oncall doc.",
    tags: ["runbook", "support", "mcp", "auth"],
    shared: true,
    created_offset_days: -18,
  },
  {
    ref: "runbook-prod-db-snapshot",
    author: "tamer",
    title: "Runbook: snapshotting prod DB before a risky migration",
    content:
      "ssh root@vm; cd /var/lib/reflect/prod/data; sqlite3 " +
      "reflect-memory.db '.backup snapshot.db'; mv snapshot.db " +
      "/root/snapshots/$(date +%F-%H%M).db. WAL mode means .backup is " +
      "consistent without stopping the service. Restore: stop service, " +
      "swap files, restart.",
    tags: ["runbook", "db", "backup", "ops"],
    shared: false,
    created_offset_days: -65,
  },
  {
    ref: "runbook-rotate-agent-key",
    author: "tamer",
    title: "Runbook: rotating an RM_AGENT_KEY_* without downtime",
    content:
      "Edit /opt/reflect/{dev,prod}/api/.env, replace the key, " +
      "`systemctl restart reflect-api` (or reflect-api-dev). The bearer " +
      "middleware re-reads env on boot. Update the corresponding " +
      "vendor's connector config (Cursor mcp.json, ChatGPT action auth, " +
      "etc.) afterward.",
    tags: ["runbook", "auth", "ops", "secrets"],
    shared: false,
    created_offset_days: -28,
  },
  {
    ref: "runbook-clear-trash",
    author: "van",
    title: "Runbook: bulk-clearing my dashboard trash",
    content:
      "Easiest: dashboard → Trash tab → Empty Trash. SQL way (if API is " +
      "down): ssh + sqlite3 + DELETE FROM memories WHERE user_id = ? " +
      "AND deleted_at IS NOT NULL. Don't forget to also delete the " +
      "matching memory_versions rows.",
    tags: ["runbook", "dashboard", "db"],
    shared: false,
    created_offset_days: -8,
  },
  {
    ref: "runbook-dns-records",
    author: "tamer",
    title: "Runbook: where DNS records live and how to add one",
    content:
      "Domain is registered at Squarespace. DNS records are at " +
      "Squarespace → Settings → Domains → reflectmemory.com → DNS " +
      "Settings → Custom Records. A records point at 144.202.1.205 (the " +
      "Vultr VM). For Google Workspace email auth records (SPF/DKIM/" +
      "DMARC), see the email-deliverability child memory.",
    tags: ["runbook", "dns", "infra", "email"],
    shared: false,
    created_offset_days: -50,
  },
];

export default RUNBOOKS;
