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

## Action Required

After deploying, update the ChatGPT Custom Action:
- Import from URL: `https://api.reflectmemory.com/openapi.json`
- Or re-paste the corrected `openapi-agent.yaml` contents
