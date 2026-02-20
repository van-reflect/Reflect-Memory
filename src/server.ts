// Reflect Memory — HTTP API Layer
// Fastify server with memory CRUD routes and AI query route.
// No UI. No logging. No default behavior.
// Every request requires auth and explicit intent.

import Fastify, { type FastifyInstance } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import {
  createMemory,
  readMemoryById,
  listMemories,
  updateMemory,
  deleteMemory,
  type MemoryEntry,
  type CreateMemoryInput,
  type UpdateMemoryInput,
  type MemoryFilter,
} from "./memory-service.js";
import { buildPrompt } from "./context-builder.js";
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
    /** Set by the auth hook after successful API key validation. */
    userId: string;
  }
}

// =============================================================================
// Application types
// =============================================================================

/**
 * Returned by POST /query. Contains everything needed to understand
 * what the AI saw and how it was configured (Invariant 5).
 *
 * Every field is mandatory — the type system makes "response without
 * explanation" unrepresentable.
 */
export interface QueryReceipt {
  /** The model's raw text response. */
  response: string;
  /** Full content of each memory entry as it was at query time. */
  memories_used: MemoryEntry[];
  /** The exact assembled prompt string sent to the model. */
  prompt_sent: string;
  /** Model provider, name, and parameters. No secrets. */
  model_config: ModelConfigReceipt;
}

// =============================================================================
// Server config
// =============================================================================

/** All dependencies are injected explicitly. No globals, no singletons. */
export interface ServerConfig {
  db: Database.Database;
  apiKey: string;
  userId: string;
  modelGateway: ModelGatewayConfig;
  systemPrompt: string;
}

// =============================================================================
// Auth helper
// =============================================================================

/**
 * Timing-safe string comparison. Both inputs are hashed to SHA-256 first,
 * producing fixed-length 32-byte digests. This prevents:
 * - Timing attacks (timingSafeEqual compares in constant time)
 * - Length leakage (both hashes are always 32 bytes regardless of input length)
 */
function constantTimeEqual(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

// =============================================================================
// JSON Schemas for request validation
// =============================================================================
// Fastify validates every request against these schemas before the handler runs.
// If validation fails, Fastify returns 400 automatically. The handler never
// sees invalid input.
//
// Key properties enforced:
// - additionalProperties: false — rejects unexpected fields
// - minLength: 1 — rejects empty strings
// - required — every field is mandatory, no optional fields
// - const — discriminated union tags match exactly one value
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

// Shared filter schema — used in both POST /memories/list and POST /query.
// Defined once to avoid divergence.
//
// Uses the discriminator keyword so Ajv resolves the correct oneOf branch
// by inspecting "by" directly, instead of testing all branches sequentially.
// Each branch must: (1) require "by", (2) define "by" with a const value.
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
  ],
};

const listFilterBodySchema = {
  type: "object" as const,
  required: ["filter"],
  additionalProperties: false,
  properties: {
    filter: memoryFilterSchema,
  },
};

const queryBodySchema = {
  type: "object" as const,
  required: ["query", "memory_filter"],
  additionalProperties: false,
  properties: {
    query: { type: "string" as const, minLength: 1 },
    memory_filter: memoryFilterSchema,
  },
};

// =============================================================================
// Server factory
// =============================================================================

