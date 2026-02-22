// Reflect Memory — HTTP API Layer
// Fastify server with memory CRUD, agent connector, and AI query route.
// No UI. No logging. No default behavior.
// Every request requires auth and explicit intent.

import Fastify, { type FastifyInstance } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
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

// =============================================================================
// Type augmentation
// =============================================================================

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
    role: "user" | "agent";
    vendor: string | null;
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
    title: { type: "string" as const, minLength: 1 },
    content: { type: "string" as const, minLength: 1 },
    tags: {
      type: "array" as const,
      items: { type: "string" as const, minLength: 1 },
    },
    allowed_vendors: {
      type: "array" as const,
      items: { type: "string" as const, minLength: 1 },
      minItems: 1,
    },
  },
};

const agentMemoryBodySchema = {
  type: "object" as const,
  required: ["title", "content", "tags", "allowed_vendors"],
  additionalProperties: false,
  properties: {
    title: { type: "string" as const, minLength: 1 },
    content: { type: "string" as const, minLength: 1 },
    tags: {
      type: "array" as const,
      items: { type: "string" as const, minLength: 1 },
    },
    allowed_vendors: {
      type: "array" as const,
      items: { type: "string" as const, minLength: 1 },
      minItems: 1,
    },
  },
};

const updateMemoryBodySchema = {
  type: "object" as const,
  required: ["title", "content", "tags", "allowed_vendors"],
  additionalProperties: false,
  properties: {
    title: { type: "string" as const, minLength: 1 },
    content: { type: "string" as const, minLength: 1 },
    tags: {
      type: "array" as const,
      items: { type: "string" as const, minLength: 1 },
    },
    allowed_vendors: {
      type: "array" as const,
      items: { type: "string" as const, minLength: 1 },
      minItems: 1,
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
        term: { type: "string" as const, minLength: 1 },
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
    query: { type: "string" as const, minLength: 1 },
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

export function createServer(config: ServerConfig): FastifyInstance {
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
  } = config;

  const server = Fastify({
    ajv: {
      customOptions: {
        discriminator: true,
        removeAdditional: false,
      },
    },
  });

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

  server.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;

    const header = request.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) {
      return reply.code(401).send({
        error: "Missing or malformed Authorization header. Expected: Bearer <api_key>",
      });
    }

    const token = header.slice("Bearer ".length);
    if (token.length === 0) {
      return reply.code(401).send({ error: "Empty API key" });
    }

    // Try user key first.
    if (constantTimeEqual(token, apiKey)) {
      request.userId = userId;
      request.role = "user";
      request.vendor = null;
      return;
    }

    // Try each agent key. Timing-safe comparison for every configured vendor.
    for (const [vendor, key] of Object.entries(agentKeys)) {
      if (constantTimeEqual(token, key)) {
        request.userId = userId;
        request.role = "agent";
        request.vendor = vendor;

        // Enforce agent route restrictions.
        const path = request.url.split("?")[0];
        const allowed =
          path === "/health" ||
          path === "/whoami" ||
          path === "/query" ||
          path.startsWith("/agent/");
        if (!allowed) {
          return reply.code(403).send({
            error: "Agent keys cannot access this endpoint",
          });
        }

        return;
      }
    }

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
        origin: "user",
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
        reply.code(502);
        return {
          error: "Model API call failed",
          detail: error instanceof Error ? error.message : "Unknown error",
        };
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

  return server;
}
