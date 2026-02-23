#!/bin/bash
# Write council update to Reflect Memory for Onyx to pull.
# Usage: RM_API_KEY=your_key ./scripts/write-council-memory.sh

set -e
: "${RM_API_KEY:?Set RM_API_KEY (from Railway) to run this script}"

curl -s -X POST "https://api.reflectmemory.com/memories" \
  -H "Authorization: Bearer $RM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Council Update — Security Hardening Audit Complete",
    "content": "COUNCIL-LEVEL STATUS. Security hardening plan implemented across both repos (reflective-memory backend + reflect-memory-dashboard). Phase 1: Fixed destructive startup migration (one-time _migrations table, no more alpha user wipe); removed leaked API key from .env.local; moved Gemini API key from URL to header. Phase 2: CORS origin allowlist, rate limiting (global + per-endpoint), JWT audience/issuer validation, email validation, input size limits, stripped user_id from responses, sanitized errors, validated LLM tool args, escaped LIKE wildcards, graceful shutdown. Phase 3: Security headers (CSP, X-Frame-Options, etc.), magic-link rate limit + single-use, server-side admin auth, fetch timeouts, secure cookies. Council is aligned. Ready for Steve Chen alpha and investor scrutiny.",
    "tags": ["council", "onyx_read", "security_hardening", "audit_complete", "project_state"]
  }' | jq . 2>/dev/null || cat
