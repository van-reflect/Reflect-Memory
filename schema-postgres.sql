-- Reflect Memory v1 -- Postgres Schema
-- Run this to initialize a fresh Postgres database.
-- For migration from SQLite, use scripts/migrate-to-postgres.ts

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- USERS
-- =============================================================================

CREATE TABLE users (
    id                  UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
    clerk_id            TEXT UNIQUE,
    email               TEXT NOT NULL UNIQUE,
    role                TEXT NOT NULL DEFAULT 'user'
                        CHECK (role IN ('admin', 'private-alpha', 'user')),
    stripe_customer_id  TEXT UNIQUE,
    plan                TEXT NOT NULL DEFAULT 'free'
                        CHECK (plan IN ('free', 'builder', 'pro', 'team', 'admin')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_clerk_id ON users(clerk_id) WHERE clerk_id IS NOT NULL;

-- =============================================================================
-- API_KEYS
-- =============================================================================

CREATE TABLE api_keys (
    id              UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash        TEXT NOT NULL UNIQUE,
    key_prefix      TEXT NOT NULL,
    label           TEXT NOT NULL DEFAULT 'Default',
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at      TIMESTAMPTZ
);

CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_api_keys_active ON api_keys(key_hash) WHERE revoked_at IS NULL;

-- =============================================================================
-- MEMORIES
-- =============================================================================

CREATE TABLE memories (
    id              UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,
    tags            JSONB NOT NULL DEFAULT '[]'::jsonb,
    origin          TEXT NOT NULL DEFAULT 'user',
    allowed_vendors JSONB NOT NULL DEFAULT '["*"]'::jsonb,
    memory_type     TEXT NOT NULL DEFAULT 'semantic'
                    CHECK (memory_type IN ('semantic', 'episodic', 'procedural')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_memories_user_id ON memories(user_id);
CREATE INDEX idx_memories_user_created ON memories(user_id, created_at DESC);
CREATE INDEX idx_memories_deleted ON memories(user_id, deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_memories_tags ON memories USING GIN (tags);

-- Full-text search on title + content
ALTER TABLE memories ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))) STORED;
CREATE INDEX idx_memories_fts ON memories USING GIN (search_vector);

-- =============================================================================
-- MEMORY_VERSIONS
-- =============================================================================
-- Append-only version history. A new row is created before each update.
-- The memories table always holds the current version.
-- =============================================================================

CREATE TABLE memory_versions (
    id              UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
    memory_id       UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,
    tags            JSONB NOT NULL DEFAULT '[]'::jsonb,
    memory_type     TEXT NOT NULL DEFAULT 'semantic'
                    CHECK (memory_type IN ('semantic', 'episodic', 'procedural')),
    origin          TEXT NOT NULL,
    allowed_vendors JSONB NOT NULL DEFAULT '["*"]'::jsonb,
    version_number  INTEGER NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memory_versions_memory ON memory_versions(memory_id, version_number);

-- =============================================================================
-- USAGE_EVENTS (partitioned by month)
-- =============================================================================

CREATE TABLE usage_events (
    id              UUID NOT NULL DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    operation       TEXT NOT NULL,
    origin          TEXT NOT NULL,
    request_id      TEXT UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_usage_events_user ON usage_events(user_id, created_at);

-- Create partitions for the next 12 months (extend as needed)
DO $$
DECLARE
    start_date DATE := date_trunc('month', CURRENT_DATE);
    end_date DATE;
    partition_name TEXT;
BEGIN
    FOR i IN 0..11 LOOP
        end_date := start_date + INTERVAL '1 month';
        partition_name := 'usage_events_' || to_char(start_date, 'YYYY_MM');
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_events FOR VALUES FROM (%L) TO (%L)',
            partition_name, start_date, end_date
        );
        start_date := end_date;
    END LOOP;
END $$;

-- =============================================================================
-- MONTHLY_USAGE
-- =============================================================================

CREATE TABLE monthly_usage (
    id              UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    month           TEXT NOT NULL,
    writes          INTEGER NOT NULL DEFAULT 0,
    reads           INTEGER NOT NULL DEFAULT 0,
    queries         INTEGER NOT NULL DEFAULT 0,
    total_ops       INTEGER NOT NULL DEFAULT 0,
    overage_ops     INTEGER NOT NULL DEFAULT 0,
    synced_to_stripe INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, month)
);

CREATE INDEX idx_monthly_usage_user_month ON monthly_usage(user_id, month);

-- =============================================================================
-- WAITLIST + EARLY ACCESS
-- =============================================================================

CREATE TABLE waitlist (
    id          UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
    email       TEXT NOT NULL UNIQUE,
    position    INTEGER NOT NULL,
    notified    INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE early_access_requests (
    id          UUID NOT NULL PRIMARY KEY DEFAULT uuid_generate_v4(),
    email       TEXT NOT NULL,
    linkedin    TEXT,
    company     TEXT,
    use_case    TEXT,
    details     TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_waitlist_email ON waitlist(email);
CREATE INDEX idx_waitlist_position ON waitlist(position);
CREATE INDEX idx_early_access_email ON early_access_requests(email);
CREATE INDEX idx_early_access_status ON early_access_requests(status);

-- =============================================================================
-- MIGRATIONS TRACKER
-- =============================================================================

CREATE TABLE _migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- RESERVED: Phase 3 -- Identity & Governance Primitives
-- =============================================================================
-- These columns/tables will be added when multi-user and enterprise features
-- are implemented. Schema is designed to accommodate them without breaking changes.
--
-- memories table additions (future):
--   principal_id    -- canonical user identity across surfaces
--   actor_id        -- agent/workflow/role that performed the action
--   actor_surface   -- surface the actor operated from (chatgpt, claude, cursor, etc.)
--
-- New tables (future):
--   principals      -- cross-surface identity mapping
--   actors          -- agent/workflow/role definitions
--   delegations     -- principal-to-actor delegation relationships
--   visibility_rules -- multi-dimensional governance (principal, actor, vendor, operation, temporal scopes)
-- =============================================================================