export function createServer(config: ServerConfig): FastifyInstance {
  const { db, apiKey, userId, modelGateway, systemPrompt } = config;

  // Ajv customization:
  // - discriminator: true — enables the JSON Schema discriminator keyword so
  //   oneOf branches are resolved by inspecting a single property value, not
  //   by testing (and mutating) every branch sequentially.
  // - removeAdditional: false — Fastify defaults this to true, which causes
  //   Ajv to silently strip properties not listed in the current schema's
  //   `properties`. Combined with oneOf, this mutates the input while
  //   evaluating non-matching branches, destroying valid data before the
  //   correct branch is reached. Setting to false means extra properties
  //   are REJECTED (via additionalProperties: false), not silently eaten.
  //   This also aligns with Invariant 1: no silent behavior.
  const server = Fastify({
    ajv: {
      customOptions: {
        discriminator: true,
        removeAdditional: false,
      },
    },
  });

  // Register the userId property on the request prototype.
  // This is required by Fastify's decoration system before it can be set in hooks.
  server.decorateRequest("userId", "");

  // ===========================================================================
  // Auth hook
  // ===========================================================================
  // Runs before every route handler, before body parsing.
  // Validates the API key from the Authorization header.
  // On failure: returns 401 immediately, handler never runs.
  // On success: sets request.userId for use in handlers.
  // ===========================================================================

  server.addHook("onRequest", async (request, reply) => {
    const header = request.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) {
      return reply.code(401).send({
        error: "Missing or malformed Authorization header. Expected: Bearer <api_key>",
      });
    }

    const token = header.slice("Bearer ".length);

    if (token.length === 0 || !constantTimeEqual(token, apiKey)) {
      return reply.code(401).send({ error: "Invalid API key" });
    }

    request.userId = userId;
  });

  // ===========================================================================
  // POST /memories — Create a memory
  // ===========================================================================
  // Requires: title, content, tags (all mandatory, no defaults).
  // Returns: 201 with the complete created entry.
  // Rejects: any missing field (400), any extra field (400).
  // ===========================================================================

  server.post(
    "/memories",
    {
      schema: {
        body: memoryBodySchema,
      },
    },
    async (request, reply) => {
      const input = request.body as CreateMemoryInput;
      const memory = createMemory(db, request.userId, input);
      reply.code(201);
      return memory;
    },
  );

  // ===========================================================================
  // GET /memories/:id — Read a single memory by primary key
  // ===========================================================================
  // Requires: id in URL path.
  // Returns: 200 with the entry, or 404 if not found / not owned.
  // The handler never reveals whether the ID exists for another user.
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
  // Uses POST (not GET) because the filter is a structured JSON body with a
  // discriminated union — not representable as clean query parameters.
  //
  // The filter is required and must be one of:
  //   { "by": "all" }
  //   { "by": "tags", "tags": ["tag1", "tag2"] }
  //   { "by": "ids", "ids": ["id1", "id2"] }
  //
  // No filter = 400 (not "return everything").
  // Empty tags/ids array = 400 (minItems: 1). Use { "by": "all" } if you
  // want everything — say it explicitly.
  // ===========================================================================

  server.post(
    "/memories/list",
    {
      schema: {
        body: listFilterBodySchema,
      },
    },
    async (request) => {
      const { filter } = request.body as { filter: MemoryFilter };
      const memories = listMemories(db, request.userId, filter);
      return { memories };
    },
  );

  // ===========================================================================
  // PUT /memories/:id — Update a memory (full replacement)
  // ===========================================================================
  // Requires: id in URL path, plus title, content, tags in body.
  // This is a full replacement. Every field must be provided.
  // No PATCH, no partial merge, no "send only what changed."
  // Returns: 200 with the updated entry, or 404 if not found / not owned.
  // ===========================================================================

  server.put(
    "/memories/:id",
    {
      schema: {
        params: memoryIdParamSchema,
        body: memoryBodySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const input = request.body as UpdateMemoryInput;
      const memory = updateMemory(db, request.userId, id, input);
      if (!memory) {
        reply.code(404);
        return { error: "Memory not found" };
      }
      return memory;
    },
  );

  // ===========================================================================
  // DELETE /memories/:id — Hard delete by primary key
  // ===========================================================================
  // Requires: id in URL path.
  // Returns: 204 No Content on success, 404 if not found / not owned.
  // After success, the row is gone. No soft delete. No tombstone.
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
      const deleted = deleteMemory(db, request.userId, id);
      if (!deleted) {
        reply.code(404);
        return { error: "Memory not found" };
      }
      return reply.code(204).send();
    },
  );

  // ===========================================================================
  // POST /query — AI query with explicit memory selection
  // ===========================================================================
  // The AI query path. Strict one-directional data flow:
  //
  //   1. Validate request (Fastify schema)
  //   2. Fetch memories via Memory Service (read only)
  //   3. Assemble prompt via Context Builder (pure function, Invariant 3)
  //   4. Call model via Model Gateway (stateless, no write path, Invariant 4)
  //   5. Return QueryReceipt (deterministic visibility, Invariant 5)
  //
  // The model's response is never fed back into the Memory Service.
  // The receipt is never persisted. Nothing is written. Nothing is logged.
  // ===========================================================================

  server.post(
    "/query",
    {
      schema: {
        body: queryBodySchema,
      },
    },
    async (request, reply) => {
      const { query, memory_filter } = request.body as {
        query: string;
        memory_filter: MemoryFilter;
      };

      // Step 1: Fetch memories based on the user's explicit filter.
      // This is a read from the Memory Service — the only data access in this path.
      const memoriesUsed = listMemories(db, request.userId, memory_filter);

      // Step 2: Assemble the prompt. Pure function — no I/O, no side effects.
      // The inputs are captured here for the receipt.
      const promptSent = buildPrompt(memoriesUsed, query, systemPrompt);

      // Step 3: Call the model. Prompt in, text out. No write path back.
      let response: string;
      try {
        response = await callModel(modelGateway, promptSent);
      } catch (error) {
        reply.code(502);
        return {
          error: "Model API call failed",
          detail: error instanceof Error ? error.message : "Unknown error",
        };
      }

      // Step 4: Build and return the QueryReceipt.
      // Every field is populated from values already computed above.
      // No additional fetches, no side effects, no persistence.
      const receipt: QueryReceipt = {
        response,
        memories_used: memoriesUsed,
        prompt_sent: promptSent,
        model_config: getConfigReceipt(modelGateway),
      };

      return receipt;
    },
  );

  return server;
}
