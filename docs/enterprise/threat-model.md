# Threat Model & Security Review — Enterprise V1

## Scope

All authentication boundaries, token handling, webhook verification, and tenant isolation assumptions in:
- `src/server.ts` (Fastify auth hook, quota, metering, sensitive-route audit)
- `src/mcp-server.ts` (hybrid OAuth/legacy auth, session management)
- `src/oauth-store.ts` (client registration, code exchange, token lifecycle, revocation)
- `src/sso-auth.ts` (JWKS-based enterprise SSO)
- `src/audit-service.ts` (audit event pipeline)
- `src/deployment-config.ts` (mode toggles, policy enforcement)

---

## Auth Boundary Map

```
Internet
  │
  ├─► /health, /openapi.json              → public, no auth
  ├─► /waitlist, /early-access,
  │   /integration-requests (POST)         → public, no auth
  ├─► /webhooks/clerk, /webhooks/stripe    → public only if allowPublicWebhooks=true
  │                                          (disabled by default in self-host)
  ├─► /.well-known/oauth-*, /authorize,
  │   /token, /register, /mcp*            → proxied to MCP server; MCP's own auth
  │
  └─► all other routes                    → Fastify onRequest auth hook
        ├─ Dashboard service key + JWT     → findOrCreateUserByEmail
        ├─ SSO bearer (if enabled)         → JWKS verify → findOrCreateUserByEmail
        ├─ Static RM_API_KEY               → owner userId
        ├─ Per-vendor RM_AGENT_KEY_*       → owner userId, agent role, route-restricted
        ├─ DB-stored per-user key          → authenticateApiKey lookup
        └─ none match                      → 401
```

---

## Threat Analysis

### T1: Unauthorized data access via leaked API key

**Risk:** HIGH — static `RM_API_KEY` grants full owner access. If leaked, attacker has complete read/write.

**Current mitigations:**
- Timing-safe comparison (SHA-256 + `timingSafeEqual`)
- Audit logging on all auth failures
- Per-user DB keys (`rm_live_*`) support key rotation without changing env

**Residual risk:** No automatic key expiry on static keys. No rate limit on auth failures specifically (global 100/min applies).

**Recommendation:** Add per-IP auth-failure rate limiting (separate from global). Document key rotation procedure in ops runbook.

---

### T2: Cross-tenant data leakage

**Risk:** CRITICAL in multi-tenant; LOW in current single-tenant-per-deployment model.

**Current mitigations:**
- Process isolation: one API process per deployment
- Data isolation: separate SQLite volume per deployment
- No shared DB path or shared keys between tenants
- `RM_TENANT_ID` is recorded but not used as a query filter (unnecessary when DB is isolated)

**Residual risk:** If someone misconfigures two deployments pointing at the same volume, isolation breaks silently.

**Recommendation:** Add startup check: if `RM_TENANT_ID` is set, write it to a `.tenant_id` marker file in the data directory. On subsequent starts, verify the marker matches. Abort if mismatch.

---

### T3: OAuth token theft or replay

**Risk:** MEDIUM — OAuth access tokens are opaque random strings stored in SQLite.

**Current mitigations:**
- Access tokens expire after 7 days
- Refresh tokens expire after 90 days
- Authorization codes expire after 5 minutes and are single-use (deleted after exchange)
- PKCE challenge is stored and verified by MCP SDK
- Token revocation deletes the token row

**Residual risk:**
- Tokens are not bound to client IP or user-agent
- Revoked tokens are deleted (not soft-deleted), losing audit trail of revocation
- `client_secret` is stored in plaintext alongside `client_secret_hash`

**Recommendation:**
- Remove plaintext `client_secret` from `oauth_clients` table after registration response
- Soft-delete revoked tokens with a `revoked_at` timestamp for audit trail
- Consider shorter access token lifetime for enterprise (1 hour instead of 7 days)

---

### T4: Webhook forgery (Clerk/Stripe)

**Risk:** MEDIUM — webhooks from Clerk and Stripe are verified by signature.

**Current mitigations:**
- Clerk webhooks verified by Svix signature library
- Stripe webhooks verified by `constructStripeEvent` signature check
- In self-host mode, webhook routes are blocked entirely unless `RM_ALLOW_PUBLIC_WEBHOOKS=true`

**Residual risk:** If webhook secrets are weak or leaked, forged webhooks could create/modify users or billing state.

**Recommendation:** Document webhook secret rotation procedure. Consider webhook IP allowlisting for enterprise.

---

### T5: MCP session hijacking

