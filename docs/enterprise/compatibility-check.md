# Upstream/Downstream Compatibility Check

This captures expected compatibility across the existing stack after enterprise scaffolding.

## Upstream compatibility (dashboard and connectors)

- Dashboard auth flow remains unchanged:
  - service key + `X-Dashboard-Token` JWT path still supported
- Existing API key behavior remains unchanged.
- MCP/OAuth proxy paths remain pass-through:
  - `/.well-known/oauth-*`
  - `/authorize`, `/token`, `/register`
  - `/mcp*`

## Downstream compatibility (clients and contracts)

- Public health endpoint remains available at `/health`.
- OpenAPI export remains available at `/openapi.json`.
- Existing memory CRUD and agent routes are preserved.
- Deployment mode only adds policy constraints; no contract-breaking route renames.

## Security behavior changes (intentional)

- In `self-host` mode, model egress may be blocked by policy.
- In `self-host` mode, webhook public bypass is disabled by default.
- Optional SSO bearer validation is additive and does not remove existing auth paths.

## Verification command

```bash
export RM_COMPAT_BASE_URL=http://127.0.0.1:3000
export RM_COMPAT_API_KEY="<api key>"
npm run compat:check
```

Expected:

- health check passes
- openapi check passes
- authenticated checks pass when API key is supplied
