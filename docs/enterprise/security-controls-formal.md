# Reflect Memory — Enterprise Security Controls

**Version:** 1.0
**Date:** February 2026
**Classification:** Customer-facing

---

## 1. Authentication

### 1.1 API Key Authentication
- All API requests require a Bearer token in the `Authorization` header
- API keys are compared using timing-safe comparison (SHA-256 + `timingSafeEqual`) to prevent timing attacks
- Per-user API keys are stored as SHA-256 hashes in the database; plaintext keys are never persisted after issuance
- Failed authentication attempts are logged with client IP, path, and timestamp

### 1.2 Enterprise SSO (OIDC)
- Optional OIDC-based authentication via JWKS key verification
- Supports any OIDC-compliant identity provider (Okta, Azure AD, Google Workspace, Auth0, Keycloak)
- JWT signature, issuer (`iss`), and audience (`aud`) claims are validated on every request
- Email identity is extracted from a configurable claim and mapped to user accounts
- JWKS URL must use HTTPS in production environments
- SSO failures are logged as audit events

### 1.3 Dashboard Authentication
- Two-factor authentication: service key + signed JWT
- JWTs are verified with HMAC-SHA256, scoped to `audience: reflect-memory` and `issuer: reflect-dashboard`
- JWT expiration is enforced; expired tokens are rejected

### 1.4 OAuth 2.1 (MCP Connector)
- Full OAuth 2.1 with PKCE for third-party AI agent connectors
- Authorization codes are single-use and expire after 5 minutes
- Access tokens expire after 7 days; refresh tokens after 90 days
- Token revocation immediately invalidates the token
- Client registration generates unique client IDs and hashed secrets

---

## 2. Authorization

### 2.1 Role-Based Access
- **User role:** Full access to memory CRUD, query, and chat endpoints
- **Agent role:** Restricted to `/agent/*`, `/query`, `/whoami`, `/health`, and `/mcp` endpoints
- Route restrictions are enforced at the auth hook level before any handler executes

### 2.2 Vendor Isolation
- Each AI agent connector is identified by a vendor name
- Memories can be restricted to specific vendors via `allowed_vendors`
- Agents can only read memories they are authorized to access

### 2.3 Admin Access
- Admin endpoints (`/admin/*`) are restricted to the deployment owner
- Owner identity is determined by the `RM_OWNER_EMAIL` environment variable

---

## 3. Data Protection

### 3.1 Data Isolation
- **Single-tenant architecture:** Each enterprise deployment has its own process, database, and network
- **Volume isolation:** Dedicated storage volume per deployment prevents cross-tenant data access
- **Tenant marker:** A `.tenant_id` marker file prevents accidental volume sharing between deployments; the server aborts on mismatch

### 3.2 Encryption
- **In transit:** TLS termination at the reverse proxy layer (nginx, Caddy, or cloud load balancer). Application enforces HTTPS for external connections (JWKS, model endpoints).
- **At rest:** Delegated to the operator's infrastructure (disk-level encryption, e.g., LUKS, AWS EBS encryption, GCP CMEK). SQLite database files are standard files that benefit from filesystem-level encryption.

### 3.3 Model Egress Control
- `RM_DISABLE_MODEL_EGRESS` blocks all outbound requests to AI model providers
- `RM_REQUIRE_INTERNAL_MODEL_BASE_URL` rejects public model hosts at startup
- `RM_ALLOWED_MODEL_HOSTS` provides an explicit allowlist of permitted model endpoints
- In self-host mode, egress is disabled by default

### 3.4 Data Minimization
- Audit events strip query strings from paths
- No request bodies are logged
- Metadata in audit events contains only operational context (method, deployment mode)

---

## 4. Network Security

### 4.1 Network Boundary
- Self-host deployments operate on a private network by default
- Public webhook endpoints (Clerk, Stripe) are disabled in self-host mode
- Docker Compose provides isolated networks per deployment profile

### 4.2 Rate Limiting
- Global rate limit: 100 requests per minute per IP address
- Admin endpoints: 10 requests per minute per IP address
- Audit export: 5 requests per minute per IP address

### 4.3 Request Validation
- All request bodies are validated against JSON schemas before processing
- Request body size is limited to 256KB (API) and 256KB (MCP)
- CORS is configured with explicit origin allowlisting

---

## 5. Audit & Logging