**Risk:** LOW-MEDIUM — MCP sessions are identified by `mcp-session-id` header (random UUID).

**Current mitigations:**
- Session IDs are random UUIDs (cryptographically strong)
- Sessions expire after 30 minutes of inactivity
- Max 500 concurrent sessions
- Bearer auth middleware runs on every `/mcp` request

**Residual risk:**
- Session ID format/length is not validated on incoming requests
- Vendor identity is bound at session creation and not re-verified on subsequent requests (if token is rotated mid-session, old vendor binding persists)

**Recommendation:** Add session ID format validation (reject non-UUID values). Log session creation/destruction as audit events.

---

### T6: SSO token abuse

**Risk:** LOW (feature is opt-in and disabled by default)

**Current mitigations:**
- JWKS key set fetched from configured URL (not hardcoded)
- Issuer and audience claims are verified
- SSO failures fall through to other auth methods (no information leakage)
- SSO is only attempted when token looks like a JWT (contains dots)

**Residual risk:**
- JWKS URL is trusted implicitly; if DNS is compromised, attacker could serve malicious keys
- No `nbf` (not-before) or `jti` (JWT ID) replay protection

**Recommendation:** Document that SSO JWKS URL must use HTTPS in production. Consider adding `jti` tracking for replay detection in hardening phase.

---

### T7: Dashboard service key as single point of failure

**Risk:** MEDIUM — `RM_DASHBOARD_SERVICE_KEY` authenticates all dashboard requests. Compromise grants access to all user accounts via `findOrCreateUserByEmail`.

**Current mitigations:**
- Service key alone is insufficient; requires valid signed `X-Dashboard-Token` JWT
- JWT is verified with `RM_DASHBOARD_JWT_SECRET`, checked for audience/issuer
- JWT must contain a valid email claim

**Residual risk:** If both service key and JWT secret are compromised, attacker can impersonate any user by crafting JWTs with arbitrary email addresses.

**Recommendation:** Rotate both secrets on any suspected compromise. Consider binding dashboard JWTs to session fingerprint (IP or user-agent hash).

---

### T8: Model egress data exfiltration

**Risk:** HIGH for enterprise privacy; MITIGATED in self-host mode.

**Current mitigations:**
- `RM_DISABLE_MODEL_EGRESS=true` blocks `/query` and `/chat` with 503
- `RM_REQUIRE_INTERNAL_MODEL_BASE_URL=true` rejects public model hosts at boot
- `RM_ALLOWED_MODEL_HOSTS` provides explicit allowlist

**Residual risk:** If an operator sets `RM_DISABLE_MODEL_EGRESS=false` without understanding the implication, data could leave the network.

**Recommendation:** Log a prominent warning at startup when egress is enabled in self-host mode.

---

### T9: Audit event integrity

**Risk:** LOW — audit events are append-only in SQLite.

**Current mitigations:**
- Audit writes never block request processing (wrapped in try/catch)
- Events include IP, path, auth method, status code, request ID, and metadata
- Indexed by created_at, event_type, user_id, and request_id

**Residual risk:**
- No tamper detection on audit table (attacker with DB access could delete rows)
- No external sink; all events are local to the SQLite file
- No retention policy; table grows unbounded

**Recommendation:** Add audit event export capability. Consider write-ahead log or external sink for tamper evidence. Add retention/pruning policy.

---

## Summary Matrix

| Threat | Severity | Status | Mitigated | Residual |
|--------|----------|--------|-----------|----------|
| T1: Key leak | HIGH | Partially mitigated | Timing-safe, audit | No expiry, no auth-failure rate limit |
| T2: Cross-tenant | CRITICAL | Mitigated by design | Process + volume isolation | Misconfiguration risk |
| T3: OAuth replay | MEDIUM | Mostly mitigated | Expiry, single-use codes, PKCE | No IP binding, plaintext secret |
| T4: Webhook forgery | MEDIUM | Mitigated | Signature verification, self-host block | Secret rotation procedure needed |
| T5: Session hijack | LOW-MEDIUM | Mostly mitigated | Random UUID, TTL, bearer auth | No format validation |
| T6: SSO abuse | LOW | Mitigated | JWKS verify, issuer/audience | DNS trust, no replay detection |
| T7: Dashboard key | MEDIUM | Mitigated | Dual-factor (key + JWT) | Both-compromised scenario |
| T8: Egress exfil | HIGH | Mitigated in self-host | Policy block, host allowlist | Operator misconfiguration |
| T9: Audit integrity | LOW | Partially mitigated | Append-only, indexed | No tamper detection, no export |
