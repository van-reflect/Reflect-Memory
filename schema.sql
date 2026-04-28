-- Reflect Memory v1 -- Canonical Schema
-- SQLite 3.37+ required (STRICT tables)
-- SQLite 3.38+ required (json_valid, json_type)
--
-- This schema is designed Postgres-first but implemented on SQLite for
-- Private Alpha through early Beta. When migrating to Postgres:
--   - TEXT timestamps become TIMESTAMPTZ
--   - JSON TEXT columns become JSONB (enables GIN indexing)
--   - Add FTS via tsvector on memories(title, content)
--   - Partition usage_events by month

PRAGMA foreign_keys = ON;

-- =============================================================================
-- USERS
-- =============================================================================
-- Identity for memory ownership and billing.
-- clerk_id + stripe_customer_id populated when those services are integrated.
-- =============================================================================

CREATE TABLE users (
    id                  TEXT NOT NULL PRIMARY KEY,   -- UUIDv4 (internal)
    clerk_id            TEXT UNIQUE,                  -- Clerk user ID (NULL until Clerk integration)
    email               TEXT NOT NULL UNIQUE,
    role                TEXT NOT NULL DEFAULT 'user'
                        CHECK(role IN ('admin', 'private-alpha', 'user')),
    stripe_customer_id  TEXT UNIQUE,                  -- Stripe customer ID (NULL until subscribed)
    plan                TEXT NOT NULL DEFAULT 'free'
                        CHECK(plan IN ('free', 'builder', 'pro', 'team', 'admin')),
    team_id             TEXT REFERENCES teams(id),
    team_role           TEXT DEFAULT NULL
                        CHECK(team_role IN ('owner', 'member')),
    first_name          TEXT DEFAULT NULL,
    last_name           TEXT DEFAULT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
) STRICT;

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_clerk_id ON users(clerk_id);

-- =============================================================================
-- API_KEYS
-- =============================================================================
-- Per-user API keys. Users generate keys from the dashboard.
-- Only the SHA-256 hash is stored; the raw key is shown once at creation.
-- =============================================================================

CREATE TABLE api_keys (
    id              TEXT NOT NULL PRIMARY KEY,   -- UUIDv4
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash        TEXT NOT NULL UNIQUE,         -- SHA-256 of the full key
    key_prefix      TEXT NOT NULL,                -- "rm_live_" + first 8 chars (for display)
    label           TEXT NOT NULL DEFAULT 'Default',
    last_used_at    TEXT,
    created_at      TEXT NOT NULL,
    revoked_at      TEXT                          -- NULL = active
) STRICT;

CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;

-- =============================================================================
-- TEAMS
-- =============================================================================
-- Team tier: shared namespace for collaborative AI memory.
-- =============================================================================

CREATE TABLE teams (
    id          TEXT NOT NULL PRIMARY KEY,
    name        TEXT NOT NULL,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    plan        TEXT NOT NULL DEFAULT 'team',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
) STRICT;

CREATE TABLE team_invites (
    id          TEXT NOT NULL PRIMARY KEY,
    team_id     TEXT NOT NULL REFERENCES teams(id),
    email       TEXT,
    token       TEXT NOT NULL UNIQUE,
    invited_by  TEXT NOT NULL REFERENCES users(id),
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending', 'accepted', 'expired')),
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
) STRICT;

-- =============================================================================
-- MEMORIES
-- =============================================================================
-- Single source of truth for all user-authored memory entries.
-- =============================================================================

CREATE TABLE memories (
    id                   TEXT NOT NULL PRIMARY KEY,
    user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    title                TEXT NOT NULL,
    content              TEXT NOT NULL,
    tags                 TEXT NOT NULL DEFAULT '[]'
                         CHECK(json_type(tags) = 'array'),
    origin               TEXT NOT NULL DEFAULT 'user',
    allowed_vendors      TEXT NOT NULL DEFAULT '["*"]'
                         CHECK(json_type(allowed_vendors) = 'array'),
    memory_type          TEXT NOT NULL DEFAULT 'semantic'
                         CHECK(memory_type IN ('semantic', 'episodic', 'procedural')),
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    deleted_at           TEXT,
    shared_with_team_id  TEXT REFERENCES teams(id),
    shared_at            TEXT DEFAULT NULL,
    -- Threading: a memory with parent_memory_id set is a "reply" to the
    -- referenced memory. Enforced at the app layer: single level only
    -- (a memory that is itself a child cannot be made a parent). Children
    -- inherit the parent's shared_with_team_id and cascade through soft
    -- delete / restore / permanent delete. No ON DELETE CASCADE in SQL —
    -- app code cascades so SSE events fire per child.
    parent_memory_id     TEXT REFERENCES memories(id)
) STRICT;

