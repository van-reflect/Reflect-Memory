-- Reflect Memory — MVP Schema
-- SQLite 3.37+ required (STRICT tables)
-- SQLite 3.38+ required (json_valid, json_type)

-- Must be run per connection. Without this, foreign keys are advisory only.
PRAGMA foreign_keys = ON;

-- =============================================================================
-- USERS
-- =============================================================================
-- Establishes identity for memory ownership.
-- Single-user MVP, but user_id scopes every query for multi-tenant safety.
-- =============================================================================

CREATE TABLE users (
    -- UUIDv4 as text. No autoincrement integers — avoids leaking sequence info.
    id          TEXT NOT NULL PRIMARY KEY,

    -- Email for dashboard auth. Nullable for legacy seeded user. Unique when set.
    email       TEXT UNIQUE,

    -- ISO 8601 timestamp. When this user record was created.
    created_at  TEXT NOT NULL
) STRICT;

-- =============================================================================
-- MEMORIES
-- =============================================================================
-- The single source of truth for all user-authored memory entries.
-- One table, no children, no inbound foreign keys.
-- Delete means: DELETE FROM memories WHERE id = ? AND user_id = ?
-- =============================================================================

CREATE TABLE memories (
    -- UUIDv4 as text. Primary key for hard deletion (Invariant 2).
    id          TEXT NOT NULL PRIMARY KEY,

    -- Owner. Every query must include this in the WHERE clause.
    -- ON DELETE RESTRICT: cannot delete a user while memories exist.
    -- This prevents orphaned rows. Delete memories first, then the user.
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

    -- Human-readable label. Required, never inferred.
    title       TEXT NOT NULL,

    -- The memory content. Freeform text, authored by the user.
    content     TEXT NOT NULL,

    -- Tags as a JSON array of strings: '["work", "project-x"]'
    -- Stored on the same row — no join table, no cascading deletes.
    -- CHECK ensures this is always a valid JSON array, never a bare string or object.
    tags        TEXT NOT NULL DEFAULT '[]'
                CHECK(json_type(tags) = 'array'),

    -- Who created this memory. Set server-side from the auth key. Never self-reported.
    -- Values: "user", "chatgpt", "claude", etc.
    origin      TEXT NOT NULL DEFAULT 'user',

    -- Which vendors can see this memory in queries. JSON array of strings.
    -- ["*"] = all vendors. ["chatgpt","claude"] = only those two.
    -- Validated server-side against configured vendor list.
    allowed_vendors TEXT NOT NULL DEFAULT '["*"]'
                    CHECK(json_type(allowed_vendors) = 'array'),

    -- ISO 8601 timestamps. Set by the application, not by SQLite triggers.
    -- No hidden DEFAULT CURRENT_TIMESTAMP — the application is explicit.
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,

    -- Trash: when set, memory is soft-deleted. NULL = active.
    -- Auto-purge after 30 days is a separate job. Restore clears this.
    deleted_at  TEXT
) STRICT;

-- Every memory query is scoped by user_id. This index makes that fast.
CREATE INDEX idx_memories_user_id ON memories(user_id);

-- Trash listing: find soft-deleted memories by user.
CREATE INDEX idx_memories_deleted_at ON memories(user_id, deleted_at);
-- Recency queries: (user_id, created_at DESC) for deterministic "most recent first" ordering.
CREATE INDEX IF NOT EXISTS idx_memories_user_created ON memories(user_id, created_at DESC);

