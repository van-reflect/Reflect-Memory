# Reflect Memory — Architecture

**Vendor-neutral memory substrate for AI agents.**

Reflect Memory sits underneath AI tools — ChatGPT, Claude, Cursor, Gemini, Grok, n8n, and others — and provides persistent, user-scoped memory that any agent can read from and write to, with deterministic visibility controls. It is not a model, not a wrapper, and not a prompt cache. It is a data layer.

---

## 1. Problem

Every major AI tool is stateless across sessions. ChatGPT forgets what you told it yesterday. Claude doesn't know what Cursor wrote this morning. Users repeat context constantly — preferences, project details, decisions, constraints — across every tool, every session.

The vendor responses to this are walled gardens. ChatGPT Memory is locked to OpenAI. Claude Projects are locked to Anthropic. None of these systems interoperate. A user's accumulated context is fragmented across silos they don't control and can't export.

There is no standard for persistent, cross-vendor memory. Reflect Memory is that standard.

---

## 2. System Model

```
┌─────────────────────────────────────────────────────────────┐
│                         User                                │
│                    (full CRUD, visibility control)           │
└──────────────┬──────────────────────────┬───────────────────┘
               │                          │
        Dashboard (Web)            API Key (SDK/CLI)
               │                          │
               ▼                          ▼
┌─────────────────────────────────────────────────────────────┐
│                     Reflect Memory API                       │
│                   (Fastify, single process)                  │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Auth Hook   │  │  Rate Limit  │  │  Usage Metering  │  │
│  │  (per-req)   │  │  (100/min)   │  │  (per-operation) │  │
│  └──────┬───────┘  └──────────────┘  └──────────────────┘  │
│         │                                                   │
│  ┌──────┴───────────────────────────────────────────────┐   │
│  │                  Route Layer                          │   │
│  │  /memories/*        — User CRUD                      │   │
│  │  /agent/memories/*  — Agent read/write (scoped)      │   │
│  │  /mcp               — MCP transport (proxied)        │   │
│  │  /query             — AI-assisted retrieval           │   │
│  │  /admin/*           — Metrics (admin role only)       │   │
│  └──────┬───────────────────────────────────────────────┘   │
│         │                                                   │
│  ┌──────┴───────────────────────────────────────────────┐   │
│  │              Memory Service                          │   │
│  │  Pure data access. No HTTP, no AI, no side effects.  │   │
│  │  Every function requires explicit user_id.           │   │
│  └──────┬───────────────────────────────────────────────┘   │
│         │                                                   │
│  ┌──────┴───────────────────────────────────────────────┐   │
│  │              SQLite (WAL mode)                        │   │
│  │  better-sqlite3 · synchronous · single-writer        │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                     AI Agents                                │
│        ChatGPT · Claude · Cursor · Gemini · Grok · n8n      │
└──────────────┬──────────────────────────┬───────────────────┘
               │                          │
          MCP Transport              REST API
        (Streamable HTTP)         (Bearer token)
               │                          │
               ▼                          ▼
┌─────────────────────────────────────────────────────────────┐
│              MCP Server (Express, port 3001)                 │
│  Per-request vendor resolution · Session tracking            │
│  Tools: read, write, browse, search, get_by_tag, get_latest │
│  Proxied through main API at /mcp for single-port deploy    │
└──────────────┬──────────────────────────────────────────────┘
               │
               ▼
         Memory Service → SQLite
```

The core data type is a **memory entry**:

| Field | Type | Purpose |
|---|---|---|
| `id` | UUIDv4 | Primary key |
| `user_id` | UUIDv4 | Ownership (foreign key to users) |
| `title` | TEXT | Short label for browse/discovery |
| `content` | TEXT (≤100KB) | The memory body |
| `tags` | JSON array | Categorization, used for filtered retrieval |
| `origin` | TEXT | Which agent/surface wrote it (`chatgpt`, `claude`, `cursor`, `dashboard`) |
| `allowed_vendors` | JSON array | Visibility control: `["*"]` = all, or explicit list |
| `created_at` | ISO 8601 | Immutable creation timestamp |
| `updated_at` | ISO 8601 | Last modification |
| `deleted_at` | ISO 8601 / null | Soft delete (30-day purge cycle) |