CREATE INDEX idx_memories_user_id ON memories(user_id);
CREATE INDEX idx_memories_deleted_at ON memories(user_id, deleted_at);
CREATE INDEX idx_memories_user_created ON memories(user_id, created_at DESC);
CREATE INDEX idx_memories_parent_id ON memories(parent_memory_id) WHERE parent_memory_id IS NOT NULL;

-- =============================================================================
-- MEMORY_VERSIONS
-- =============================================================================
-- Append-only version history. A new row is created before each update.
-- The memories table always holds the current version.
-- =============================================================================

CREATE TABLE memory_versions (
    id              TEXT NOT NULL PRIMARY KEY,
    memory_id       TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,
    tags            TEXT NOT NULL DEFAULT '[]'
                    CHECK(json_type(tags) = 'array'),
    memory_type     TEXT NOT NULL DEFAULT 'semantic'
                    CHECK(memory_type IN ('semantic', 'episodic', 'procedural')),
    origin          TEXT NOT NULL,
    allowed_vendors TEXT NOT NULL DEFAULT '["*"]'
                    CHECK(json_type(allowed_vendors) = 'array'),
    version_number  INTEGER NOT NULL,
    created_at      TEXT NOT NULL
) STRICT;

CREATE INDEX idx_memory_versions_memory_id ON memory_versions(memory_id, version_number);

-- =============================================================================
-- USAGE_EVENTS
-- =============================================================================
-- Append-only operation log. Every API operation generates one event.
-- request_id provides idempotency (duplicate inserts silently ignored).
-- =============================================================================

CREATE TABLE usage_events (
    id              TEXT NOT NULL PRIMARY KEY,   -- UUIDv4
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    operation       TEXT NOT NULL,                -- 'memory_write' | 'memory_read' | 'query' | 'chat'
    origin          TEXT NOT NULL,                -- 'dashboard' | 'chatgpt' | 'cursor' | etc.
    request_id      TEXT UNIQUE,                  -- idempotency key
    created_at      TEXT NOT NULL
) STRICT;

CREATE INDEX idx_usage_events_user_id ON usage_events(user_id);
CREATE INDEX idx_usage_events_user_month ON usage_events(user_id, created_at);

-- =============================================================================
-- MONTHLY_USAGE
-- =============================================================================
-- Aggregated billing view. Updated atomically with each usage_event insert.
-- Stripe receives these totals, not raw events.
-- =============================================================================

CREATE TABLE monthly_usage (
    id              TEXT NOT NULL PRIMARY KEY,   -- UUIDv4
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    month           TEXT NOT NULL,                -- 'YYYY-MM'
    writes          INTEGER NOT NULL DEFAULT 0,
    reads           INTEGER NOT NULL DEFAULT 0,
    queries         INTEGER NOT NULL DEFAULT 0,
    total_ops       INTEGER NOT NULL DEFAULT 0,
    overage_ops     INTEGER NOT NULL DEFAULT 0,
    synced_to_stripe INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, month)
) STRICT;

CREATE INDEX idx_monthly_usage_user_month ON monthly_usage(user_id, month);

-- =============================================================================
-- WAITLIST + EARLY ACCESS (unchanged from migration 004)
-- =============================================================================

CREATE TABLE waitlist (
    id          TEXT NOT NULL PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    position    INTEGER NOT NULL,
    notified    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
) STRICT;

CREATE TABLE early_access_requests (
    id          TEXT NOT NULL PRIMARY KEY,
    email       TEXT NOT NULL,
    linkedin    TEXT,
    company     TEXT,
    use_case    TEXT,
    details     TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TEXT NOT NULL
) STRICT;

CREATE INDEX idx_waitlist_email ON waitlist(email);
CREATE INDEX idx_waitlist_position ON waitlist(position);
CREATE INDEX idx_early_access_email ON early_access_requests(email);
CREATE INDEX idx_early_access_status ON early_access_requests(status);

