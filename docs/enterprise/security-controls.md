# Security Controls (V1 Starter)

## Authentication controls

- API key bearer auth (`RM_API_KEY`)
- Per-user API keys (database-backed)
- Dashboard service key + signed token path
- Optional enterprise SSO bearer token verification (JWKS/issuer/audience)

## Authorization controls

- Agent keys restricted to agent-safe routes
- Owner/admin-gated admin endpoints
- Deployment-mode policy controls for webhook exposure and model egress

## Data controls

- Per-deployment DB path and volume isolation
- Append-only migration history in `_migrations`
- Audit event table for security and sensitive-path actions

## Network controls

- Self-host profile defaults to private boundary assumptions
- Optional model host allowlist (`RM_ALLOWED_MODEL_HOSTS`)
- Helm NetworkPolicy scaffold included for further tightening

## Recoverability controls

- Scheduled S3-compatible backups supported
- Runbook includes backup/restore verification checklist

## Operational controls

- Environment validation script blocks unsafe baseline config
- Smoke test script validates health, write, and read paths
- Founder gate checklist defines pass/fail release criteria
