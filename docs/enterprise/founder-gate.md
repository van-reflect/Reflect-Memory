# Founder Gate — Non-Technical Operator Runbook

**Who this is for:** You (Van). No coding knowledge required.
**What you are checking:** Not code. Business-safe outcomes only.
**Time to complete:** ~20 minutes.
**What you need:** A terminal window. Docker installed. The project folder open.

---

## Before You Start

Open a terminal and navigate to the project folder:

```bash
cd ~/Desktop/reflective-memory
```

You will run each command below, compare the output to what is shown, and check PASS or FAIL.

---

## STEP 1 — Generate a fresh enterprise config

**What this does:** Creates a new `.env.enterprise` file with secure random keys for this tenant. Think of it like generating a new password vault for a customer.

**Command:**

```bash
npm run bootstrap:enterprise
```

**Expected output:**

```
Wrote .env.enterprise
Next steps:
  1) Fill RM_OWNER_EMAIL and model provider settings
  2) Validate: node scripts/validate-enterprise-env.mjs .env.enterprise
  3) Start: docker compose --env-file .env.enterprise --profile self-host up --build
```

**Failure output (what bad looks like):**

```
Refusing to overwrite existing .env.enterprise
```

> If you see the failure output, it means a config file already exists. Delete it first with `rm .env.enterprise` and re-run.

- [ ] **PASS** — output matches expected
- [ ] **FAIL** — output does not match or shows an error

---

## STEP 2 — Validate the security settings

**What this does:** Checks that the config file has all required security fields filled in before anything starts. Like a pre-flight checklist.

**Command:**

```bash
npm run validate:enterprise
```

**Expected output:**

```
Enterprise env validation passed.
```

**Failure output (what bad looks like):**

```
Enterprise env validation failed:
 - Missing required value: RM_TENANT_ID
 - self-host requires RM_DISABLE_MODEL_EGRESS=true or an explicit RM_ALLOWED_MODEL_HOSTS allowlist
```

> If you see failures, open `.env.enterprise` in any text editor, fill in the missing values shown, and re-run this command.

- [ ] **PASS** — output says `Enterprise env validation passed.`
- [ ] **FAIL** — output lists any failures

---

## STEP 3 — Start the private instance

**What this does:** Builds and starts the enterprise container with private-network defaults. Data stays local. Nothing leaves the machine unless you configure it to.

**Command:**

```bash
docker compose --env-file .env.enterprise --profile self-host up --build -d
```

**Expected output (last few lines):**

```
 ✔ Container reflect-memory-reflect-memory-selfhost-1  Started
```

**Failure output (what bad looks like):**

```
Error response from daemon: driver failed programming external connectivity
```

or

```
Error: Cannot connect to the Docker daemon
```

> If Docker is not running, open the Docker Desktop app first and wait for it to say "Running", then retry.

- [ ] **PASS** — container shows `Started`
- [ ] **FAIL** — any error message appears

---

## STEP 4 — Verify the service is alive and in the right mode

**What this does:** Asks the service to confirm it is running and that it is in private/self-host mode. This is your proof the deployment mode is correct.

**Command:**

```bash
curl -s http://127.0.0.1:3000/health | python3 -m json.tool
```

**Expected output:**

```json
{
    "service": "reflect-memory",
    "status": "ok",
    "uptime_seconds": 4,
    "deployment_mode": "self-host",
    "network_boundary": "private",
    "model_egress": "disabled",
    "public_webhooks": false
}
```

**Failure output (what bad looks like):**

```
curl: (7) Failed to connect to 127.0.0.1 port 3000
```

or

```json
{
    "deployment_mode": "hosted"
}
```

> First failure means the container is not running — go back to Step 3. Second failure means the mode is wrong — check that `.env.enterprise` has `RM_DEPLOYMENT_MODE=self-host`.

- [ ] **PASS** — `status` is `ok`, `deployment_mode` is `self-host`, `network_boundary` is `private`
- [ ] **FAIL** — any field is missing, wrong, or connection refused

---

## STEP 5 — Confirm your API key works (auth check)

**What this does:** Proves that a valid key gets access. This is the "front door works" test.

First, get your API key from the config file:

```bash
grep RM_API_KEY .env.enterprise
```

Copy the value after the `=` sign. Then run:

```bash
curl -s -o /dev/null -w "%{http_code}" \
  http://127.0.0.1:3000/whoami \
  -H "Authorization: Bearer PASTE_YOUR_KEY_HERE"
```

**Expected output:**

```
200
```

**Failure output (what bad looks like):**

```
401
```

> `200` means the key works. `401` means the key was rejected — double-check you copied the full key with no spaces.

- [ ] **PASS** — output is `200`
- [ ] **FAIL** — output is `401` or anything else

---

## STEP 6 — Confirm a wrong key is rejected (security check)

**What this does:** Proves the front door locks out anyone without a valid key. This is the core privacy guarantee.

**Command:**

