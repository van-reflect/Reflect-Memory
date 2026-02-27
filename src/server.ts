// Reflect Memory — HTTP API Layer
// Fastify server with memory CRUD, agent connector, and AI query route.
// No UI. No logging. No default behavior.
// Every request requires auth and explicit intent.

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import proxy from "@fastify/http-proxy";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { jwtVerify } from "jose";
import type Database from "better-sqlite3";
import { findOrCreateUserByEmail } from "./user-service.js";
import {
  createMemory,
  readMemoryById,
  listMemories,
  listMemorySummaries,
  countMemories,
  updateMemory,
  softDeleteMemory,
  restoreMemory,
  type MemoryEntry,
  type CreateMemoryInput,
  type UpdateMemoryInput,
  type MemoryFilter,
  type PaginationOptions,
} from "./memory-service.js";
import { buildPrompt, type PromptResult } from "./context-builder.js";
import {
  callModel,
  getConfigReceipt,
  type ModelGatewayConfig,
  type ModelConfigReceipt,
} from "./model-gateway.js";
import {
  chat,
  AVAILABLE_MODELS,
  type ProviderConfig,
  type ChatMessage,
} from "./chat-gateway.js";

// =============================================================================
// Type augmentation
// =============================================================================

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
    role: "user" | "agent";
    vendor: string | null;
    authMethod: "dashboard" | "api_key" | "agent_key";
  }
}

// =============================================================================
// Application types
// =============================================================================

export interface QueryReceipt {
  response: string;
  memories_used: MemoryEntry[];
  prompt_sent: string;
  model_config: ModelConfigReceipt;
  vendor_filter: string | null;
  truncated: boolean;
  memories_included: number;
  memories_total: number;
}

export interface AgentQueryReceipt {
  response: string;
  memories_used_count: number;
  memories_included_in_prompt: number;
  truncated: boolean;
  estimated_tokens: number;
  vendor_filter: string | null;
}

// =============================================================================
// Server config
// =============================================================================

export interface ServerConfig {
  db: Database.Database;
  apiKey: string;
  userId: string;
  modelGateway: ModelGatewayConfig;
  systemPrompt: string;
  startedAt: number;
  agentKeys: Record<string, string>;
  validVendors: string[];
  contextCharBudget: number;
  chatProviders: ProviderConfig;
  dashboardServiceKey: string | null;
  dashboardJwtSecret: string | null;
  mcpPort: number | null;
}

// =============================================================================
// Auth helper
// =============================================================================

