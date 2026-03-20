# Policy Decisions — Enterprise V1

## 1. Auditability Requirements

### Decision: Full audit trail for all security-sensitive operations

**Scope:** Every authentication attempt (success and failure), token issuance/revocation, webhook receipt, admin operation, and sensitive data access is logged to the `audit_events` table.

**Retention policy:**
- Default: 90 days for enterprise deployments
- Configurable via `RM_AUDIT_RETENTION_DAYS` environment variable
- Pruning runs daily (automated via the audit service)
- Export capability via `/admin/audit/export` endpoint for compliance archival

**Tamper mitigation:**
- Audit events are append-only in application layer
- Sequential UUID + ISO timestamp provides ordering evidence
- For V2: consider external syslog/SIEM sink for independent tamper proof

### What this means for operators:
- Audit logs accumulate on disk. Plan storage accordingly (~1KB per event).
- Export regularly if compliance requires offsite retention.
- Access to audit data requires admin-level API key.

---

## 2. IAM / SSO / SAML Approach

### Decision: OIDC/JWKS as primary, SAML-to-OIDC bridge documented

**Why OIDC, not native SAML:**
- OIDC is the modern standard; all major IdPs (Okta, Azure AD, Google Workspace, Auth0) support it
- SAML adds XML parsing complexity and a larger attack surface (signature wrapping, XML entity attacks)
- Enterprise customers on SAML-only IdPs can use a SAML-to-OIDC bridge (e.g., Okta, Dex, Keycloak)

**V1 implementation:**
- Bearer token verified via JWKS endpoint
- Issuer and audience claims validated
- Email claim extracted and mapped to user identity
- `findOrCreateUserByEmail` for just-in-time provisioning

**V2 roadmap (not V1 scope):**
- SCIM provisioning for user lifecycle management
- Group/role claim mapping for RBAC
- Session management with IdP logout signals

### What this means for operators:
- Configure `RM_SSO_JWKS_URL`, `RM_SSO_ISSUER`, `RM_SSO_AUDIENCE` to point at your IdP
- Ensure `email` claim (or configured `RM_SSO_EMAIL_CLAIM`) is present in tokens
- SAML-only shops: deploy a SAML-to-OIDC bridge (Keycloak or Dex recommended)

---

## 3. Compliance Posture

### SOC 2 Type II readiness (target, not certified V1)

**Controls implemented:**
- Access control: API key auth, SSO, agent route restrictions
- Audit logging: all sensitive operations recorded
- Data isolation: per-deployment volume separation
- Encryption at rest: delegated to operator (disk-level encryption)
- Encryption in transit: TLS termination at reverse proxy (documented requirement)
- Change management: schema migrations are versioned and transactional

**Controls NOT yet implemented (V2):**
- Formal access review process
- Automated vulnerability scanning
- Penetration test report
- Business continuity / disaster recovery testing
- Formal incident response plan

### GDPR considerations:
- Memory data is stored per-user and can be deleted via existing API
- Audit events contain IP addresses (legitimate interest basis)
- Data export capability planned for V2
- No cross-border transfer in self-host mode (data stays in operator's infrastructure)

### HIPAA considerations:
- Self-host mode with model egress disabled prevents PHI from leaving the network
- SQLite encryption at rest is operator responsibility
- BAA would require additional controls not in V1 scope

---

## 4. Network Policy Defaults

### Decision: Deny-by-default for self-host, allow-by-default for hosted

| Policy | Hosted | Isolated-hosted | Self-host |
|--------|--------|-----------------|-----------|
| Public webhooks | Allowed | Allowed | Blocked |
| Model egress | Enabled | Enabled | Disabled |
| Public model hosts | Allowed | Allowed | Rejected at boot |
| SSO | Optional | Optional | Recommended |

**Rationale:** Self-host customers chose that mode specifically for data control. The default must be maximally restrictive. Any relaxation must be explicit and logged.

---

## 5. Key Management

### Decision: Env-driven keys with rotation-by-restart

**V1 approach:**
- All secrets are environment variables
- Rotation requires restart (acceptable for enterprise single-tenant deployments)
- Per-user DB keys (`rm_live_*`) can be rotated without restart

**V2 roadmap:**
- Vault integration (HashiCorp Vault, AWS Secrets Manager)
- Automatic key rotation schedules
- Key usage auditing (which key was used for which request)

---

## 6. Webhook Security

### Decision: Signature verification required, route blocked in self-host

**V1:**
- Clerk webhooks verified by Svix signature
- Stripe webhooks verified by Stripe SDK signature check
- Both routes return 404 when `RM_ALLOW_PUBLIC_WEBHOOKS=false`

**What this means:** Self-host deployments do not process Clerk or Stripe events. If an enterprise customer needs billing integration, they must explicitly enable public webhooks and configure webhook secrets.

---

## 7. Data Residency

### Decision: Operator-controlled, no application-level enforcement

**V1:** Data lives wherever the SQLite file is stored. In self-host mode, this is entirely within the operator's infrastructure. The application does not phone home or transmit telemetry.

**V2:** Add a startup configuration check that can verify the deployment region matches expectations (advisory, not enforced).
