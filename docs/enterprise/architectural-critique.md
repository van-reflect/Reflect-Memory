# Architectural Critique — "What Is Wrong With This Approach?"

## Overview

This is an honest, adversarial review of the enterprise deployment architecture. Every risk, burden, and questionable decision is surfaced with mitigation options.

---

## Risk 1: SQLite as the Production Database

**The problem:** SQLite is a single-writer, file-based database. It does not support concurrent write connections, network-attached storage reliably, or streaming replication. Enterprise customers may expect Postgres-like characteristics.

**Why we chose it anyway:**
- Single-tenant-per-deployment means one writer is sufficient
- Zero-ops overhead: no DB server to maintain
- File-level backup/restore is simple and deterministic
- Performance is excellent for the expected workload (<10K memories per user)

**When this breaks:**
- If a customer needs multiple API instances behind a load balancer writing to the same DB
- If write throughput exceeds ~1000 writes/second sustained
- If customers need point-in-time recovery (PITR) rather than file snapshots

**Mitigation options:**
1. **V2 Postgres adapter:** Add a `StorageAdapter` interface and implement Postgres backend. Keep SQLite as default for self-host simplicity.
2. **SQLite Litestream replication:** Use Litestream for streaming replication to S3. Adds PITR without changing the database engine.
3. **Read replicas:** Not applicable to SQLite. If needed, migrate to Postgres.

**Verdict:** Acceptable for V1 single-tenant. Must be explicitly communicated to customers. Postgres path should be V2 priority.

---

## Risk 2: In-Memory MCP Session State

**The problem:** MCP sessions (`transports`, `sessionVendors`, `sessionLastSeen`) are stored in process memory. A restart loses all active sessions.

**Why we chose it anyway:**
- MCP spec requires clients to handle session loss (404 → re-initialize)
- Session state is ephemeral by design
- No distributed session store complexity

**When this breaks:**
- Rolling deployments cause all connected MCP clients to simultaneously re-initialize
- If a customer has 500 active sessions and restarts, all must reconnect

**Mitigation options:**
1. **Graceful drain:** Before restart, send close signal to all active transports. Clients reconnect orderly.
2. **Redis session store (V2):** For multi-instance deployments, store session references in Redis.
3. **Sticky sessions:** Use load balancer session affinity to route clients to the same instance.

**Verdict:** Acceptable for single-instance deployment. Document the reconnect behavior.

---

## Risk 3: Env-Based Secret Management

**The problem:** All secrets (`RM_API_KEY`, `RM_DASHBOARD_SERVICE_KEY`, `RM_DASHBOARD_JWT_SECRET`, agent keys) are environment variables. There is no secret versioning, rotation logging, or zero-downtime rotation.

**Why we chose it anyway:**
- Universal compatibility (Docker, Kubernetes, bare metal)
- No dependency on external secret managers
- Simple mental model for operators

**When this breaks:**
- Key rotation requires a restart (brief downtime)
- No audit trail of when secrets were rotated
- If `.env` file is committed to version control, all secrets are leaked

**Mitigation options:**
1. **Vault integration (V2):** Add HashiCorp Vault or AWS Secrets Manager adapter. Secrets fetched at startup + periodic refresh.
2. **Secret rotation API:** Add an admin endpoint to rotate keys without restart. Old keys rejected immediately, new key active.
3. **.env.enterprise is .gitignored:** Already implemented. Bootstrap script generates random secrets.

**Verdict:** Acceptable for V1 with documented rotation procedure. Vault integration is V2.

---

## Risk 4: Single-Process Architecture

**The problem:** The API server, MCP server, background tasks (backup, audit pruning), and database all run in a single Node.js process.

**Why we chose it anyway:**
- Simplicity of deployment (one container = one process)
- SQLite requires single-process access
- Minimal operational overhead

**When this breaks:**
- CPU-intensive query routes block the event loop for all other requests
- A crash in the backup routine could take down the API
- No horizontal scaling without architectural change

