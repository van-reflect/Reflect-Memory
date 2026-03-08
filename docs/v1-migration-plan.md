# Reflect Memory v1 -- Migration Plan

## Current State (Pre-v1)

- **Database:** SQLite via `better-sqlite3`, single file at `/data/reflect-memory.db`
- **Tables:** `users` (id, email, created_at), `memories`, `waitlist`, `early_access_requests`, `_migrations`
- **Auth:** Env-var API keys (`RM_API_KEY`, `RM_AGENT_KEY_*`), magic-link email for dashboard
- **User model:** Single owner via `RM_OWNER_EMAIL`; dashboard users created on first sign-in

## v1 Schema Changes

### Migrations Applied Automatically on Deploy

| Migration | Name | Changes |
|-----------|------|---------|
| 005 | `005_v1_users_columns` | Add `clerk_id`, `role`, `stripe_customer_id`, `plan`, `updated_at` to users |
| 006 | `006_v1_api_keys` | Create `api_keys` table |
| 007 | `007_v1_usage_tables` | Create `usage_events` and `monthly_usage` tables |

### Column Details

**users (enhanced)**
- `clerk_id TEXT UNIQUE` -- Clerk user ID, populated when Clerk is integrated
- `role TEXT NOT NULL DEFAULT 'user'` -- `'admin'`, `'private-alpha'`, or `'user'`
- `stripe_customer_id TEXT UNIQUE` -- Stripe customer ID, populated on subscription
- `plan TEXT NOT NULL DEFAULT 'free'` -- `'free'` or `'builder'`
- `updated_at TEXT NOT NULL` -- backfilled from `created_at` for existing rows

### Backward Compatibility

- Existing env-var auth (`RM_API_KEY`, `RM_AGENT_KEY_*`) continues working
- Magic-link auth continues working until Clerk is fully integrated
- `RM_OWNER_EMAIL` still used for owner resolution during transition
- New tables are created empty and don't affect existing flows

## SQLite to Postgres Migration (Phase 5)

### When to Migrate

Migrate when approaching ~1,000 active users or before Public Beta launch.

### Migration Steps

1. Provision Postgres on Railway (or Supabase/Neon)
2. Set `DATABASE_URL` env var
3. Initialize Postgres schema: `psql $DATABASE_URL < schema-postgres.sql`
4. Run migration script: `RM_DB_PATH=/data/reflect-memory.db DATABASE_URL=... npx tsx scripts/migrate-to-postgres.ts`
5. Verify row counts match
6. Switch backend from `better-sqlite3` to `pg` driver (or adopt Drizzle ORM)
7. Update `RM_DB_PATH` → `DATABASE_URL` in Railway env vars
8. Redeploy and verify

### What the Postgres Schema Adds

- `TIMESTAMPTZ` instead of `TEXT` for all timestamps
- `JSONB` instead of `TEXT` for `tags` and `allowed_vendors` (with GIN index)
- `tsvector` FTS column on `memories(title, content)` with GIN index
- `usage_events` partitioned by month (12 partitions auto-created)
- UUID primary keys with `uuid_generate_v4()` defaults
