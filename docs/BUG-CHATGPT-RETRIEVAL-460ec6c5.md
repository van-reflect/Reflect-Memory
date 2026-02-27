# BUG: Memory 460ec6c5 not visible to ChatGPT (CPO)

**Status:** Open  
**Reported:** Feb 27, 2026  
**Escalated from:** ChatGPT (CPO)

## Summary

Memory `460ec6c5-9972-48d0-87fe-039340cc0759` (CPO Update - Anthropic MCP Directory Submission Complete) was written successfully via `POST /agent/memories` using the Claude agent key at 2026-02-27T04:06:41.056Z. The write returned the full object. The memory has `allowed_vendors: ["*"]` and `origin: "claude"`.

ChatGPT (CPO) cannot see this memory when querying. They tried:
- Query by specific ID → "not supported" (may mean their Custom Action doesn't expose GET /agent/memories/:id)
- Query by chronological order → no newer entry returned
- Query by origin: Claude → same (older) result

The most recent Claude-authored memory ChatGPT sees is "CTO Update – Claude MCP + Gemini Gem Integrations Built" (older).

## Verified

- Memory exists in DB (written via curl, returned 201)
- Claude key can fetch it: `GET /agent/memories/latest` returns it
- Memory has `allowed_vendors: ["*"]` — should be visible to all vendors including chatgpt

## Hypotheses

1. **ChatGPT uses different userId** — If the ChatGPT Custom Action is configured for a different Reflect Memory user/workspace, they would query a different dataset. Single-tenant setup has one userId; verify ChatGPT's agent key resolves to the same owner.

2. **ChatGPT Custom Action doesn't expose get-by-ID** — The API supports `GET /agent/memories/:id`. If their OpenAPI/Swagger-fed Custom Action doesn't include this operation, they can't query by ID. **Fix:** Ensure OpenAPI spec includes `getMemoryById` and the ChatGPT action is regenerated from it.

3. **Vendor filter bug for "chatgpt"** — The `vendorClause` uses `json_each(m.allowed_vendors)` with `value = '*' OR value = ?`. For `["*"]` this should match. **Test:** Run `POST /agent/memories/browse` with `filter: { by: "all" }` using `RM_AGENT_KEY_CHATGPT` and confirm 460ec6c5 appears in the response. If it doesn't, the vendor filter may have a SQLite/json_each edge case for the chatgpt vendor.

4. **Different deployment** — ChatGPT integration may point at a different API URL (staging vs prod) or an older deployment.

5. **Caching** — Unlikely with SQLite single-node, but if there's a cache layer in front of the API, it could serve stale data.

## Diagnostic Commands

```bash
# As ChatGPT (use RM_AGENT_KEY_CHATGPT)
curl -s "https://api.reflectmemory.com/agent/memories/latest" \
  -H "Authorization: Bearer $RM_AGENT_KEY_CHATGPT"

# Browse all - does 460ec6c5 appear?
curl -s -X POST "https://api.reflectmemory.com/agent/memories/browse" \
  -H "Authorization: Bearer $RM_AGENT_KEY_CHATGPT" \
  -H "Content-Type: application/json" \
  -d '{"filter":{"by":"all"},"limit":10}'

# Direct get by ID
curl -s "https://api.reflectmemory.com/agent/memories/460ec6c5-9972-48d0-87fe-039340cc0759" \
  -H "Authorization: Bearer $RM_AGENT_KEY_CHATGPT"
```

## Relevant Code

- `src/memory-service.ts` — `listMemories`, `listMemorySummaries`, vendor clause: `json_each(m.allowed_vendors) WHERE value = '*' OR value = ?`
- `src/server.ts` — `/agent/memories/:id`, `/agent/memories/latest`, `/agent/memories/browse`
- `openapi-agent.yaml` — OpenAPI spec for Custom Actions; ensure `getMemoryById` is included and ChatGPT has regenerated from it

## Next Steps

1. Run diagnostics above with ChatGPT agent key.
2. If browse/latest return the memory → problem is in ChatGPT Custom Action schema or implementation.
3. If browse/latest do NOT return the memory → investigate vendor filter or userId resolution for chatgpt.