**Mitigation options:**
1. **Worker threads:** Offload CPU-heavy operations (embedding queries, AI responses) to worker threads.
2. **Process separation:** Run MCP on a separate process (already on separate port). Move backup to a cron job.
3. **Horizontal scaling (V2):** Requires Postgres migration for shared state.

**Verdict:** Acceptable for V1 workloads. Monitor event loop lag in production. Add `--max-old-space-size` flag to container.

---

## Risk 5: No Formal Penetration Testing

**The problem:** The security controls have been reviewed by automated analysis and manual code review, but no external penetration test has been conducted.

**Impact:** Enterprise customers with formal security review processes may require a pentest report.

**Mitigation options:**
1. **External pentest:** Engage a third-party firm before first enterprise deployment.
2. **Bug bounty:** Set up a responsible disclosure program.
3. **Self-assessment:** Use OWASP ASVS checklist for self-evaluation.

**Verdict:** GO for initial pilot with security-conscious customer communication. Pentest recommended before scaling to multiple enterprise customers.

---

## Risk 6: OAuth Client Registration is Open

**The problem:** The `/register` endpoint accepts any client registration without authentication. This is per the MCP spec but means anyone who can reach the API can register an OAuth client.

**When this breaks:**
- Attacker registers a malicious client and tries to phish the user into authorizing it
- Client table fills up with spam registrations

**Mitigation options:**
1. **Rate limiting:** Already applied (global rate limiter covers `/register`)
2. **Admin approval flow:** Require admin to approve new client registrations before they can authorize
3. **Allowlist:** Only allow pre-registered client IDs

**Verdict:** Acceptable for V1 because authorization requires user consent through the dashboard. Add client registration audit events.

---

## Risk 7: Operational Burden Per Customer

**The problem:** Each enterprise customer requires their own deployment (container, volume, secrets, monitoring). This is a linear scaling cost.

**Overhead per customer:**
- ~256MB RAM per container
- ~100MB disk baseline
- Secret generation and distribution
- Monitoring/alerting setup
- Upgrade coordination

**When this breaks:**
- At >20 enterprise customers, manual management becomes unsustainable
- Each customer on a different version creates compatibility matrix complexity

**Mitigation options:**
1. **Fleet management tooling:** Build a control plane that automates provisioning, monitoring, and upgrades.
2. **Multi-tenant mode (V2):** Row-level tenant isolation with shared infrastructure. Higher complexity but lower per-customer cost.
3. **Kubernetes operator:** Automate deployment lifecycle via CRDs.

**Verdict:** Acceptable for initial 1-5 enterprise pilots. Fleet tooling required before scaling beyond 10 customers.

---

## Risk 8: No Rate Limiting Per Auth Method

**The problem:** Rate limiting is applied globally (100 requests/minute per IP) but not differentiated by auth method. An attacker can burn through the rate limit trying invalid API keys, blocking legitimate requests from the same IP.

**Mitigation options:**
1. **Auth-failure-specific rate limit:** Track failed auth attempts per IP separately. Lock out after 10 failures in 5 minutes.
2. **Separate limits:** Different rate limits for authenticated vs. unauthenticated requests.

**Verdict:** Should be addressed in V1.1. Not a blocker for initial pilot with known customers.

---

## Summary

| Risk | Severity | Blocker? | Timeline to address |
|------|----------|----------|---------------------|
| SQLite limits | Medium | No (single-tenant) | V2 Postgres adapter |
| In-memory sessions | Low | No | V2 Redis store |
| Env secrets | Low | No | V2 Vault integration |
| Single process | Medium | No | V1.1 worker threads |
| No pentest | Medium | No (pilot OK) | Before scaling |
| Open OAuth registration | Low | No | V1.1 audit + admin approval |
| Operational burden | Medium | No (for <5 customers) | V2 fleet tooling |
| Auth rate limiting | Low-Medium | No | V1.1 |

**Overall verdict:** The architecture is sound for its intended scope (single-tenant enterprise pilot). The risks are real but manageable with the documented mitigations. None are blockers for an initial deployment with a security-conscious customer.
