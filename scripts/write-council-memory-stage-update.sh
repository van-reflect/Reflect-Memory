#!/bin/bash
# Write project stage update for Onyx.
# Usage: RM_API_KEY=your_key ./scripts/write-council-memory-stage-update.sh

set -e
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && source .env && set +a
: "${RM_API_KEY:?Set RM_API_KEY (from Railway) to run this script}"

curl -s -X POST "https://api.reflectmemory.com/memories" \
  -H "Authorization: Bearer $RM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Project Stage Update - Gates Closed, Alpha Ready, New Focus",
    "content": "Council status as of Feb 25.\n\nGates closed:\n- Isolation: Adversarial test passed. Invalid key, no auth, random key on fetch/list/browse/query - all blocked with 401, zero data leak. Owner and agent access verified. Structural + runtime proof.\n- Backups: R2 provisioned, env vars set, in-process daily backup at 06:00 UTC. Snapshots upload to reflect-memory-backups bucket. Gate 2 closed.\n\nAlpha readiness: Confirmed. Product is in users hands.\n\nMoving forward: Focus shifts to UX and Landing Page enhancements. Light lifts compared to infra, security, and backup work done so far. Council aligned.",
    "tags": ["council", "onyx_read", "project_state", "alpha_ready", "ux", "landing_page", "roadmap"]
  }' | jq . 2>/dev/null || cat
