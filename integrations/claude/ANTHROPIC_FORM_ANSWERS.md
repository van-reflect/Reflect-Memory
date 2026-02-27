# Anthropic Form Answers — Testing Section

Use these for the Testing credentials page of your MCP Connector submission.

---

## 1. Test Account Server URL (if different from main server URL)

**Your answer:**

```
Same as main server URL. Use https://api.reflectmemory.com/mcp
```

*(Leave blank if there's a separate field for main URL and this only applies when different.)*

---

## 2. Test Account Setup Instructions

**Your answer:**

```
REFLECT MEMORY MCP — SETUP FOR CLAUDE CODE TESTING

1. You will receive a test API key (Bearer token) by [email / secure link — specify how you'll provide it].

2. Add the MCP server in Claude Code:

   Via CLI:
   
   claude mcp add --transport http reflect-memory https://api.reflectmemory.com/mcp \
     --header "Authorization: Bearer <PASTE_TEST_KEY_HERE>"

   Or add to your MCP config (e.g. ~/.claude/mcp.json):

   {
     "mcpServers": {
       "reflect-memory": {
         "type": "streamable-http",
         "url": "https://api.reflectmemory.com/mcp",
         "headers": { "Authorization": "Bearer <PASTE_TEST_KEY_HERE>" }
       }
     }
   }

3. Restart Claude Code. The Reflect Memory tools should appear (Read Memories, Browse Memories, Search Memories, Get Latest Memory, Get Memory by ID, Get Memories by Tag, Create Memory).

4. Quick test: Ask Claude to "browse my memories" or "write a memory: Test from Anthropic review". The test account includes sample memories so read/browse/search tools work immediately.
```

---

## 3. Test Data Availability

Check both boxes **if** your test account has pre-seeded sample memories:

- ✅ **Test account includes sample data**
- ✅ **All tools can be tested with provided data**

If the account starts empty (reviewers must use "Create Memory" first), leave them unchecked and add this to the Setup Instructions instead:

```
The test account starts empty. Use the "Create Memory" tool first (e.g. "Write a memory: Sample test - this is for Anthropic review"), then test read, browse, and search tools.
```

---

## Where Does the API Key Go?

**You** generate a random API key (e.g. `sk-anthropic-review-` + random string, or a UUID). Then:

1. **In Railway** — Add it as the `RM_AGENT_KEY_CLAUDE` env var for your production (or a dedicated test deployment). This lets the MCP server accept that token.

2. **For reviewers** — Paste the key into the Anthropic form field where they ask for test credentials (often labeled "Test API key" or "Credentials for reviewers"). Anthropic gives it to their review team.

3. **Reviewers** paste your key into their MCP config when they follow the setup instructions — in the `Authorization: Bearer <key>` header. They don't generate or sign up for anything; they use the key you provide.

---

## Before Submitting

1. **Generate a test API key** — e.g. `openssl rand -hex 24` or a UUID. Add it to Railway as `RM_AGENT_KEY_CLAUDE` (or to a test deployment). Paste the same key into Anthropic's test credentials field.

2. **Pre-seed sample data** — Run: `npm run seed-review` (with `RM_DB_PATH` and `RM_OWNER_EMAIL` set). Or on Railway: one-off job with those env vars. This adds 8 sample memories so reviewers can test read/browse/search immediately.

3. **Replace placeholders** — In the Setup Instructions, replace `<PASTE_TEST_KEY_HERE>` with "the API key provided in the Test Credentials field below" (or however Anthropic phrases it).
