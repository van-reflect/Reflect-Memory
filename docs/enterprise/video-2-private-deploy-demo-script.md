# Video #2 — Private deploy engineering workflow (full hand-hold script)

**Audience:** You (Van) recording end-to-end, minimal prior CLI experience.  
**Sources:** [Enterprise setup guide](https://www.reflectmemory.com/setup/enterprise) (same content as `reflect-memory-dashboard/app/setup/enterprise/page.tsx`), `docs/enterprise/config-modes.md`, `README.md`, `integrations/cursor/README.md`.

**Legend**

| Tag | Meaning |
| --- | --- |
| **ON-CAMERA** | Face to lens; short lines. |
| **VO** | Voice-over while screen is full (terminal, Cursor, etc.). |
| **DIRECTOR** | What to show, clicks, pacing (not spoken). |
| **TELEPROMPTER** | Exact words if you want a strict read. |

**Before day-of (do once)**

1. Docker image running with your real `.env` (from setup guide).  
2. Know your **base URL** — the address in the browser/curl that reaches the container (often `http://localhost:3000` on your laptop; use your real URL if different). Below it is written as `BASE` — **replace every `BASE` with that URL** (no trailing slash).  
3. Open **Notes** or a sticky with three secrets (never show on camera):  
   - `API` = value of `RM_API_KEY`  
   - `CURSOR_AGENT` = value of `RM_AGENT_KEY_CURSOR`  
   - `CLAUDE_AGENT` = value of `RM_AGENT_KEY_CLAUDE` (optional for Video #2 cross-tool beat; set it for the Claude segment)  
4. Cursor MCP: **Settings → MCP** (or project `.cursor/mcp.json`) must use **`"type": "streamable-http"`** and URL **`BASE/mcp`** with header **`Authorization: Bearer CURSOR_AGENT`**. Restart Cursor after edits.  
5. Claude Desktop (optional): `~/Library/Application Support/Claude/claude_desktop_config.json` — same URL and **`Bearer CLAUDE_AGENT`**.  
6. Install **curl** (macOS has it). **`python3 -m json.tool`** pretty-prints JSON; if it errors, run without `| python3 -m json.tool`.

---

## TABLE OF CONTENTS (record in this order)

| # | Section | What you record |
| --- | --- | --- |
| 0 | Optional cold open | On-camera only |
| 1 | Problem + value + lab | On-camera + optional slide |
| 2 | Prove appliance | Terminal |
| 3 | Team via API | Terminal |
| 4 | Engineer A — write + share | Cursor |
| 5 | Engineer B — read team | Claude or second Cursor |
| 6 | Cross-tool | Split or cuts |
| 7 | Security — 503 | Terminal (optional) |
| 8 | Audit | Terminal or VO only |
| 9 | Close | On-camera or end card |
| 10 | B-roll / safety | Director notes only |

---

## Section 0 — Optional cold open (30–45s)

**DIRECTOR:** Face + mic; no secrets on screen.

**ON-CAMERA / TELEPROMPTER**

> I'm Van with Reflect Memory and this is a private deploy video demonstrating one container on your network, team memory, MCP for Cursor and Claude. I'm going to walk through how an engineering org actually uses it, in small steps you can reproduce from our setup guide.

---

## Section 1 — Problem, value, lab

**DIRECTOR:** Still on-camera or simple title slide (three bullets: scattered context / cold sessions / private layer). No terminal yet.

**ON-CAMERA / VO — TELEPROMPTER**

1. Engineering context gets scattered across chat, tickets, docs, and one-off AI sessions.  
2. Every new session starts cold — reviews, incidents, and onboarding all pay that tax again.  
3. Private deploy gives you a **memory and integration layer inside your boundary** — explicit writes, structured reads, team sharing, optional **model egress off** so LLM traffic is a separate control.  
4. What you’ll see is a **lab** — laptop or VM — same mechanics in production with tighter controls.

---

## Section 2 — Prove appliance (terminal)

**DIRECTOR:** Full-screen **Terminal** app. Increase font (Terminal → Settings). Zoom display if needed. **Do not** scroll your `.env` into view.

### Step 2a — Health (no secret in command)

**VO — TELEPROMPTER**

> First I’m proving the appliance is up — only the terminal, no SaaS UI.

**Run (copy as one block; replace `BASE`):**

```bash
curl -s BASE/health | python3 -m json.tool
```

**DIRECTOR:** Pause on JSON. You want **`"status": "ok"`**, **`"service": "reflect-memory"`**. In self-host, expect **`deployment_mode`** / **`model_egress`** wording consistent with [config-modes](config-modes.md) (e.g. egress disabled).

**VO**

> Health is OK — that’s our process running inside your network.

### Step 2b — Whoami (uses API key)

**VO**

> Next I authenticate with the **deployment API key** — the same class of key you use for curl and admin-style REST, not the Cursor MCP key.

**Run (replace `BASE` and paste your API key instead of `PASTE_RM_API_KEY`):**

```bash
curl -s -H "Authorization: Bearer PASTE_RM_API_KEY" \
  BASE/whoami | python3 -m json.tool
```

**DIRECTOR:** Expect something like `"role": "user"` and `"vendor": null` for the owner API key.

**VO**

> If health or whoami fails, you fix networking or keys before you touch MCP — there’s no point demoing Cursor until this is green.

---

## Section 3 — Team on appliance (REST)

**DIRECTOR:** Same terminal window; new commands only.

### Step 3a — Create team

**VO**

> Teams are what make **shared engineering memory** real. On private deploy we create the team with the **REST API** — same patterns as in the setup guide.

**Run:**

```bash
curl -s -X POST BASE/teams \
  -H "Authorization: Bearer PASTE_RM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Engineering"}' \
  | python3 -m json.tool
```

**DIRECTOR:** Copy the **`id`** from the JSON into a note — call it `TEAM_ID`. You will not say it aloud on VO if you prefer; you need it for invites and debugging.

**VO**

> That JSON is the team id — admin flows use this for invites and for the shared pool.

### Step 3b — Invite (optional on video)

**VO**

> Invite is one POST with a real mailbox you control — from the setup guide.

**Run (replace `TEAM_ID` and email):**

```bash
curl -s -X POST BASE/teams/TEAM_ID/invite \
  -H "Authorization: Bearer PASTE_RM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"colleague@yourcompany.com"}' \
  | python3 -m json.tool
```

**DIRECTOR:** If the response includes a join token, **blur in edit** — do not read tokens aloud.

**VO**

> After they join, they have personal memory space plus the **team pool** — sharing is explicit, not silent.

---

## Section 4 — Engineer A (Cursor): `write_memory` + `share_memory`

**DIRECTOR:** Switch to **Cursor**. Open a **new chat** (clean thread). Confirm MCP shows Reflect tools (optional: quick glance at MCP panel — **no** keys visible). Prefer a **scratch file** with the ADR text so you can point the camera at structured content.

**Scratch file to create** (save as `adr-demo.md` in a throwaway folder):

```markdown
# ADR-2026-04: Private MCP base URL

## Status
Accepted

## Context
All Cursor and Claude clients must use the same private Reflect base URL.

## Decision
Standardize on BASE for MCP streamable-http.

## Consequences
Single audit trail; team pool stays inside the VPC.
```

**VO — TELEPROMPTER**

> Engineer A is in Cursor. MCP points at our **private** Reflect endpoint using **RM_AGENT_KEY_CURSOR** — not the REST API key.

**Exact prompt to paste into Cursor (replace nothing if `adr-demo.md` is open):**

```text
Using Reflect Memory MCP tools only: call write_memory with a title "ADR-2026-04: Private MCP base URL", content copied from the open file adr-demo.md, and tags ["adr","enterprise","mcp"]. Then tell me the new memory's id from the tool result.
```

**DIRECTOR:** Wait until the tool finishes. **Copy the memory UUID** from the assistant message into Notes — label it `MEMORY_ID`.

**VO**

> That memory is **personal** until we explicitly publish it — that’s the governance story.

**Second prompt (replace `MEMORY_ID`):**

```text
Using Reflect Memory MCP: call share_memory for memory id MEMORY_ID so it is shared with my team. Confirm success in one sentence.
```

**VO**

> share_memory moves it into the **team pool** with attribution — nothing silently leaks to a vendor-hosted memory SaaS.

---

## Section 5 — Engineer B: `read_team_memories`

**DIRECTOR:** Switch to **Claude Desktop** (or a second Cursor window signed with the other agent personality). Must use **`BASE/mcp`** and **`RM_AGENT_KEY_CLAUDE`** if Claude; same team membership in real multi-user deploys. For a **solo lab**, same owner account often still has a team; the tool reads the **shared pool**.

**VO**

> Engineer B uses the **same private MCP URL** but the **Claude** agent key — second vendor, same substrate.

**Prompt for Claude:**

```text
Use Reflect Memory MCP: call read_team_memories. List titles of shared memories and who authored them if shown.
```

**DIRECTOR:** Scroll slowly so JSON or formatted text is readable for 2 seconds.

**VO**

> That’s internal reuse without Slack archaeology — one explicit share, many consumers.

---

## Section 6 — Cross-tool MCP

**DIRECTOR:** Split screen: **Cursor** left, **Claude** right — or hard cut between the same memory title visible in both.

**VO — TELEPROMPTER**

> Cross-tool still means **private only** — Cursor and Claude both hit **BASE/mcp** with their own agent keys.  
> Optional: ask Claude to `write_memory` a short follow-up note tagged `follow-up`, then in Cursor `search_memories` for `follow-up` — proves round-trip inside the boundary.

---

## Section 7 — Security: egress / 503

**DIRECTOR:** Back to terminal. Optional: one static diagram slide (memory plane vs model plane) if you have it.

**VO**

> For security buyers: **memory and MCP** live here; **where the LLM runs** is a different control. In default self-host, **model egress is disabled** — `/query` and `/chat` may return **503** on purpose. That’s policy, not a broken demo.

**Optional command (replace `BASE` and API key — expect `503` when model egress is disabled):**

```bash
curl -s -w "\nHTTP %{http_code}\n" \
  -X POST BASE/query \
  -H "Authorization: Bearer PASTE_RM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"Summarize our ADRs in one sentence.","memory_filter":{"by":"all"}}'
```

**DIRECTOR:** Expect JSON mentioning **model egress disabled** and HTTP **503** when policy blocks `/query` (see [config-modes.md](config-modes.md)). If you get **404** or **401** instead, skip fighting it on camera — one line: *“Your route or auth may differ; the setup guide troubleshooting covers 503 for disabled egress.”*

---

## Section 8 — Audit

**DIRECTOR:** Terminal only if you are comfortable; otherwise **VO over b-roll** (logo, architecture slide).

**VO**

> Operations are logged; exports are part of the enterprise story — the setup guide **Built-in Features** section describes audit logging and **`/admin/audit/export`**.

**Optional owner-only check (replace key; blur rows if sensitive):**

```bash
curl -s -H "Authorization: Bearer PASTE_RM_API_KEY" \
  "BASE/admin/audit?limit=5" | python3 -m json.tool
```

**DIRECTOR:** If you get **403**, your key may not be owner/admin — skip on camera and mention audit in VO only.

---

## Section 9 — Close

**DIRECTOR:** End card or browser with two URLs; speak slowly.

**ON-CAMERA / TELEPROMPTER**

- Enterprise positioning: **https://reflectmemory.com/enterprise**  
- Operator setup guide (gated in product; same path customers use): **https://reflectmemory.com/setup/enterprise**  
- Contact: **vm@reflectmemory.com**

---

## Section 10 — Production checklist (not recorded)

- [ ] Rehearse Sections 2–3 once; paste real `BASE` and keys in a **local** cheat sheet file — not in repo.  
- [ ] `mcp.json` uses **`streamable-http`** and **`BASE/mcp`**.  
- [ ] Blur `.env`, join tokens, raw keys in post.  
- [ ] Do **not** narrate the **hosted cloud dashboard** as if it were private deploy.  
- [ ] Backup: pre-seed one shared memory if live `write_memory` fails during recording.

---

## Quick reference — MCP config snippets

**Cursor (`~/.cursor/mcp.json` or project `.cursor/mcp.json`) — replace values:**

```json
{
  "mcpServers": {
    "reflect-memory": {
      "url": "BASE/mcp",
      "type": "streamable-http",
      "headers": {
        "Authorization": "Bearer PASTE_RM_AGENT_KEY_CURSOR"
      }
    }
  }
}
```

**Claude Desktop (macOS path from setup guide):**  
`~/Library/Application Support/Claude/claude_desktop_config.json` — same structure, use **`PASTE_RM_AGENT_KEY_CLAUDE`**.

---

## Troubleshooting (on-camera bailouts)

| Symptom | Fix (from setup guide) |
| --- | --- |
| 404 on `/mcp` | Add **`"type": "streamable-http"`**; set **`RM_PUBLIC_URL`** in `.env`; restart container. |
| 401 on MCP | Use **agent** key in MCP header, **not** `RM_API_KEY`. |
| Health shows MCP not running | Set **`RM_PUBLIC_URL`** and at least one **`RM_AGENT_KEY_*`**. |
| Team tools missing | Create team via **`POST /teams`**; user must be on team. |

---

*Confidential internal script. Align on-camera disclaimers with legal/comms.*