Three actor types interact with the system:

- **User** — Full CRUD. Controls visibility per-memory. Manages API keys. Accesses via dashboard or personal API key.
- **Agent** — Scoped read/write. Can only access `/agent/*`, `/query`, and `/mcp` routes. Reads are filtered by `allowed_vendors`. Origin is set server-side from the authenticated vendor identity — agents cannot spoof their origin.
- **Admin** — Superset of User. Access to `/admin/metrics`, `/admin/users`. Role enforced at the database level (`CHECK(role IN ('admin', 'private-alpha', 'user'))`).

---

## 3. Transport Layer

Two transport paths serve two integration models:

**REST API** — For direct integration. Fastify server with JSON schema validation on every route. Published OpenAPI spec at `/openapi.json`. Used by the dashboard, the TypeScript SDK, and any HTTP client.

**Model Context Protocol (MCP)** — For native AI tool integration. A separate Express server exposes seven tools (`read_memories`, `write_memory`, `browse_memories`, `search_memories`, `get_memories_by_tag`, `get_memory_by_id`, `get_latest_memory`) via the MCP SDK. Transport is Streamable HTTP (the current MCP recommended transport), with session management per connection.

The MCP server runs on a separate port internally but is proxied through the main API at `/mcp` via `@fastify/http-proxy`. This allows single-port deployment on platforms like Railway while keeping the MCP server's Express process isolated.

Key design choice: **one MCP endpoint, multiple vendors.** Rather than running separate MCP servers per vendor, a single server resolves the vendor identity from the Bearer token on each request. The `resolveVendor` function iterates all configured agent keys with timing-safe comparison and returns the matching vendor name. Each MCP session is then scoped to that vendor — the `createMcpServerWithTools` function binds the vendor into every tool's closure, so all reads are automatically filtered.

---

## 4. Persistence & Isolation

**Current: SQLite with WAL mode.** The database runs on `better-sqlite3` (synchronous, no connection pooling needed). WAL mode is enforced at startup — the process exits if WAL activation fails. This gives concurrent read access while maintaining single-writer semantics.

The schema uses `STRICT` tables (SQLite 3.37+) with `json_type()` CHECK constraints on JSON columns (SQLite 3.38+). Foreign keys are enforced on every connection via `PRAGMA foreign_keys = ON`.

**Scale path: PostgreSQL.** A complete Postgres schema exists (`schema-postgres.sql`) with the following upgrades:
- `TEXT` timestamps become `TIMESTAMPTZ`
- JSON `TEXT` columns become `JSONB` with GIN indexes on `tags` and `allowed_vendors`
- Full-text search via `tsvector` generated column on `title || content`, with a GIN index
- `usage_events` table is range-partitioned by `created_at` (monthly partitions, auto-generated for 12 months)
- Native `uuid_generate_v4()` replaces application-level UUID generation

**Per-user isolation** is enforced at the data access layer, not the database layer. Every function in `memory-service.ts` requires an explicit `user_id` parameter. There is no function that queries across users. The SQL `WHERE user_id = ?` clause is present in every query. This is a deliberate architectural choice: isolation is guaranteed by the service layer's API surface, not by row-level security (which would couple isolation to the database engine).

**Soft delete** — `DELETE` from the dashboard sets `deleted_at` to the current timestamp. Soft-deleted memories are excluded from all normal queries (`AND deleted_at IS NULL`). A separate `trashed` filter surfaces them for recovery. Hard delete is reserved for the 30-day purge job.

---

## 5. Visibility & Determinism

The `allowed_vendors` array on every memory is the visibility primitive. It is evaluated at query time in every read path:

```sql
AND EXISTS (
  SELECT 1 FROM json_each(m.allowed_vendors)
  WHERE value = '*' OR value = ?
)
```

This means:
- `["*"]` — visible to all agents and the user.
- `["chatgpt", "claude"]` — visible only to ChatGPT and Claude. Cursor and Grok cannot see it.
- The user always sees all their memories regardless of `allowed_vendors`.

**No AI in the write path.** Memories are written by explicit user action (dashboard, API key) or explicit agent action (MCP tool call, REST endpoint). The system never infers, summarizes, or generates memories autonomously. What gets stored is exactly what was sent.