-- =============================================================================
-- TAG_CLUSTER_CACHE
-- =============================================================================
-- Caches LLM-generated names for the Louvain clusters of tag co-occurrence.
-- Keyed on (user_id, scope, cluster_hash). cluster_hash is a stable digest
-- of the sorted member-tag list so small drift in the corpus doesn't bust
-- the cache. Stale rows are recomputed after 24h or after N writes.
-- =============================================================================

CREATE TABLE tag_cluster_cache (
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope          TEXT NOT NULL,
    cluster_hash   TEXT NOT NULL,
    name           TEXT NOT NULL,
    description    TEXT NOT NULL,
    tags           TEXT NOT NULL CHECK(json_type(tags) = 'array'),
    member_count   INTEGER NOT NULL,
    computed_at    TEXT NOT NULL,
    PRIMARY KEY (user_id, scope, cluster_hash)
) STRICT;

CREATE INDEX idx_tag_cluster_cache_user_scope ON tag_cluster_cache(user_id, scope);

-- =============================================================================
-- LLM PROVIDER KEYS (migration 023)
-- =============================================================================
-- One row per (team_id|user_id, provider). Keys encrypted at rest with
-- AES-256-GCM. Master key from RM_LLM_KEY_ENCRYPTION_KEY env, per-tenant
-- sub-key derived via HKDF-SHA256 with the team/user ID as salt. last4 stored
-- cleartext for UI display. See src/llm-key-crypto.ts.

CREATE TABLE llm_keys (
    id                  TEXT PRIMARY KEY,
    team_id             TEXT REFERENCES teams(id) ON DELETE CASCADE,
    user_id             TEXT REFERENCES users(id) ON DELETE CASCADE,
    provider            TEXT NOT NULL,
    key_encrypted       BLOB NOT NULL,
    key_nonce           BLOB NOT NULL,
    key_last4           TEXT NOT NULL,
    created_by_user_id  TEXT REFERENCES users(id),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    CHECK (
        (team_id IS NOT NULL AND user_id IS NULL) OR
        (team_id IS NULL AND user_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX idx_llm_keys_team_provider
    ON llm_keys(team_id, provider) WHERE team_id IS NOT NULL;
CREATE UNIQUE INDEX idx_llm_keys_user_provider
    ON llm_keys(user_id, provider) WHERE user_id IS NOT NULL;

-- =============================================================================
-- SLACK WORKSPACES (migration 024)
-- =============================================================================
-- One row per Slack workspace install, mapped 1-to-1 to a Reflect team (or
-- a solo Reflect user). Bot token encrypted at rest using the same scheme as
-- llm_keys. Soft-deleted via uninstalled_at; the row is kept for audit
-- history. See docs/eng-plan-slack-app-v1.md.

CREATE TABLE slack_workspaces (
    id                    TEXT PRIMARY KEY,
    slack_team_id         TEXT NOT NULL UNIQUE,
    slack_team_name       TEXT NOT NULL,
    reflect_team_id       TEXT REFERENCES teams(id),
    reflect_user_id       TEXT REFERENCES users(id),
    bot_user_id           TEXT NOT NULL,
    bot_token_encrypted   BLOB NOT NULL,
    bot_token_nonce       BLOB NOT NULL,
    installed_by_user_id  TEXT REFERENCES users(id),
    installed_at          TEXT NOT NULL,
    uninstalled_at        TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    CHECK (
        (reflect_team_id IS NOT NULL AND reflect_user_id IS NULL) OR
        (reflect_team_id IS NULL AND reflect_user_id IS NOT NULL)
    )
);

CREATE INDEX idx_slack_workspaces_team ON slack_workspaces(reflect_team_id);
CREATE INDEX idx_slack_workspaces_user ON slack_workspaces(reflect_user_id);

-- =============================================================================
-- SLACK CONVERSATION STATE (migration 025)
-- =============================================================================
-- Per-Slack-thread short-term context so the agent sees the last few turns of
-- a conversation in a thread without re-fetching from Slack. TTL'd to 24h.

CREATE TABLE slack_conversation_state (
    id                  TEXT PRIMARY KEY,
    slack_workspace_id  TEXT NOT NULL REFERENCES slack_workspaces(id) ON DELETE CASCADE,
    channel_id          TEXT NOT NULL,
    thread_ts           TEXT NOT NULL,
    messages_json       TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    expires_at          TEXT NOT NULL,
    UNIQUE(slack_workspace_id, channel_id, thread_ts)
);

CREATE INDEX idx_slack_convo_expires ON slack_conversation_state(expires_at);

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