```bash
curl -s -o /dev/null -w "%{http_code}" \
  http://127.0.0.1:3000/whoami \
  -H "Authorization: Bearer this_is_a_fake_key_12345"
```

**Expected output:**

```
401
```

**Failure output (what bad looks like):**

```
200
```

> If a fake key returns `200`, the auth system is broken. Stop everything and do not proceed. This is a hard FAIL.

- [ ] **PASS** — output is `401`
- [ ] **FAIL** — output is anything other than `401` (critical security failure)

---

## STEP 7 — Write and read a memory (data flow check)

**What this does:** Proves data can be written and read back correctly. This is the core product working end-to-end.

First, get your API key:

```bash
grep RM_API_KEY .env.enterprise
```

Set it for this session:

```bash
export RM_SMOKE_API_KEY="PASTE_YOUR_KEY_HERE"
export RM_SMOKE_BASE_URL="http://127.0.0.1:3000"
```

Then run the smoke test:

```bash
npm run smoke:enterprise
```

**Expected output:**

```
Enterprise smoke test passed.
```

**Failure output (what bad looks like):**

```
Write failed: 401
```

or

```
Read failed: 500
```

> Any failure here means data is not flowing correctly. Note the error code and stop.

- [ ] **PASS** — output says `Enterprise smoke test passed.`
- [ ] **FAIL** — any other output

---

## STEP 8 — Verify model egress is blocked (privacy check)

**What this does:** Confirms that in self-host mode, the AI query endpoint is disabled. This means no data can be sent to external AI providers (OpenAI, Anthropic, etc.) from this instance.

**Command:**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}" \
  -X POST http://127.0.0.1:3000/query \
  -H "Authorization: Bearer PASTE_YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"query":"test"}'
```

**Expected output:**

```json
{"error":"Model egress disabled by deployment policy","mode":"self-host"}
HTTP_STATUS:503
```

**Failure output (what bad looks like):**

```
HTTP_STATUS:200
```

> `503` with the policy message is correct — it means the system is actively blocking outbound AI calls. `200` would mean data could leave the network, which is a privacy failure.

- [ ] **PASS** — status is `503` and body contains `Model egress disabled by deployment policy`
- [ ] **FAIL** — status is `200` (data would leave the network — critical)

---

## STEP 9 — Tenant isolation check

**What this does:** Proves that two separate enterprise customers cannot see each other's data. This is the core multi-tenant privacy guarantee.

This test requires two separate running instances with different API keys and different DB volumes. For V1 validation, confirm the following visually:

**Command — check that each instance has its own separate data volume:**

```bash
docker volume ls | grep rm_data
```

**Expected output:**

```
local     reflect-memory_rm_data_selfhost
```

> Each enterprise customer gets their own named volume. There is no shared volume between tenants. If you see only one volume per deployment, isolation is correct.

**Command — confirm the running container's DB path:**

```bash
docker inspect reflect-memory-reflect-memory-selfhost-1 \
  --format '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{"\n"}}{{end}}'
```

**Expected output:**

```
reflect-memory_rm_data_selfhost -> /data
```

> This confirms the data is stored in an isolated volume, not shared with any other container.

- [ ] **PASS** — each tenant has its own named volume, no shared volumes
- [ ] **FAIL** — volumes are shared or missing

---

## STEP 10 — Confirm audit trail exists

**What this does:** Proves that security events (failed logins, sensitive actions) are being recorded. This is your compliance and incident-response foundation.

**Command:**

```bash
docker exec reflect-memory-reflect-memory-selfhost-1 \
  node -e "
    const db = require('better-sqlite3')('/data/reflect-memory.db');
    const rows = db.prepare('SELECT event_type, severity, created_at FROM audit_events ORDER BY created_at DESC LIMIT 5').all();
    console.log(JSON.stringify(rows, null, 2));
    db.close();
  "
