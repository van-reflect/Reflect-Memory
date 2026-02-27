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

## Before Submitting

1. **Generate a test API key** — Create a dedicated `RM_AGENT_KEY_CLAUDE` value for the review (or use a test deployment). Share it with Anthropic via the channel they specify (form field, email, etc.).
2. **Pre-seed sample data** (recommended) — Add 3–5 sample memories to the test account so reviewers can exercise read/browse/search immediately. For example: a memory tagged "council", one tagged "preferences", etc.
3. **Replace placeholders** — In the Setup Instructions, replace `<PASTE_TEST_KEY_HERE>` with instructions for where reviewers get the key (e.g. "the key provided in the Test Credentials field below" or "sent separately to reviewers").