### 5.1 Audit Events
- All authentication attempts (success and failure) are recorded
- All access to sensitive routes (memories, admin, OAuth, keys, webhooks) is logged
- Each audit event includes: user ID, event type, severity, auth method, vendor, path, status code, client IP, request ID, metadata, and timestamp
- Audit events are indexed for efficient querying by time, type, user, and request ID

### 5.2 Audit Retention
- Configurable retention period (default: 90 days)
- Automated daily pruning of events beyond the retention period
- Export endpoint for compliance archival before pruning

### 5.3 Audit Integrity
- Audit writes never block request processing (fail-open for availability)
- Events are append-only in the application layer
- Each event has a unique UUID and ISO 8601 timestamp for ordering

### 5.4 Audit Access
- Audit query and export endpoints require owner-level authentication
- Audit data is included in database backups automatically

---

## 6. Operational Security

### 6.1 Secret Management
- All secrets are environment variables (compatible with Docker, Kubernetes, and secret managers)
- Bootstrap script generates cryptographically random secrets using `openssl rand`
- Secrets are never logged or included in error responses
- `.env` files are `.gitignored` by default

### 6.2 Startup Validation
- Required environment variables are checked at startup; missing values cause immediate exit
- Self-host mode validates that model egress and webhook policies are correctly configured
- SSO configuration is validated for completeness
- Tenant ID marker is verified against the data directory

### 6.3 Security Warnings
- Startup logs include explicit warnings for risky configurations:
  - Model egress enabled in self-host mode
  - Public webhooks enabled in self-host mode
  - SSO JWKS URL using HTTP instead of HTTPS

### 6.4 Graceful Shutdown
- SIGTERM and SIGINT trigger graceful shutdown with a 10-second timeout
- Database is optimized and closed cleanly
- Active connections are drained before exit

---

## 7. Backup & Recovery

### 7.1 Automated Backups
- Daily automated backup at 06:00 UTC (when S3 is configured)
- Backup includes the complete SQLite database (all data, audit events, OAuth state)
- Backup status is logged

### 7.2 Manual Backup
- SQLite database can be copied while the service is running (SQLite WAL mode)
- File-level backup is deterministic and complete

### 7.3 Restore Procedure
- Replace the database file and restart the service
- Schema migrations automatically apply any missing migrations
- Documented in the operational runbook

---

## 8. Incident Response

### 8.1 Key Compromise
- Rotate the compromised key in the environment configuration
- Restart the service (new key takes effect immediately)
- Review audit events for unauthorized access during the exposure window
- For per-user DB keys: revoke via API without restart

### 8.2 Unauthorized Access
- Query audit events for the suspected time window
- Export audit data for forensic analysis
- Rotate all potentially compromised credentials
- Review and restrict network access if applicable

### 8.3 Data Breach
- Self-host mode ensures data never leaves the operator's network
- Model egress controls prevent data transmission to external AI providers
- Audit trail provides evidence of what data was accessed and by whom

---

## 9. Compliance Posture

### 9.1 SOC 2 Alignment
- Access control, audit logging, data isolation, and change management controls are implemented
- Formal SOC 2 Type II certification is a V2 milestone

### 9.2 GDPR Considerations
- Per-user data storage with deletion capability
- Audit events contain IP addresses under legitimate interest basis
- Self-host mode keeps all data within the operator's jurisdiction
- Data export capability planned for V2

### 9.3 HIPAA Considerations
- Self-host with model egress disabled prevents PHI transmission
- Encryption at rest is the operator's responsibility
- Business Associate Agreement (BAA) requires additional controls beyond V1 scope

---

## 10. Known Limitations (V1)

| Limitation | Impact | Mitigation | Timeline |
|------------|--------|------------|----------|
| SQLite single-writer | No horizontal write scaling | Sufficient for single-tenant workloads | V2 Postgres adapter |
| In-memory MCP sessions | Sessions lost on restart | MCP clients auto-reconnect per spec | V2 Redis store |
| No external audit sink | Audit data is local only | Export endpoint for archival | V2 SIEM integration |
| No formal pentest | No third-party validation | Code review + threat model completed | Pre-scale |
| Env-based secrets only | No zero-downtime rotation | Restart required for rotation | V2 Vault integration |

---

## Contact

For security questions or to report a vulnerability:
- Email: security@reflectmemory.com
- Response time: 24 hours for critical issues
