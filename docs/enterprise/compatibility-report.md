# Upstream/Downstream Compatibility Report — Enterprise V1

## Methodology

Reviewed all API contracts, auth flows, and integration points for behavioral changes introduced by enterprise deployment modes. Tested via `scripts/compat-check.mjs` and manual contract analysis.

---

## API Contract Analysis

### Public endpoints (no auth)

| Endpoint | Behavior change | Impact | Regression? |
|----------|-----------------|--------|-------------|
| `GET /health` | Added `deployment_mode`, `network_boundary`, `model_egress`, `public_webhooks` fields | Additive only | NO |
| `GET /openapi.json` | No change | None | NO |
| `POST /waitlist` | No change | None | NO |
| `POST /early-access` | No change | None | NO |
| `POST /integration-requests` | No change | None | NO |

### Webhook endpoints

| Endpoint | Behavior change | Impact | Regression? |
|----------|-----------------|--------|-------------|
| `POST /webhooks/clerk` | Returns 404 when `allowPublicWebhooks=false` (self-host) | Intentional security block | NO (expected for self-host) |
| `POST /webhooks/stripe` | Returns 404 when `allowPublicWebhooks=false` (self-host) | Intentional security block | NO (expected for self-host) |

### Authenticated endpoints

| Endpoint | Behavior change | Impact | Regression? |
|----------|-----------------|--------|-------------|
| `POST /query` | Returns 503 when `disableModelEgress=true` | Intentional block | NO (expected for self-host) |
| `POST /chat` | Returns 503 when `disableModelEgress=true` | Intentional block | NO (expected for self-host) |
| All memory CRUD | No change | None | NO |
| `GET /whoami` | No change | None | NO |
| `POST /memories/list` | Added `origin` filter type (`{"by":"origin","origin":"cursor"}`) | Additive | NO |
| `POST /agent/memories/browse` | Added `origin` filter type | Additive | NO |
| `GET /agent/memories/latest` | Added `?origin=` query param for source-tool filtering | Additive | NO |
| `POST /query` (memory_filter) | Added `origin` filter type | Additive | NO |
| `GET /admin/*` | No change | None | NO |
| `GET /admin/audit` | New endpoint | Additive | NO |
| `GET /admin/audit/export` | New endpoint | Additive | NO |

### OAuth/MCP endpoints

| Endpoint | Behavior change | Impact | Regression? |
|----------|-----------------|--------|-------------|
| `/.well-known/oauth-*` | No change | None | NO |
| `/authorize` | No change | None | NO |
| `/token` | No change | None | NO |
| `/register` | No change | None | NO |
| `/mcp` | No change | None | NO |
| `/oauth/approve` | No change | None | NO |

---

## Auth Flow Compatibility

### Dashboard auth (service key + JWT)
- **Before:** Service key + X-Dashboard-Token JWT verified
- **After:** Identical. No changes to dashboard auth flow.
- **Verdict:** COMPATIBLE

### API key auth
- **Before:** Static `RM_API_KEY` or per-user DB keys (`rm_live_*`)
- **After:** Identical. SSO auth added as additional path; does not interfere.
- **Verdict:** COMPATIBLE

### Agent key auth
- **Before:** `RM_AGENT_KEY_*` with route restrictions
- **After:** Identical. No changes to agent key behavior.
- **Verdict:** COMPATIBLE

### OAuth 2.1 (MCP)
- **Before:** PKCE + code exchange → access token
- **After:** Identical. No changes to OAuth flow.
- **Verdict:** COMPATIBLE

### SSO auth (new)
- **Before:** Did not exist
- **After:** Optional OIDC bearer auth. Only activates when `RM_SSO_ENABLED=true` and token looks like JWT.
- **Impact:** No impact on existing auth paths. SSO is additive.
- **Verdict:** COMPATIBLE

---

## Intentional Behavior Changes in Self-Host Mode

These are **by design** and documented. They are NOT regressions:

1. **Model egress blocked:** `/query` and `/chat` return 503 when `RM_DISABLE_MODEL_EGRESS=true`
2. **Webhooks blocked:** Clerk and Stripe webhook routes return 404 when `RM_ALLOW_PUBLIC_WEBHOOKS=false`
3. **Model host validation:** Server refuses to start if model base URL points to a public host when `RM_REQUIRE_INTERNAL_MODEL_BASE_URL=true`
4. **Tenant marker enforcement:** Server aborts if `RM_TENANT_ID` does not match the `.tenant_id` marker file in the data directory

---

## Client Compatibility

| Client | Compatible? | Notes |
|--------|-------------|-------|
| Dashboard (React) | YES | Auth flow unchanged. Health response additive. |
| Cursor MCP connector | YES | OAuth/MCP paths unchanged. Legacy keys work. |
| ChatGPT Custom Actions | YES | Agent key auth unchanged. |
| Claude native connector | YES | OAuth 2.1 flow unchanged. |
| n8n webhook connector | YES | Agent key auth unchanged. |
| CLI tools (curl) | YES | All API contracts preserved. |

---

## Summary

**Zero regressions** in existing API contracts for hosted mode. Self-host mode introduces intentional restrictions that are security features, not bugs. All changes are additive or mode-gated.
