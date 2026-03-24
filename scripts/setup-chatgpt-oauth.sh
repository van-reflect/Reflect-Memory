#!/usr/bin/env bash
# Register an OAuth client for the ChatGPT Custom GPT.
#
# Usage:
#   ./scripts/setup-chatgpt-oauth.sh <CALLBACK_URL> [MCP_SERVER_URL]
#
# Steps:
#   1. Open GPT Builder → Configure → Actions → Authentication → select "OAuth"
#   2. Copy the "Callback URL" shown by ChatGPT
#   3. Run this script with that URL
#   4. Enter the output credentials into GPT Builder
#   5. Save the GPT
#
# Example:
#   ./scripts/setup-chatgpt-oauth.sh "https://chatgpt.com/aip/g-abc123/oauth/callback"

set -euo pipefail

CALLBACK_URL="${1:-}"
MCP_URL="${2:-https://api.reflectmemory.com}"

if [[ -z "$CALLBACK_URL" ]]; then
  echo "Error: Callback URL required."
  echo ""
  echo "Usage: $0 <CALLBACK_URL_FROM_GPT_BUILDER> [MCP_SERVER_URL]"
  echo ""
  echo "Get the callback URL from GPT Builder → Actions → Authentication → OAuth"
  exit 1
fi

echo ""
echo "Registering OAuth client..."
echo "  Server:   $MCP_URL"
echo "  Callback: $CALLBACK_URL"
echo ""

RESPONSE=$(curl -sS -X POST "${MCP_URL}/register" \
  -H "Content-Type: application/json" \
  -d "{
    \"client_name\": \"Reflect Memory ChatGPT\",
    \"redirect_uris\": [\"${CALLBACK_URL}\"],
    \"grant_types\": [\"authorization_code\", \"refresh_token\"],
    \"response_types\": [\"code\"],
    \"scope\": \"mcp:read mcp:write\"
  }")

CLIENT_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('client_id',''))" 2>/dev/null || echo "")
CLIENT_SECRET=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('client_secret',''))" 2>/dev/null || echo "")

if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
  echo "ERROR: Registration failed. Server response:"
  echo "$RESPONSE"
  exit 1
fi

echo "====================================================="
echo " GPT Builder → Actions → Authentication → OAuth"
echo "====================================================="
echo ""
echo "  Auth Type:          OAuth"
echo "  Client ID:          $CLIENT_ID"
echo "  Client Secret:      $CLIENT_SECRET"
echo "  Authorization URL:  ${MCP_URL}/authorize"
echo "  Token URL:          ${MCP_URL}/token"
echo "  Scope:              mcp:read mcp:write"
echo "  Token Exchange:     Default (POST)"
echo ""
echo "====================================================="
echo ""
echo "Paste these values into GPT Builder, then save."
echo "Each user who uses the GPT will be asked to approve"
echo "the connection on their first use."
echo ""
