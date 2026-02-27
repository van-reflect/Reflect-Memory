# BUG: Memory 460ec6c5 not visible to ChatGPT (CPO)

**Status:** RESOLVED  
**Reported:** Feb 27, 2026  
**Resolved:** Feb 27, 2026  
**Escalated from:** ChatGPT (CPO)

## Root Cause

**Malformed YAML in `openapi-agent.yaml`** — lines 101 and 103 used semicolons instead of commas inside YAML flow mappings for the `getLatestMemory` response schema:

```yaml
# BROKEN — semicolons are not YAML separators
tags: { type: array; items: { type: string } }
allowed_vendors: { type: array; items: { type: string } }

# FIXED — commas are the correct separator
tags: { type: array, items: { type: string } }
allowed_vendors: { type: array, items: { type: string } }
```

In YAML, `;` is a plain character. The parser read `tags.type` as the string literal `"array; items: { type: string }"` instead of type `array` with `items: {type: string}`. This corrupted the `getLatestMemory` response schema, causing ChatGPT's Custom Action import to either silently skip the endpoint or produce a broken client.

## Impact

- `getLatestMemory` endpoint was unavailable or unreliable in ChatGPT
- `getMemoryById` was reported as "not supported" — likely due to spec import failure cascading
- ChatGPT fell back to `/query` or `/agent/memories/browse` but its AI misinterpreted the results
- The backend API was correct and unaffected — only the spec document was broken

## Fix Applied

1. Fixed semicolons → commas in `openapi-agent.yaml` (lines 101, 103)
2. Added `GET /openapi.json` — serves the spec as parsed JSON, unauthenticated, so ChatGPT can import from a URL
3. Installed `js-yaml` dependency for spec serving
4. Validated all 7 operations parse correctly with proper types

## Additional Finding: Tag Mismatch + Wrong Endpoint

The YAML fix alone was insufficient. Further investigation revealed:

1. **Missing `project_state` tag** — Memory 460ec6c5 was written with tags `["council", "cpo_update", "anthropic", "mcp", "submission", "cto"]` but the Custom GPT instructions tell ChatGPT to query with `memory_filter: {"by":"tags","tags":["project_state"]}`. The memory was correctly filtered out by the tag filter. **Fixed:** Added `project_state` and `architecture` tags to the memory via `PUT /memories/:id`.

2. **Custom GPT uses wrong endpoint for recency** — The instructions only mention `queryMemory`, which is an AI summarization layer. Even when the correct memories are fed to the model, the AI may summarize older ones as "latest" based on content relevance, not chronological order. The `getLatestMemory` endpoint exists for strict chronological retrieval but was never mentioned in the Custom GPT instructions. **Fixed:** Created updated instructions at `integrations/chatgpt/CUSTOM_GPT_INSTRUCTIONS.md` that teach ChatGPT to use `getLatestMemory` for recency, `browseMemories` for discovery, and `queryMemory` only for AI synthesis.

## Action Required

1. Deploy the YAML fix and `/openapi.json` endpoint (git push)
2. Re-import the OpenAPI spec in ChatGPT Custom Action from `https://api.reflectmemory.com/openapi.json`
3. Update the Custom GPT instructions using `integrations/chatgpt/CUSTOM_GPT_INSTRUCTIONS.md`
4. Going forward, always include `project_state` tag on memories ChatGPT should find via its default query pattern
