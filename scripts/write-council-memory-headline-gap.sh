#!/bin/bash
# Write council memory: landing headline vs current capability gap for Onyx to pull.
# Usage: RM_API_KEY=your_key ./scripts/write-council-memory-headline-gap.sh
# Or add RM_API_KEY to reflective-memory/.env and run from project root.

set -e
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && source .env && set +a
: "${RM_API_KEY:?Set RM_API_KEY (from Railway) to run this script}"

curl -s -X POST "https://api.reflectmemory.com/memories" \
  -H "Authorization: Bearer $RM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Council - Headline vs Capability Gap, Onyx CPO Input Requested",
    "content": "The main headline for the landing page is \"See and control what your AI tools know about you.\" but right now we do not import memories from any connected AIs and we do not have an import mechanism. Onyx needs to weigh in on this first as he is interim CPO and you (Claude) are interim CTO. Council is back in session.",
    "tags": ["council", "onyx_read", "headline", "capability_gap", "import", "cpo_cto", "council_session"]
  }' | jq . 2>/dev/null || cat
