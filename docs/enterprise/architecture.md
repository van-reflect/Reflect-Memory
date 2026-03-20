# Enterprise Deployment Architecture (V1 Scaffold)

This document defines the deploy skeleton for enterprise privacy-first installs while keeping hosted compatibility.

## Deployment modes

- `hosted` (default): existing shared hosted behavior.
- `isolated-hosted`: dedicated runtime/DB per enterprise tenant in managed infrastructure.
- `self-host`: customer network (VPC/on-prem) with private boundary defaults.

## Runtime boundaries

- API runtime entry: `src/server.ts`
- Bootstrap + migrations: `src/index.ts`
- OAuth/MCP auth storage: `src/oauth-store.ts`
- Audit event storage: `src/audit-service.ts`
- Deployment mode policy: `src/deployment-config.ts`

## Isolation model

- **Process isolation**: one API process per enterprise customer deployment.
- **Data isolation**: one SQLite volume/database file per deployment.
- **Secret isolation**: per-tenant `RM_API_KEY`, `RM_AGENT_KEY_*`, JWT secrets, webhook secrets.
- **Network isolation**:
  - hosted/isolated-hosted: public ingress with auth controls.
  - self-host: private boundary, optional model egress disable, optional internal model endpoint requirement.

## Auth paths

- API key auth: static `RM_API_KEY` and per-user keys.
- Dashboard service auth: `RM_DASHBOARD_SERVICE_KEY` + signed `X-Dashboard-Token`.
- Agent auth: per-vendor `RM_AGENT_KEY_*`.
- Optional enterprise SSO bearer auth:
  - enabled via `RM_SSO_ENABLED=true`
  - JWKS validation via `RM_SSO_JWKS_URL`, issuer/audience checks.

## Security defaults

- Self-host defaults:
  - `RM_DISABLE_MODEL_EGRESS=true` unless explicitly overridden.
  - `RM_REQUIRE_INTERNAL_MODEL_BASE_URL=true` unless explicitly overridden.
  - public webhook bypass disabled unless `RM_ALLOW_PUBLIC_WEBHOOKS=true`.
- Audit events are written for:
  - auth/security failures
  - sensitive endpoint access

## Upgrade and migration model

- Schema evolution is append-only via `_migrations`.
- Bootstrap runs migrations at start and logs each applied migration.
- Enterprise migration hooks include audit schema creation.

## Memory filtering

All filter types are available across all deployment modes (hosted, isolated-hosted, self-host):

- `all` — all memories
- `tags` — filter by tag array
- `ids` — filter by memory UUID array
- `search` — full-text search on title/content
- `origin` — filter by source tool (cursor, chatgpt, claude, user, dashboard, or any configured vendor)
- `trashed` — soft-deleted memories

The `origin` filter is available on:
- `POST /memories/list` and `POST /agent/memories/browse` via `filter: {"by":"origin","origin":"<tool>"}`
- `GET /agent/memories/latest` via `?origin=<tool>` query parameter
- `POST /query` via `memory_filter: {"by":"origin","origin":"<tool>"}`

This enables enterprise customers to trace memory provenance across their AI tool stack.

## Compatibility guardrails

- Existing hosted routes remain stable:
  - `/health`, `/mcp`, `/agent/*`
  - dashboard auth path behavior
- Deployment-specific restrictions are policy-driven and env-controlled, not branch-based.
- All filter types (including `origin`) are additive and backward-compatible.
