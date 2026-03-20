# Enterprise Security Hardening Review (Scaffold Pass)

This document records the first hardening pass and what remains for a full production security sign-off.

## Threat model focus

- Unauthorized access to tenant data.
- Cross-tenant data leakage.
- Weak auth boundary (service key misuse, JWT misuse, stale credentials).
- Unrestricted network egress from private deployments.
- Missing audit trail for sensitive actions.

## Hardening implemented

- Added deployment policy abstraction (`src/deployment-config.ts`):
  - mode-based defaults for private deployments
  - model egress policy toggles
  - webhook bypass controls
- Added optional OIDC/JWKS bearer validation for enterprise SSO (`src/sso-auth.ts`).
- Added audit event pipeline (`src/audit-service.ts`) + migration.
- Added security event auditing for auth failures and sensitive routes (`src/server.ts`).
- Added runtime policy enforcement:
  - model egress policy blocks `/query` and `/chat` when disabled
  - optional internal-model-base requirement
- Added private-deploy bootstrap/validation/smoke scripts.

## Failure path review

- **Secret rotation**: keys can rotate by updating env and restarting service.
- **Partial migrations**: migration hook wrapper uses a transaction and `_migrations` marker.
- **Backup failures**: existing backup path logs and throws; runbook includes restore check.
- **OAuth/MCP session churn**: MCP auth proxying remains path-based and backward compatible.
- **Invalid SSO token**: rejected and falls back to other auth methods.

## Known limitations (must be addressed for strict enterprise sign-off)

- Network policy in Helm is still scaffold-level permissive egress.
- No full SAML assertion flow yet (OIDC/JWT path only).
- Audit event retention/streaming policy not yet externalized.
- Automated chaos/fault-injection tests are not yet included.

## "What is wrong with this approach?" critique

- SQLite per-tenant is fast to ship, but large enterprise scale may need managed Postgres and stronger backup SLAs.
- Env-driven toggles are flexible, but high-risk toggles should eventually be centrally policy-managed.
- Mixed auth paths (legacy keys + dashboard + SSO) are practical for compatibility but increase attack surface and operational complexity.

## Recommendation

Treat this as a secure starter, not final enterprise-grade completion. Use the next hardening pass for strict egress policy, external audit pipeline integration, and IAM expansion.