```

**Expected output (example — will vary):**

```json
[
  {
    "event_type": "security.auth_invalid_key",
    "severity": "warn",
    "created_at": "2026-03-19T00:50:01.000Z"
  }
]
```

> You should see at least one entry from the fake-key test in Step 6. If the array is empty and you ran Step 6, something is wrong with audit logging.

- [ ] **PASS** — at least one audit event appears, matching a test you ran
- [ ] **FAIL** — empty array after running Step 6, or command errors

---

## STEP 11 — Verify MCP endpoint is running

**What this does:** Confirms the MCP (Model Context Protocol) endpoint is active. This is how AI tools like Cursor and Claude connect to your instance.

**Prerequisite:** At least one `RM_AGENT_KEY_*` must be set in your `.env` / `.env.enterprise`. Without an agent key, the MCP endpoint will not start and this test will correctly return 404.

**Command:**

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://127.0.0.1:3000/mcp \
  -H "Authorization: Bearer PASTE_YOUR_AGENT_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Expected output:**

```
400
```

> `400` means the MCP endpoint is alive and rejecting an empty (malformed) MCP request — this is correct. `404` means the endpoint never started — check that an `RM_AGENT_KEY_*` variable is set. `401` means the agent key is wrong.

- [ ] **PASS** — output is `400` (endpoint alive, rejects malformed body)
- [ ] **FAIL** — output is `404` (MCP not started) or `401` (wrong key)

---

## STEP 12 — Connect Cursor to your local instance

**What this does:** Verifies that Cursor can connect to the MCP endpoint and discover memory tools.

1. Create `.cursor/mcp.json` in any project folder:

```json
{
  "mcpServers": {
    "reflect-memory": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer PASTE_YOUR_AGENT_KEY_HERE"
      }
    }
  }
}
```

2. Restart Cursor completely (quit and reopen).
3. Open the MCP section in Cursor Settings — you should see 9 tools listed under "reflect-memory".

**Important notes:**
- `type` must be `"streamable-http"` — without it, Cursor defaults to SSE which is not supported
- The Bearer token must be the value of your `RM_AGENT_KEY_CURSOR` (or whichever agent key you set), **not** `RM_API_KEY`
- The MCP endpoint uses a separate auth system from the REST API

- [ ] **PASS** — Cursor shows 9 reflect-memory tools
- [ ] **FAIL** — Tools not showing, or connection error in Cursor

---

## STEP 13 — Set up team memories (optional)

**What this does:** Creates a team so the `read_team_memories` and `share_memory` MCP tools become active. This enables shared context across team members.

**Command — create a team:**

```bash
curl -s -X POST http://127.0.0.1:3000/teams \
  -H "Authorization: Bearer PASTE_YOUR_API_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Team"}' | python3 -m json.tool
```

**Expected output:**

```json
{
    "id": "...",
    "name": "My Team",
    "created_by": "...",
    "created_at": "..."
}
```

**Command — invite a team member (optional):**

```bash
curl -s -X POST http://127.0.0.1:3000/teams/TEAM_ID/invite \
  -H "Authorization: Bearer PASTE_YOUR_API_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"email": "teammate@example.com"}' | python3 -m json.tool
```

> In a single-user local deployment, the team owner is the only member. Team tools still work — you can share memories with the team and read them back. To test with multiple users, you would need separate API keys and user accounts.

- [ ] **PASS** — team created, ID returned
- [ ] **FAIL** — error response

---

## ONE-COMMAND DEMO RUN

To run the full setup from scratch in one shot (after filling in `.env.enterprise`):

```bash
npm run bootstrap:enterprise \
  && npm run validate:enterprise \
  && docker compose --env-file .env.enterprise --profile self-host up --build -d \
  && sleep 5 \
  && curl -s http://127.0.0.1:3000/health | python3 -m json.tool
```

**Expected final output:**

```json
{
    "service": "reflect-memory",
    "status": "ok",
    "deployment_mode": "self-host",
    "network_boundary": "private",
    "model_egress": "disabled",
    "public_webhooks": false
}
```

If you see this output, the private instance is running correctly.

---

## EVIDENCE TO CAPTURE (for your records)

Before signing off, save the following as screenshots or copy the terminal output into a doc:

1. Output of Step 4 (health check JSON)
2. Output of Step 6 (`401` from fake key)
3. Output of Step 7 (`Enterprise smoke test passed.`)
4. Output of Step 8 (`503` model egress blocked)
5. Output of Step 10 (audit events list)

---

## FINAL FOUNDER SIGNOFF CHECKLIST

Go through each item. Every box must be checked before approving for enterprise use.

**Service health**
- [ ] Service starts and `/health` returns `status: ok`
- [ ] `deployment_mode` is `self-host`
- [ ] `network_boundary` is `private`

**Auth and access control**
- [ ] Valid API key returns `200`
- [ ] Fake/wrong key returns `401` immediately
- [ ] No unauthenticated route returns data

**Data privacy**
- [ ] Model egress is `disabled` — no AI calls leave the network
- [ ] Each tenant has its own isolated data volume
- [ ] No shared volumes between tenants

**Data flow**
- [ ] Write and read smoke test passes end-to-end

**Audit trail**
- [ ] Audit events table exists and is recording security events

**MCP and integrations**
- [ ] MCP endpoint returns `400` on empty POST (alive, not 404)
- [ ] Cursor connects and shows 9 tools
- [ ] Agent key auth works (not `RM_API_KEY`)

**Team memories**
- [ ] Team creation succeeds via REST API
- [ ] Team tools (`read_team_memories`, `share_memory`) visible in MCP clients

**Compatibility**
- [ ] Existing hosted product is unaffected (run `npm run compat:check` against production URL)

---

**Gate decision:**

- [ ] **ALL CHECKS PASS** → Approved for enterprise pilot. Proceed to Opus hardening phase.
- [ ] **ANY CHECK FAILS** → Do not proceed. Document which step failed and what the output was.

---

*Last updated: 2026-03-19*