**Origin tracking** — Every memory records which surface wrote it. For agent writes, `origin` is set server-side from the authenticated vendor identity (`request.vendor`). The agent cannot set or override it. For user writes via the dashboard, origin is `"dashboard"`. This creates an auditable provenance chain.

**Append-only collaboration** — Agents write new memories; they do not overwrite each other's entries. An agent can read what another agent wrote (if visibility allows) and build on it by writing a new memory. This prevents context loss from overwrites and creates a natural timeline of accumulated knowledge.

---

## 6. Authentication & Multi-Tenancy

Four auth paths, resolved in order on every request:

1. **Dashboard auth** — Service key (`RM_DASHBOARD_SERVICE_KEY`) validated with timing-safe comparison, plus a JWT in `X-Dashboard-Token` verified with `jose`. The JWT contains the user's email; the server calls `findOrCreateUserByEmail` to resolve the `user_id`. This supports Clerk-based OAuth and magic link flows on the dashboard.

2. **Owner API key** — Single `RM_API_KEY` for the instance owner. Timing-safe comparison. Grants full user access.

3. **Agent keys** — Per-vendor keys discovered from environment variables at startup (`RM_AGENT_KEY_CHATGPT`, `RM_AGENT_KEY_CLAUDE`, etc.). Each key is compared timing-safely against the token. On match, the request is tagged with `role: "agent"` and `vendor: "<name>"`. Agents are restricted to `/agent/*`, `/query`, `/mcp`, `/whoami`, and `/health`. Any attempt to access other routes returns 403.

4. **Per-user API keys** — Stored in the `api_keys` table. Only the SHA-256 hash is persisted; the raw key is shown once at creation (prefix: `rm_live_`). Authenticated via `authenticateApiKey()` which hashes the incoming token and looks up the hash. Supports revocation (`revoked_at` column) and usage tracking (`last_used_at`).

**Rate limiting** — Global 100 requests/minute per IP via `@fastify/rate-limit`. Admin routes have a tighter limit (10/minute).

**Usage metering** — Every metered operation (memory write, memory read, query, chat) is recorded in `usage_events` with an idempotency key. Monthly aggregates in `monthly_usage` feed Stripe for billing. Quota checks run before write operations.

---

## 7. Current State

- **Production API** at `api.reflectmemory.com`, deployed on Railway
- **6 live integrations**: ChatGPT, Claude, Cursor, Gemini, Grok, n8n
- **Published artifacts**: 3 npm packages (`reflect-memory-mcp`, `reflect-memory-sdk`, `n8n-nodes-reflect-memory`), OpenAPI spec, MCP server
- **Submitted to 3 integration directories**: Cursor Marketplace, Anthropic MCP Connectors, n8n Community Nodes
- **Billing infrastructure** coded: Stripe integration with checkout sessions, billing portal, webhook handling, plan limits (`free`, `builder`), and overage tracking. Pending activation for public beta.
- **Backup**: Daily SQLite backup at 06:00 UTC, scheduled in-process
- **Migration system**: Numbered migrations tracked in `_migrations` table, idempotent, run at startup

---

## 8. What's Next

**PostgreSQL migration** — The Postgres schema is written. Migration means swapping `better-sqlite3` for a Postgres client (`pg` or `postgres.js`), updating the memory service queries (minimal — the SQL is standard), and enabling FTS + JSONB indexing. This unlocks horizontal read scaling, connection pooling, and partitioned usage event storage.

**Usage metering activation** — Stripe integration is coded and tested. Activation requires flipping the billing gate for public beta users. Plan limits are defined (`PLAN_LIMITS`), quota checks are wired into the request lifecycle.

**Onboarding flow** — Waitlist and early access request tables exist. The public beta flow: waitlist → early access review → account creation → API key generation → integration setup.

**Additional integrations** — The MCP server is vendor-agnostic by design. Adding a new vendor is a single environment variable (`RM_AGENT_KEY_<VENDOR>=<key>`). As MCP adoption grows across AI tools, each new tool that supports MCP gets Reflect Memory access with zero code changes.

**Semantic search** — The Postgres schema includes a `tsvector` generated column for full-text search. The next step is vector embeddings for semantic retrieval, enabling agents to find memories by meaning rather than keyword match.