function constantTimeEqual(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

// =============================================================================
// JSON Schemas
// =============================================================================

const memoryBodySchema = {
  type: "object" as const,
  required: ["title", "content", "tags"],
  additionalProperties: false,
  properties: {
    title: { type: "string" as const, minLength: 1, maxLength: 500 },
    content: { type: "string" as const, minLength: 1, maxLength: 100_000 },
    tags: {
      type: "array" as const,
      items: { type: "string" as const, minLength: 1, maxLength: 100 },
      maxItems: 50,
    },
    allowed_vendors: {
      type: "array" as const,
      items: { type: "string" as const, minLength: 1, maxLength: 50 },
      minItems: 1,
      maxItems: 50,
    },
  },
};

const agentMemoryBodySchema = {
  type: "object" as const,
  required: ["title", "content", "tags", "allowed_vendors"],
  additionalProperties: false,
  properties: {
    title: { type: "string" as const, minLength: 1, maxLength: 500 },
    content: { type: "string" as const, minLength: 1, maxLength: 100_000 },
    tags: {
      type: "array" as const,
      items: { type: "string" as const, minLength: 1, maxLength: 100 },
      maxItems: 50,
    },
    allowed_vendors: {
      type: "array" as const,
      items: { type: "string" as const, minLength: 1, maxLength: 50 },
      minItems: 1,
      maxItems: 50,
    },
  },
};

const updateMemoryBodySchema = {
  type: "object" as const,
  required: ["title", "content", "tags", "allowed_vendors"],
  additionalProperties: false,
  properties: {
    title: { type: "string" as const, minLength: 1, maxLength: 500 },
    content: { type: "string" as const, minLength: 1, maxLength: 100_000 },
    tags: {
      type: "array" as const,
      items: { type: "string" as const, minLength: 1, maxLength: 100 },
      maxItems: 50,
    },
    allowed_vendors: {
      type: "array" as const,
      items: { type: "string" as const, minLength: 1, maxLength: 50 },
      minItems: 1,
      maxItems: 50,
    },
  },
};

const memoryIdParamSchema = {
  type: "object" as const,
  required: ["id"],
  additionalProperties: false,
  properties: {
    id: { type: "string" as const, minLength: 1 },
  },
};

const memoryFilterSchema = {
  discriminator: { propertyName: "by" },
  oneOf: [
    {
      type: "object" as const,
      required: ["by"],
      additionalProperties: false,
      properties: {
        by: { type: "string" as const, const: "all" },
      },
    },
    {
      type: "object" as const,
      required: ["by", "tags"],
      additionalProperties: false,
      properties: {
        by: { type: "string" as const, const: "tags" },
        tags: {
          type: "array" as const,
          items: { type: "string" as const, minLength: 1 },
          minItems: 1,
        },
      },
    },
    {
      type: "object" as const,
      required: ["by", "ids"],
      additionalProperties: false,
      properties: {
        by: { type: "string" as const, const: "ids" },
        ids: {
          type: "array" as const,
          items: { type: "string" as const, minLength: 1 },
          minItems: 1,
        },
      },
    },
    {
      type: "object" as const,
      required: ["by", "term"],
      additionalProperties: false,
      properties: {
        by: { type: "string" as const, const: "search" },
        term: { type: "string" as const, minLength: 1, maxLength: 500 },
      },
    },
    {
      type: "object" as const,
      required: ["by"],
      additionalProperties: false,
      properties: {
        by: { type: "string" as const, const: "trashed" },
      },
    },
  ],
};

const listFilterBodySchema = {
  type: "object" as const,
  required: ["filter"],
  additionalProperties: false,
  properties: {
    filter: memoryFilterSchema,
    limit: { type: "integer" as const, minimum: 1, maximum: 500 },
    offset: { type: "integer" as const, minimum: 0 },
  },
};

const queryBodySchema = {
  type: "object" as const,
  required: ["query", "memory_filter"],
  additionalProperties: false,
  properties: {
    query: { type: "string" as const, minLength: 1, maxLength: 10_000 },
    memory_filter: memoryFilterSchema,
    limit: { type: "integer" as const, minimum: 1, maximum: 50 },
  },
};

const browseBodySchema = {
  type: "object" as const,
  required: ["filter"],
  additionalProperties: false,
  properties: {
    filter: memoryFilterSchema,
    limit: { type: "integer" as const, minimum: 1, maximum: 200 },
    offset: { type: "integer" as const, minimum: 0 },
  },
};

// =============================================================================
// Vendor validation helper
// =============================================================================

function validateAllowedVendors(
  allowedVendors: string[],
  validVendors: string[],
): string | null {
  for (const v of allowedVendors) {
    if (v !== "*" && !validVendors.includes(v)) {
      const valid = validVendors.length > 0
        ? `"*", ${validVendors.map((n) => `"${n}"`).join(", ")}`
        : `"*"`;
      return `Invalid vendor "${v}" in allowed_vendors. Valid: ${valid}`;
    }
  }
  return null;
}

// =============================================================================
// Server factory
// =============================================================================

export async function createServer(config: ServerConfig): Promise<FastifyInstance> {
  const {
    db,
    apiKey,
    userId,
    modelGateway,
    systemPrompt,
    startedAt,
    agentKeys,
    validVendors,
    contextCharBudget,
    chatProviders,
    dashboardServiceKey,
    dashboardJwtSecret,
    mcpPort,
  } = config;

  const server = Fastify({
    ajv: {
      customOptions: {
        discriminator: true,
        removeAdditional: false,
      },
    },
  });

  // CORS: only allow the production dashboard and local dev
  await server.register(cors, {
    origin: [
      "https://www.reflectmemory.com",
      "https://reflectmemory.com",
      ...(process.env.NODE_ENV !== "production" ? ["http://localhost:3000"] : []),
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Dashboard-Token", "mcp-session-id"],
    credentials: true,
  });

  // Global rate limit: 100 req/min per IP
  await server.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    onExceeded: (request) => {
      console.log(`[security] ${JSON.stringify({
        event: "rate_limit_exceeded",
        ip: request.ip,
        method: request.method,
        path: request.url.split("?")[0],
        time: new Date().toISOString(),
      })}`);
    },
  });

  // Proxy /mcp to the MCP server when it runs on a separate port (e.g. Railway exposes only one port)
  if (mcpPort != null) {
    await server.register(proxy, {
      upstream: `http://127.0.0.1:${mcpPort}`,
      prefix: "/mcp",
      rewritePrefix: "/mcp",
    });
  }

  server.decorateRequest("userId", "");
  server.decorateRequest("role", "user");
  server.decorateRequest("vendor", null);

  // ===========================================================================
  // Auth hook
  // ===========================================================================
  // Resolves caller identity from the Authorization header.
  // Sets role ("user" or "agent") and vendor (null for users, vendor name for agents).
  // Enforces route restrictions: agents can only hit /agent/*, /query, /whoami, /health.
  // ===========================================================================

  function logSecurity(event: string, request: { ip: string; url: string; method: string }, extra?: Record<string, unknown>) {
    const entry = {
      event,
      ip: request.ip,
      method: request.method,
      path: request.url.split("?")[0],
      time: new Date().toISOString(),
      ...extra,
    };
    console.log(`[security] ${JSON.stringify(entry)}`);
  }

  server.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health" || request.url === "/openapi.json") return;

    const header = request.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) {
      logSecurity("auth_missing", request);
      return reply.code(401).send({
        error: "Missing or malformed Authorization header. Expected: Bearer <api_key>",
      });
    }

    const token = header.slice("Bearer ".length);
    if (token.length === 0) {
      logSecurity("auth_empty", request);
      return reply.code(401).send({ error: "Empty API key" });
    }

    // Dashboard auth: service key + X-Dashboard-Token JWT
    if (
      dashboardServiceKey &&
      dashboardJwtSecret &&
      constantTimeEqual(token, dashboardServiceKey)
    ) {
      const dashboardToken = request.headers["x-dashboard-token"];
      if (typeof dashboardToken !== "string" || !dashboardToken) {
        logSecurity("dashboard_token_missing", request);
        return reply.code(401).send({
          error: "Dashboard auth requires X-Dashboard-Token header",
        });
      }
      try {
        const key = new TextEncoder().encode(dashboardJwtSecret);
        const { payload } = await jwtVerify(dashboardToken, key, {
          audience: "reflect-memory",
          issuer: "reflect-dashboard",
        });
        const email = payload.email;
        if (typeof email !== "string" || !email) {
          logSecurity("dashboard_token_invalid", request);
          return reply.code(401).send({ error: "Invalid dashboard token" });
        }
        request.userId = findOrCreateUserByEmail(db, email);
        request.role = "user";
        request.vendor = null;
        request.authMethod = "dashboard";
        return;
      } catch {
        logSecurity("dashboard_token_expired", request);
        return reply.code(401).send({ error: "Invalid or expired dashboard token" });
      }
    }

    // Try user key first.
    if (constantTimeEqual(token, apiKey)) {
      request.userId = userId;
      request.role = "user";
      request.vendor = null;
      request.authMethod = "api_key";
      return;
    }

    // Try each agent key. Timing-safe comparison for every configured vendor.
    for (const [vendor, key] of Object.entries(agentKeys)) {
      if (constantTimeEqual(token, key)) {
        request.userId = userId;
        request.role = "agent";
        request.vendor = vendor;
        request.authMethod = "agent_key";

        // Enforce agent route restrictions.
        const path = request.url.split("?")[0];
        const allowed =
          path === "/health" ||
          path === "/whoami" ||
          path === "/query" ||
          path.startsWith("/agent/") ||
          (config.mcpPort != null && path.startsWith("/mcp"));
        if (!allowed) {
          logSecurity("agent_route_forbidden", request, { vendor, path });
          return reply.code(403).send({
            error: "Agent keys cannot access this endpoint",
          });
        }

        return;
      }
    }

    logSecurity("auth_invalid_key", request);
    return reply.code(401).send({ error: "Invalid API key" });
  });

  // ===========================================================================
  // GET /health — Public health check
  // ===========================================================================

  server.get("/health", async () => {
    const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
    return {
      service: "reflect-memory",
      status: "ok",
      uptime_seconds: uptimeSeconds,
      model: modelGateway.model,
    };
  });

  // ===========================================================================
  // GET /openapi.json — Public OpenAPI spec for Custom Actions
  // ===========================================================================

  const openapiSpecPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "openapi-agent.yaml",
  );

  server.get("/openapi.json", async (_request, reply) => {
    try {
      const yaml = await import("js-yaml");
      const raw = readFileSync(openapiSpecPath, "utf-8");
      const spec = yaml.load(raw);
      reply.type("application/json");
      return spec;
    } catch {
      reply.code(500);
      return { error: "Failed to load OpenAPI spec" };
    }
  });

  // ===========================================================================
  // GET /whoami — Identity debugging
  // ===========================================================================
  // Returns the caller's resolved role and vendor from their auth key.
  // No sensitive data. Just what the server sees for this key.
  // ===========================================================================

  server.get("/whoami", async (request) => {
    return {
      role: request.role,
      vendor: request.vendor,
    };
  });

  // ===========================================================================
  // GET /admin/metrics — Owner-only usage stats
  // ===========================================================================
  // Dashboard auth or API key. Only the owner (userId) can access.
  // Returns user counts, memory counts, and growth metrics for alpha tracking
  // and investor/acquisition storytelling.
  // ===========================================================================

  server.get("/admin/check", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (request.userId !== userId) {
      reply.code(403);
      return { error: "Admin access restricted to owner" };
    }
    return { owner: true };
  });

  server.get("/admin/users", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (request.userId !== userId) {
      reply.code(403);
      return { error: "Admin access restricted to owner" };
    }
    const rows = db
      .prepare(`SELECT id, email, created_at FROM users ORDER BY created_at DESC`)
      .all() as { id: string; email: string | null; created_at: string }[];
    return { users: rows };
  });

  server.get("/admin/metrics", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (request.userId !== userId) {
      reply.code(403);
      return { error: "Admin access restricted to owner" };
    }

    const now = new Date().toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const totalUsers = (
      db.prepare(`SELECT count(*) as n FROM users`).get() as { n: number }
    ).n;

    const newUsers7d = (
      db
        .prepare(`SELECT count(*) as n FROM users WHERE created_at >= ?`)
        .get(sevenDaysAgo) as { n: number }
    ).n;

    const newUsers30d = (
      db
        .prepare(`SELECT count(*) as n FROM users WHERE created_at >= ?`)
        .get(thirtyDaysAgo) as { n: number }
    ).n;

    const totalMemories = (
      db
        .prepare(
          `SELECT count(*) as n FROM memories WHERE deleted_at IS NULL`,
        )
        .get() as { n: number }
    ).n;

    const newMemories7d = (
      db
        .prepare(
          `SELECT count(*) as n FROM memories WHERE deleted_at IS NULL AND created_at >= ?`,
        )
        .get(sevenDaysAgo) as { n: number }
    ).n;

    const newMemories30d = (
      db
        .prepare(
          `SELECT count(*) as n FROM memories WHERE deleted_at IS NULL AND created_at >= ?`,
        )
        .get(thirtyDaysAgo) as { n: number }
    ).n;

    const memoriesByOrigin = db
      .prepare(
        `SELECT origin, count(*) as n FROM memories WHERE deleted_at IS NULL GROUP BY origin`,
      )
      .all() as { origin: string; n: number }[];

    const usersWithMemories = (
      db
        .prepare(
          `SELECT count(DISTINCT user_id) as n FROM memories WHERE deleted_at IS NULL`,
        )
        .get() as { n: number }
    ).n;

    const avgMemoriesPerUser =
      usersWithMemories > 0
        ? Math.round((totalMemories / usersWithMemories) * 10) / 10
        : 0;

    return {
      users: {
        total: totalUsers,
        new_7d: newUsers7d,
        new_30d: newUsers30d,
        with_memories: usersWithMemories,
      },
      memories: {
        total: totalMemories,
        new_7d: newMemories7d,
        new_30d: newMemories30d,
        by_origin: Object.fromEntries(
          memoriesByOrigin.map((r) => [r.origin, r.n]),
        ),
        avg_per_user: avgMemoriesPerUser,
      },
      generated_at: now,
    };
  });

  // ===========================================================================
  // POST /memories — Create a memory (user path)
  // ===========================================================================
  // allowed_vendors is optional. Defaults to ["*"] server-side.
  // origin is always "user" — set server-side, never from the body.
  // ===========================================================================

  server.post(
    "/memories",
    {
      schema: {
        body: memoryBodySchema,
      },
    },
    async (request, reply) => {
      const body = request.body as {
        title: string;
        content: string;
        tags: string[];
        allowed_vendors?: string[];
      };

      const allowedVendors = body.allowed_vendors ?? ["*"];

      const vendorErr = validateAllowedVendors(allowedVendors, validVendors);
      if (vendorErr) {
        reply.code(400);
        return { error: vendorErr };
      }

      const input: CreateMemoryInput = {
        title: body.title,
        content: body.content,
        tags: body.tags,
        origin: request.authMethod === "dashboard" ? "dashboard" : "cursor",
        allowed_vendors: allowedVendors,
      };

      const memory = createMemory(db, request.userId, input);
      reply.code(201);
      return memory;
    },
  );

  // ===========================================================================
  // POST /agent/memories — Create a memory (agent path)
  // ===========================================================================
  // allowed_vendors is required. origin is set server-side from the auth key.
  // The body schema does NOT include origin — additionalProperties: false
  // rejects it with a 400 if present.
  // ===========================================================================

  server.post(
    "/agent/memories",
    {
      schema: {
        body: agentMemoryBodySchema,
      },
    },
    async (request, reply) => {
      const body = request.body as {
        title: string;
        content: string;
        tags: string[];
        allowed_vendors: string[];
      };

      const vendorErr = validateAllowedVendors(body.allowed_vendors, validVendors);
      if (vendorErr) {
        reply.code(400);
        return { error: vendorErr };
      }

      const input: CreateMemoryInput = {
        title: body.title,
        content: body.content,
        tags: body.tags,
        origin: request.vendor!,
        allowed_vendors: body.allowed_vendors,
      };

      const memory = createMemory(db, request.userId, input);
      reply.code(201);
      return memory;
    },
  );

  // ===========================================================================
  // GET /agent/memories/latest — Single most recent memory for agents
  // ===========================================================================
  // Zero-config "most recent" retrieval. No limit parameter, no filter schema.
  // Optional ?tag= query param: returns most recent memory with that tag.
  // Use ?tag=cto_response to always get latest CTO response, even if other
  // memories were written after. Prevents "latest" from being overwritten by
  // agent's own writes.
  // ===========================================================================

  server.get("/agent/memories/latest", async (request, reply) => {
    const vendorFilter = request.vendor;
    const tag = (request.query as { tag?: string }).tag?.trim();
    const filter = tag ? { by: "tags" as const, tags: [tag] } : { by: "all" as const };
    const memories = listMemories(
      db,
      request.userId,
      filter,
      vendorFilter,
      { limit: 1 },
    );
    const memory = memories[0] ?? null;
    if (!memory) {
      reply.code(404);
      return { error: tag ? `No memories found with tag "${tag}"` : "No memories found" };
    }
    return memory;
  });

  // ===========================================================================
  // GET /agent/memories/:id — Full-body retrieval by ID for agents
  // ===========================================================================
  // Deterministic, surgical access to a single memory. Vendor-filtered:
  // agents only see memories where allowed_vendors contains "*" or their vendor.
  // Returns 404 if the memory doesn't exist OR the agent can't see it (no leaking).
  // ===========================================================================

  server.get(
    "/agent/memories/:id",
    {
      schema: {
        params: memoryIdParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const memory = readMemoryById(db, request.userId, id);
      if (!memory || memory.deleted_at) {
        reply.code(404);
        return { error: "Memory not found" };
      }

      if (request.vendor) {
        const allowed = memory.allowed_vendors.includes("*") || memory.allowed_vendors.includes(request.vendor);
        if (!allowed) {
          reply.code(404);
          return { error: "Memory not found" };
        }
      }

      return memory;
    },
  );

  // ===========================================================================
  // POST /agent/memories/by-tag — Full-body retrieval by tags for agents
  // ===========================================================================
  // Returns complete memory entries (with content) filtered by tags.
  // Vendor-filtered. Supports pagination. Use for council retrieval,
  // audit, and any case where agents need full memory bodies by topic.
  // ===========================================================================

  server.post(
    "/agent/memories/by-tag",
    {
      schema: {
        body: {
          type: "object" as const,
          required: ["tags"],
          additionalProperties: false,
          properties: {
            tags: {
              type: "array" as const,
              items: { type: "string" as const, minLength: 1, maxLength: 100 },
              minItems: 1,
              maxItems: 50,
            },
            limit: { type: "integer" as const, minimum: 1, maximum: 100 },
            offset: { type: "integer" as const, minimum: 0 },
          },
        },
      },
    },
    async (request) => {
      const { tags, limit, offset } = request.body as {
        tags: string[];
        limit?: number;
        offset?: number;
      };

      const vendorFilter = request.role === "agent" ? request.vendor : null;
      const pagination: PaginationOptions = {
        limit: limit ?? 20,
        offset: offset ?? 0,
      };

      const memories = listMemories(
        db,
        request.userId,
        { by: "tags", tags },
        vendorFilter,
        pagination,
      );
      const total = countMemories(
        db,
        request.userId,
        { by: "tags", tags },
        vendorFilter,
      );

      return {
        memories,
        total,
        limit: pagination.limit,
        offset: pagination.offset,
        has_more: (pagination.offset ?? 0) + memories.length < total,
      };
    },
  );

  // ===========================================================================
  // POST /agent/memories/browse — Lightweight memory listing for agents
  // ===========================================================================
  // Returns memory summaries (title, tags, origin, timestamps) without content.
  // Agents use this to discover what memories exist, then selectively fetch
  // or query with specific IDs/tags. Supports pagination.
  // ===========================================================================

  server.post(
    "/agent/memories/browse",
    {
      schema: {
        body: browseBodySchema,
      },
    },
    async (request) => {
      const { filter, limit, offset } = request.body as {
        filter: MemoryFilter;
        limit?: number;
        offset?: number;
      };

      const vendorFilter = request.role === "agent" ? request.vendor : null;
      const pagination: PaginationOptions = {
        limit: limit ?? 50,
        offset: offset ?? 0,
      };

      const summaries = listMemorySummaries(db, request.userId, filter, vendorFilter, pagination);
      const total = countMemories(db, request.userId, filter, vendorFilter);

      return {
        memories: summaries,
        total,
        limit: pagination.limit,
        offset: pagination.offset,
        has_more: (pagination.offset ?? 0) + summaries.length < total,
      };
    },
  );

  // ===========================================================================
  // GET /memories/:id — Read a single memory
  // ===========================================================================

  server.get(
    "/memories/:id",
    {
      schema: {
        params: memoryIdParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const memory = readMemoryById(db, request.userId, id);
      if (!memory) {
        reply.code(404);
        return { error: "Memory not found" };
      }
      return memory;
    },
  );

  // ===========================================================================
  // POST /memories/list — List memories with an explicit filter
  // ===========================================================================

  server.post(
    "/memories/list",
    {
      schema: {
        body: listFilterBodySchema,
      },
    },
    async (request) => {
      const body = request.body as {
        filter: MemoryFilter;
        limit?: number;
        offset?: number;
      };
      const pagination: PaginationOptions | undefined =
        body.limit != null
          ? { limit: body.limit, offset: body.offset ?? 0 }
          : undefined;
      const memories = listMemories(
        db,
        request.userId,
        body.filter,
        null,
        pagination,
      );
      return { memories };
    },
  );

  // ===========================================================================
  // PUT /memories/:id — Update a memory (full replacement)
  // ===========================================================================
  // Now requires allowed_vendors in the body. origin is immutable.
  // ===========================================================================

  server.put(
    "/memories/:id",
    {
      schema: {
        params: memoryIdParamSchema,
        body: updateMemoryBodySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        title: string;
        content: string;
        tags: string[];
        allowed_vendors: string[];
      };

      const vendorErr = validateAllowedVendors(body.allowed_vendors, validVendors);
      if (vendorErr) {
        reply.code(400);
        return { error: vendorErr };
      }

      const input: UpdateMemoryInput = {
        title: body.title,
        content: body.content,
        tags: body.tags,
        allowed_vendors: body.allowed_vendors,
      };

      const memory = updateMemory(db, request.userId, id, input);
      if (!memory) {
        reply.code(404);
        return { error: "Memory not found" };
      }
      return memory;
    },
  );

  // ===========================================================================
  // DELETE /memories/:id — Soft delete (move to trash)
  // ===========================================================================
  // Sets deleted_at. Memory can be restored within 30 days.
  // ===========================================================================

  server.delete(
    "/memories/:id",
    {
      schema: {
        params: memoryIdParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const memory = softDeleteMemory(db, request.userId, id);
      if (!memory) {
        reply.code(404);
        return { error: "Memory not found" };
      }
      return memory;
    },
  );

  // ===========================================================================
  // POST /memories/:id/restore — Restore from trash
  // ===========================================================================

  server.post(
    "/memories/:id/restore",
    {
      schema: {
        params: memoryIdParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const memory = restoreMemory(db, request.userId, id);
      if (!memory) {
        reply.code(404);
        return { error: "Memory not found or not in trash" };
      }
      return memory;
    },
  );

  // ===========================================================================
  // POST /query — AI query with explicit memory selection
  // ===========================================================================
  // Vendor filtering is determined by the caller's auth key:
  // - User key: no vendor filter (sees all memories)
  // - Agent key: filters memories by allowed_vendors containing "*" or that vendor
  // ===========================================================================

  server.post(
    "/query",
    {
      schema: {
        body: queryBodySchema,
      },
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { query, memory_filter, limit } = request.body as {
        query: string;
        memory_filter: MemoryFilter;
        limit?: number;
      };

      if (memory_filter.by === "trashed") {
        reply.code(400);
        return { error: "Cannot use trashed memories as query context" };
      }

      const vendorFilter = request.vendor;
      const AGENT_DEFAULT_LIMIT = 5;
      const HARD_CEILING = 50;
      const effectiveLimit = Math.min(
        limit ?? (request.role === "agent" ? AGENT_DEFAULT_LIMIT : HARD_CEILING),
        HARD_CEILING,
      );
      const pagination: PaginationOptions = { limit: effectiveLimit };
      const memoriesUsed = listMemories(db, request.userId, memory_filter, vendorFilter, pagination);
      const promptResult = buildPrompt(memoriesUsed, query, systemPrompt, contextCharBudget);

      let response: string;
      try {
        response = await callModel(modelGateway, promptResult.prompt);
      } catch (error) {
        console.error("[query] Model call failed:", error);
        reply.code(502);
        return { error: "Model API call failed" };
      }

      // Agents get a slim receipt — no full prompt or memory objects echoed back.
      // This keeps the response small enough for ChatGPT Custom Actions to handle.
      if (request.role === "agent") {
        const agentReceipt: AgentQueryReceipt = {
          response,
          memories_used_count: memoriesUsed.length,
          memories_included_in_prompt: promptResult.memoriesIncluded,
          truncated: promptResult.truncated,
          estimated_tokens: promptResult.estimatedTokens,
          vendor_filter: vendorFilter,
        };
        return agentReceipt;
      }

      const receipt: QueryReceipt = {
        response,
        memories_used: memoriesUsed,
        prompt_sent: promptResult.prompt,
        model_config: getConfigReceipt(modelGateway),
        vendor_filter: vendorFilter,
        truncated: promptResult.truncated,
        memories_included: promptResult.memoriesIncluded,
        memories_total: promptResult.memoriesTotal,
      };

      return receipt;
    },
  );

  // ===========================================================================
  // GET /chat/models — Available chat models
  // ===========================================================================
  // Returns models that have API keys configured. Dashboard uses this to
  // populate the model selector.
  // ===========================================================================

  server.get("/chat/models", async () => {
    const available = AVAILABLE_MODELS.filter((m) => {
      switch (m.id) {
        case "gpt-4o":
        case "gpt-4o-mini":
          return !!chatProviders.openaiKey;
        case "claude-sonnet-4":
          return !!chatProviders.anthropicKey;
        case "gemini-2.0-flash":
          return !!chatProviders.googleKey;
        case "perplexity-sonar":
          return !!chatProviders.perplexityKey;
        case "grok-3-mini":
          return !!chatProviders.xaiKey;
        default:
          return false;
      }
    });
    return { models: available.map((m) => ({ id: m.id, label: m.label })) };
  });

  // ===========================================================================
  // POST /chat — Multi-model chat with Reflect Memory tool calling
  // ===========================================================================
  // User-only. Agents cannot use this endpoint.
  // The model reads/writes memories mid-conversation via server-side tools.
  // ===========================================================================

  const chatBodySchema = {
    type: "object" as const,
    required: ["model", "messages"],
    additionalProperties: false,
    properties: {
      model: { type: "string" as const, minLength: 1, maxLength: 50 },
      messages: {
        type: "array" as const,
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object" as const,
          required: ["role", "content"],
          additionalProperties: false,
          properties: {
            role: { type: "string" as const, enum: ["user", "assistant"] },
            content: { type: "string" as const, maxLength: 50_000 },
          },
        },
      },
    },
  };

  server.post(
    "/chat",
    {
      schema: { body: chatBodySchema },
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (request.role !== "user") {
        reply.code(403);
        return { error: "Chat endpoint is user-only" };
      }

      const { model, messages } = request.body as {
        model: string;
        messages: ChatMessage[];
      };

      try {
        const result = await chat(model, messages, db, request.userId, chatProviders);
        return result;
      } catch (error) {
        console.error("[chat] Chat failed:", error);
        reply.code(502);
        return { error: "Chat failed" };
      }
    },
  );

  return server;
}
