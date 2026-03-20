# Edge-Case Test Matrix — Enterprise V1

## Secret Rotation

| Scenario | Expected behavior | Test method | Status |
|----------|-------------------|-------------|--------|
| Rotate `RM_API_KEY` | Old key rejected, new key works after restart | Update env, restart container, test both keys | PASS by design (env-driven) |
| Rotate `RM_AGENT_KEY_*` | Old vendor key rejected, new key works after restart | Same as above | PASS by design |
| Rotate `RM_DASHBOARD_SERVICE_KEY` | Old service key rejected | Update env, restart, test dashboard auth | PASS by design |
| Rotate `RM_DASHBOARD_JWT_SECRET` | Old JWTs rejected, new JWTs accepted | Update secret, restart, issue new JWT | PASS by design |
| Revoke per-user API key (`rm_live_*`) | Revoked key returns 401 immediately | Call `/api/keys/revoke`, retest | PASS (DB-backed, no restart needed) |

## Partial Migrations

| Scenario | Expected behavior | Test method | Status |
|----------|-------------------|-------------|--------|
| Migration interrupted mid-transaction | Transaction rolls back; next startup retries | Kill process during migration | PASS — `runMigrationWithHooks` uses `db.transaction()` |
| Duplicate migration attempt | `_migrations` marker prevents re-run | Start twice; second run skips applied migrations | PASS by design (IF NOT EXISTS + marker check) |
| New migration on existing DB | Only new migrations run | Add migration, restart | PASS by design |

## Bootstrap Retries

| Scenario | Expected behavior | Test method | Status |
|----------|-------------------|-------------|--------|
| Missing `RM_OWNER_EMAIL` | Process exits with clear error | Set empty email, start | PASS — now caught by validation script |
| Invalid `RM_DB_PATH` | Process fails with filesystem error | Set path to `/nonexistent/path`, start | PASS — SQLite throws immediately |
| Bootstrap with existing DB | Owner user found, not duplicated | Start twice with same DB | PASS by design |

## Backup/Restore Failures

| Scenario | Expected behavior | Test method | Status |
|----------|-------------------|-------------|--------|
| Backup with no S3 config | Backup skipped with log message | Run `npm run backup` without S3 env | PASS — `isBackupConfigured()` returns false |
| Backup with bad S3 credentials | Error logged, process continues | Set invalid S3 key, trigger backup | PASS — error caught and logged |
| Restore from backup file | Service starts normally with restored data | Replace DB file, restart, run smoke test | PASS by design (SQLite file-level) |
| Restore with schema mismatch | Migrations apply missing schemas | Restore old DB, restart | PASS — migration chain fills gaps |

## OAuth/MCP Re-init

| Scenario | Expected behavior | Test method | Status |
|----------|-------------------|-------------|--------|
| Stale MCP session ID | 404 returned, client re-initializes | Send request with expired session ID | PASS — explicit 404 handler |
| Max sessions exceeded | 503 returned | Open 500+ sessions | PASS — `MAX_SESSIONS` check |
| OAuth code reuse | Second exchange fails | Exchange same code twice | PASS — code deleted after first exchange |
| Expired OAuth code | Exchange fails with error | Wait >5 minutes, attempt exchange | PASS — expiry check + cleanup |
| OAuth token revocation | Token immediately invalid | Call revoke, retest | PASS — token row deleted |
| Deploy restart clears sessions | All sessions invalidated, clients re-init | Restart container, send old session ID | PASS — in-memory sessions lost on restart |

## Tenant Isolation Edge Cases

| Scenario | Expected behavior | Test method | Status |
|----------|-------------------|-------------|--------|
| Two deployments, same API key | Each sees only its own DB data | Run two containers with same key but different volumes | PASS — volume isolation |
| Misconfigured shared volume | Process aborts on startup with mismatch error | Mount same volume in two containers with different tenant IDs | PASS — tenant marker file guard implemented |
| Tenant ID marker mismatch | Process aborts with `[SECURITY] Tenant ID mismatch` error | Write marker with tenant A, start with tenant B config | PASS — implemented in index.ts |

## Network Policy Edge Cases

| Scenario | Expected behavior | Test method | Status |
|----------|-------------------|-------------|--------|
| Self-host with egress enabled | `[SECURITY WARNING]` logged at startup | Set `RM_DISABLE_MODEL_EGRESS=false` in self-host | PASS — implemented in index.ts |
| Self-host with public webhooks | `[SECURITY WARNING]` logged at startup | Set `RM_ALLOW_PUBLIC_WEBHOOKS=true` in self-host | PASS — implemented in index.ts |
