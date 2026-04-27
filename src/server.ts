// Reflect Memory -- HTTP API Layer
// Fastify server with memory CRUD, agent connector, and AI query route.
// No UI. No logging. No default behavior.
// Every request requires auth and explicit intent.

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import proxy from "@fastify/http-proxy";
import formbody from "@fastify/formbody";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { jwtVerify } from "jose";
import type Database from "better-sqlite3";
import {
  findOrCreateUserByEmail,
  getUserById,
  updateUserName,
  addUserToTeam,
  removeUserFromTeam,
  getTeamMembers,
  getTeamMemberCount,
} from "./user-service.js";
import type { DeploymentConfig } from "./deployment-config.js";
import type { EventBroker, EventClient, MemoryEvent, MemoryEventType } from "./event-broker.js";
import { createSsoVerifier, validateSsoConfig } from "./sso-auth.js";
import { recordAuditEvent, queryAuditEvents, countAuditEvents, exportAuditEvents } from "./audit-service.js";
import { buildLogExport, logExportFilename } from "./log-export-service.js";
import {
  generateApiKey,
  listApiKeys,
  revokeApiKey,
  authenticateApiKey,
  countActiveApiKeys,
} from "./api-key-service.js";
import {
  isStripeConfigured,
  createCheckoutSession,
  createBillingPortalSession,
  handleStripeWebhook,
  constructStripeEvent,
  syncPlanFromStripe,
  PLAN_LIMITS,
} from "./billing-service.js";
import {
  recordUsage,
  checkQuota,
  getUsageForMonth,
  type Operation,
} from "./usage-service.js";
import {
  createMemory,
  readMemoryById,
  readMemoryWithTeamAccess,
  listMemories,
  listMemorySummaries,
  countMemories,
  updateMemory,
  softDeleteMemory,
  restoreMemory,
  deleteMemory,
  emptyTrash,
  type MemoryEntry,
  type CreateMemoryInput,
  type UpdateMemoryInput,
  type MemoryFilter,
  type MemoryType,
  type PaginationOptions,
  shareMemoryToTeam,
  unshareMemory,
  listTeamMemories,
  countTeamMemories,
  searchTeamMemories,
  countSearchTeamMemories,
  getVersionHistory,
  createChildMemory,
  listChildren,
  cascadeSoftDelete,
  cascadeRestore,
  cascadeHardDelete,
  cascadeShare,
  cascadeUnshare,
  ThreadingError,
} from "./memory-service.js";
import { buildMemoryBriefing, formatBriefingAsMarkdown } from "./memory-briefing.js";
import { getTagCooccurrence } from "./memory-graph.js";
import { clusterTags } from "./tag-clustering.js";
import { nameClusters } from "./cluster-naming.js";
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
// Welcome memory content (seeded on first signup via Clerk webhook)
// =============================================================================

const WELCOME_MEMORY_CONTENT = `Welcome to Reflect Memory \u2014 your AI now remembers across every tool you use.

This is your first memory. It's already saved and available from any AI you connect.

AVAILABLE COMMANDS (use these in any connected AI):
\u2022 "pull latest memory" \u2192 retrieves your most recent memory
\u2022 "write this to memory: [anything]" \u2192 saves a new memory
\u2022 "search memories for [topic]" \u2192 finds relevant memories
\u2022 "browse memories" \u2192 see summaries of all your memories
\u2022 "get memories tagged [tag]" \u2192 filter by tags
\u2022 "read team memories" \u2192 see your team's shared knowledge
\u2022 "share memory" \u2192 share a personal memory with your team

TRY IT NOW:
1. Connect an AI tool (Claude, ChatGPT, or Cursor) using the setup cards on your dashboard
2. Open that AI and type: "pull latest memory"
3. You should see this welcome memory appear \u2014 proof it works
4. Now type: "write this to memory: [anything you're working on]"
5. Go to a DIFFERENT AI tool and type: "pull latest memory"
6. Your memory is already there. Across tools. Instantly.

That's it. Your AI remembers you now.`;

// =============================================================================
// Type augmentation
// =============================================================================

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
    role: "user" | "agent";
    vendor: string | null;
    authMethod: "dashboard" | "api_key" | "agent_key" | "sso" | "oauth";
    dataAccessed: boolean;
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
  /** Primary owner user ID. Used for orphan consolidation and legacy single-tenant paths. */
  userId: string;
  /** Full set of admin user IDs (superset of `userId`). Used for /admin/* authorization. */
  ownerUserIds: Set<string>;
  /** In-memory event broker for SSE realtime updates. */
  eventBroker: EventBroker;
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
  deployment: DeploymentConfig;
  chatgptClientId: string | null;
  chatgptClientSecret: string | null;
  /**
   * When true, the CI-test-memory quarantine guard (isCiTestMemory) is bypassed
   * so integration tests can write + read back memories with CI-looking titles.
   * MUST be false in production — entrypoint asserts NODE_ENV!=='production'.
   */
  testMode: boolean;
}

// =============================================================================
// Auth helper
// =============================================================================

function constantTimeEqual(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/** Detects CI integration test memories for auto-trash. */
// CI-test-memory pattern matcher lives in src/quarantine.ts so it can be unit-tested
// without booting the Fastify server.
import { isCiTestMemory } from "./quarantine.js";

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
    memory_type: {
      type: "string" as const,
      enum: ["semantic", "episodic", "procedural"],
      default: "semantic",
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
    origin: { type: "string" as const, minLength: 1, maxLength: 50 },
    memory_type: {
      type: "string" as const,
      enum: ["semantic", "episodic", "procedural"],
      default: "semantic",
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
    memory_type: {
      type: "string" as const,
      enum: ["semantic", "episodic", "procedural"],
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
      required: ["by", "origin"],
      additionalProperties: false,
      properties: {
        by: { type: "string" as const, const: "origin" },
        origin: { type: "string" as const, minLength: 1, maxLength: 50 },
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
    ownerUserIds,
    eventBroker,
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
    deployment,
    testMode,
  } = config;

  // Helper: resolve the team_id for a user (used to scope emit() and subscribe()).
  function getUserTeamId(uid: string): string | null {
    const row = db
      .prepare("SELECT team_id FROM users WHERE id = ?")
      .get(uid) as { team_id: string | null } | undefined;
    return row?.team_id ?? null;
  }

  // Helper: fetch a memory row for inclusion in the event payload.
  function fetchMemoryForEvent(memoryId: string): unknown | null {
    try {
      const row = db
        .prepare(
          `SELECT id, user_id, title, content, tags, origin, allowed_vendors,
                  created_at, updated_at, deleted_at, shared_with_team_id, shared_at
           FROM memories WHERE id = ?`,
        )
        .get(memoryId) as Record<string, unknown> | undefined;
      if (!row) return null;
      if (typeof row.tags === "string") row.tags = JSON.parse(row.tags) as string[];
      if (typeof row.allowed_vendors === "string")
        row.allowed_vendors = JSON.parse(row.allowed_vendors) as string[];
      return row;
    } catch {
      return null;
    }
  }

  // Helper: emit a memory event to the owner's channel (+ team channel if provided).
  function emitMemoryEvent(
    type: MemoryEventType,
    ownerUserId: string,
    memoryId: string,
    opts: { teamId?: string | null; includeBody?: boolean } = {},
  ): void {
    const event: MemoryEvent = {
      type,
      memory_id: memoryId,
      user_id: ownerUserId,
      team_id: opts.teamId ?? null,
      memory: opts.includeBody === false ? undefined : fetchMemoryForEvent(memoryId),
      emitted_at: new Date().toISOString(),
    };
    eventBroker.emit({ userId: ownerUserId, teamId: opts.teamId ?? null }, event);
  }

  const server = Fastify({
    bodyLimit: 262_144,
    ajv: {
      customOptions: {
        discriminator: true,
        removeAdditional: false,
      },
    },
  });

  server.addHook("preParsing", async (request, _reply, payload) => {
    if (!request.url?.startsWith("/webhooks/")) return payload;
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks);
    (request as unknown as { rawBody: string }).rawBody = raw.toString("utf-8");
    const { Readable } = await import("stream");
    return Readable.from(raw);
  });

  // ---------------------------------------------------------------------------
  // Global error handler: never leak stack traces or internal details
  // ---------------------------------------------------------------------------
  server.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      console.error(`[server] Unhandled error: ${error.message}`, error.stack);
    }
    if (reply.sent) return;
    reply.code(statusCode).send({
      error: statusCode >= 500 ? "Internal server error" : error.message,
    });
  });

  // ---------------------------------------------------------------------------
  // Security headers (HSTS, sniff protection, etc.)
  // ---------------------------------------------------------------------------
  server.addHook("onSend", async (_request, reply) => {
    reply.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
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

  await server.register(formbody);

  // Global rate limit: 100 req/min per IP. Skipped in test mode so an integration
  // suite of dozens of POSTs/sec doesn't hit per-route 1-minute caps.
  if (!testMode) {
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
  }

  // Proxy /mcp and OAuth endpoints to the MCP server (Railway exposes only one port)
  if (mcpPort != null) {
    const mcpUpstream = `http://127.0.0.1:${mcpPort}`;

    await server.register(async (mcpProxyScope) => {
      // Root @fastify/formbody parses application/x-www-form-urlencoded into objects, and
      // that parser inherits into encapsulated routes. @fastify/reply-from (used by the
      // MCP proxy) then calls Buffer.byteLength on the parsed object when forwarding POST
      // bodies, which throws ERR_INVALID_ARG_TYPE and yields 500 on OAuth token exchange.
      // Parse URL-encoded bodies as raw strings in this subtree only so the proxy forwards
      // a string/buffer upstream (see MCP SDK token handler: urlencoded grant_type, etc.).
      mcpProxyScope.removeContentTypeParser("application/x-www-form-urlencoded");
      mcpProxyScope.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        async (_req: FastifyRequest, body: string) => body,
      );

      await mcpProxyScope.register(proxy, {
        upstream: mcpUpstream,
        prefix: "/mcp",
        rewritePrefix: "/mcp",
        undici: {
          bodyTimeout: 0,
          headersTimeout: 0,
        },
      });

      // OAuth discovery and auth endpoints served by the MCP server's mcpAuthRouter.
      // PRM is path-aware per RFC 9728: /.well-known/oauth-protected-resource/mcp
      const oauthPaths = [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-authorization-server",
        "/authorize",
        "/token",
        "/register",
        "/oauth/approve",
        "/oauth/approve-s2s",
        "/oauth/status",
      ];
      for (const oauthPath of oauthPaths) {
        await mcpProxyScope.register(proxy, {
          upstream: mcpUpstream,
          prefix: oauthPath,
          rewritePrefix: oauthPath,
        });
      }
    });
  }

  // ===========================================================================
  // ChatGPT OAuth 2.0 (standard auth-code flow, no PKCE)
  // Separate from MCP's OAuth 2.1 which requires PKCE.
  // ===========================================================================

  const { chatgptClientId, chatgptClientSecret } = config;

  if (chatgptClientId && chatgptClientSecret) {
    const chatgptSecretHash = createHash("sha256").update(chatgptClientSecret).digest("hex");

    // Auto-register the ChatGPT OAuth client if it doesn't exist
    const existingClient = db
      .prepare(`SELECT client_id FROM oauth_clients WHERE client_id = ?`)
      .get(chatgptClientId);
    if (!existingClient) {
      db.prepare(
        `INSERT INTO oauth_clients (client_id, client_secret, client_secret_hash, redirect_uris, client_name, grant_types, response_types, scope, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        chatgptClientId,
        null,
        chatgptSecretHash,
        JSON.stringify(["https://chat.openai.com/aip/g-*/oauth/callback", "https://chatgpt.com/aip/g-*/oauth/callback"]),
        "ChatGPT",
        JSON.stringify(["authorization_code", "refresh_token"]),
        JSON.stringify(["code"]),
        "memory:read memory:write",
        new Date().toISOString(),
      );
      console.log(`[oauth-chatgpt] Registered ChatGPT client: ${chatgptClientId}`);
    }

    const dashboardUrl = config.dashboardServiceKey
      ? (process.env.RM_DASHBOARD_URL || "https://reflectmemory.com")
      : "https://reflectmemory.com";

    // GET /chatgpt/authorize -- Authorization endpoint for ChatGPT OAuth
    server.get("/chatgpt/authorize", async (request, reply) => {
      const query = request.query as Record<string, string>;
      const { client_id, redirect_uri, state, scope, response_type } = query;

      if (response_type !== "code") {
        return reply.code(400).send({ error: "Unsupported response_type" });
      }
      if (client_id !== chatgptClientId) {
        return reply.code(400).send({ error: "Unknown client_id" });
      }

      const pendingId = randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);

      db.prepare(
        `INSERT INTO oauth_pending_requests (id, client_id, client_name, redirect_uri, code_challenge, scopes, state, resource, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        pendingId,
        client_id,
        "ChatGPT",
        redirect_uri || "",
        "none",
        JSON.stringify(scope ? scope.split(" ") : []),
        state || null,
        null,
        expiresAt.toISOString(),
        now.toISOString(),
      );

      const consentUrl = new URL(`${dashboardUrl}/oauth/consent`);
      consentUrl.searchParams.set("pending_id", pendingId);
      consentUrl.searchParams.set("client_name", "ChatGPT");

      return reply.code(302).redirect(consentUrl.toString());
    });

    // POST /chatgpt/token -- Token endpoint for ChatGPT OAuth
    server.post("/chatgpt/token", async (request, reply) => {
      const body = request.body as Record<string, string>;
      const { grant_type, code, refresh_token, client_id, client_secret, redirect_uri } = body;

      if (client_id !== chatgptClientId) {
        return reply.code(401).send({ error: "invalid_client" });
      }
      const providedHash = createHash("sha256").update(client_secret || "").digest("hex");
      if (providedHash !== chatgptSecretHash) {
        return reply.code(401).send({ error: "invalid_client" });
      }

      if (grant_type === "authorization_code") {
        if (!code) {
          return reply.code(400).send({ error: "invalid_request", error_description: "Missing code" });
        }
        const codeRow = db
          .prepare(`SELECT * FROM oauth_codes WHERE code = ? AND client_id = ?`)
          .get(code, client_id) as Record<string, string> | undefined;

        if (!codeRow) {
          return reply.code(400).send({ error: "invalid_grant" });
        }
        if (new Date(codeRow.expires_at) < new Date()) {
          db.prepare(`DELETE FROM oauth_codes WHERE code = ?`).run(code);
          return reply.code(400).send({ error: "invalid_grant", error_description: "Code expired" });
        }

        db.prepare(`DELETE FROM oauth_codes WHERE code = ?`).run(code);

        const accessToken = `rma_${randomUUID().replace(/-/g, "")}`;
        const refreshTkn = `rmr_${randomUUID().replace(/-/g, "")}`;
        const now = new Date();
        const accessExpiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const refreshExpiry = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
        const tokenUserId = codeRow.user_id || null;

        db.prepare(
          `INSERT INTO oauth_tokens (token, token_type, client_id, user_id, scopes, resource, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(accessToken, "access", client_id, tokenUserId, codeRow.scopes || "[]", null, accessExpiry.toISOString(), now.toISOString());
        db.prepare(
          `INSERT INTO oauth_tokens (token, token_type, client_id, user_id, scopes, resource, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(refreshTkn, "refresh", client_id, tokenUserId, codeRow.scopes || "[]", null, refreshExpiry.toISOString(), now.toISOString());

        return reply.send({
          access_token: accessToken,
          token_type: "bearer",
          expires_in: 604800,
          refresh_token: refreshTkn,
        });
      }

      if (grant_type === "refresh_token") {
        if (!refresh_token) {
          return reply.code(400).send({ error: "invalid_request", error_description: "Missing refresh_token" });
        }
        const rtRow = db
          .prepare(`SELECT * FROM oauth_tokens WHERE token = ? AND token_type = 'refresh' AND client_id = ?`)
          .get(refresh_token, client_id) as Record<string, string> | undefined;

        if (!rtRow) {
          return reply.code(400).send({ error: "invalid_grant" });
        }
        if (rtRow.expires_at && new Date(rtRow.expires_at) < new Date()) {
          db.prepare(`DELETE FROM oauth_tokens WHERE token = ?`).run(refresh_token);
          return reply.code(400).send({ error: "invalid_grant", error_description: "Refresh token expired" });
        }

        db.prepare(`DELETE FROM oauth_tokens WHERE token = ?`).run(refresh_token);

        const newAccess = `rma_${randomUUID().replace(/-/g, "")}`;
        const newRefresh = `rmr_${randomUUID().replace(/-/g, "")}`;
        const now = new Date();
        const accessExpiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const refreshExpiry = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

        db.prepare(
          `INSERT INTO oauth_tokens (token, token_type, client_id, user_id, scopes, resource, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(newAccess, "access", client_id, rtRow.user_id || null, rtRow.scopes || "[]", null, accessExpiry.toISOString(), now.toISOString());
        db.prepare(
          `INSERT INTO oauth_tokens (token, token_type, client_id, user_id, scopes, resource, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(newRefresh, "refresh", client_id, rtRow.user_id || null, rtRow.scopes || "[]", null, refreshExpiry.toISOString(), now.toISOString());

        return reply.send({
          access_token: newAccess,
          token_type: "bearer",
          expires_in: 604800,
          refresh_token: newRefresh,
        });
      }

      return reply.code(400).send({ error: "unsupported_grant_type" });
    });

    console.log("[oauth-chatgpt] ChatGPT OAuth endpoints registered: /chatgpt/authorize, /chatgpt/token");
  }

  server.decorateRequest("userId", "");
  server.decorateRequest("role", "user");
  server.decorateRequest("vendor", null);
  server.decorateRequest("authMethod", "api_key");
  server.decorateRequest("dataAccessed", false);

  const verifySsoToken = createSsoVerifier(deployment.sso);

  const ssoWarnings = validateSsoConfig(deployment.sso);
  for (const w of ssoWarnings) {
    console.warn(`[SSO] ${w}`);
  }

  // ===========================================================================
  // Auth hook
  // ===========================================================================
  // Resolves caller identity from the Authorization header.
  // Sets role ("user" or "agent") and vendor (null for users, vendor name for agents).
  // Enforces route restrictions: agents can only hit /agent/*, /query, /whoami, /health.
  // ===========================================================================

  function logSecurity(
    event: string,
    request: { ip: string; url: string; method: string; headers?: Record<string, unknown>; userId?: string },
    extra?: Record<string, unknown>,
  ) {
    const requestIdHeader = request.headers?.["x-request-id"];
    const requestId =
      typeof requestIdHeader === "string" && requestIdHeader.trim().length > 0
        ? requestIdHeader.trim()
        : null;
    const entry = {
      event,
      ip: request.ip,
      method: request.method,
      path: request.url.split("?")[0],
      request_id: requestId,
      time: new Date().toISOString(),
      ...extra,
    };
    console.log(`[security] ${JSON.stringify(entry)}`);
    try {
      recordAuditEvent(db, {
        userId: request.userId ?? null,
        eventType: `security.${event}`,
        severity: "warn",
        authMethod: extra?.auth_method as string | undefined,
        path: entry.path,
        statusCode: typeof extra?.status_code === "number" ? (extra.status_code as number) : null,
        ip: request.ip,
        requestId,
        metadata: extra ?? null,
      });
    } catch {
      // Never block request path on audit write failure.
    }
  }

  server.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (path === "/health" || path === "/openapi.json" || path === "/favicon.ico" || path === "/icon.png") return;
    if (request.method === "GET" && path.startsWith("/teams/invite/")) return;
    if (request.method === "POST" && (path === "/waitlist" || path === "/early-access" || path === "/integration-requests")) return;
    if (deployment.allowPublicWebhooks && request.method === "POST" && path === "/webhooks/clerk") return;
    if (deployment.allowPublicWebhooks && request.method === "POST" && path === "/webhooks/stripe") return;

    // OAuth + MCP paths are handled by the MCP server's own auth middleware via proxy
    if (path.startsWith("/.well-known/oauth-")) return;
    if (path.startsWith("/oauth/")) return;
    if (path === "/authorize" || path === "/token" || path === "/register" || path.startsWith("/mcp")) {
      return;
    }
    // ChatGPT OAuth endpoints are handled by their own routes (no bearer auth)
    if (path === "/chatgpt/authorize" || path === "/chatgpt/token") return;

    const header = request.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) {
      logSecurity("auth_missing", request, { status_code: 401 });
      return reply.code(401).send({
        error: "Missing or malformed Authorization header. Expected: Bearer <api_key>",
      });
    }

    const token = header.slice("Bearer ".length);
    if (token.length === 0) {
      logSecurity("auth_empty", request, { status_code: 401 });
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
        logSecurity("dashboard_token_missing", request, { status_code: 401, auth_method: "dashboard" });
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
          logSecurity("dashboard_token_invalid", request, { status_code: 401, auth_method: "dashboard" });
          return reply.code(401).send({ error: "Invalid dashboard token" });
        }
        request.userId = findOrCreateUserByEmail(db, email);
        request.role = "user";
        request.vendor = null;
        request.authMethod = "dashboard";
        return;
      } catch (err) {
        const msg = (err as Error).message || "";
        if (msg.includes("Seat limit reached")) {
          logSecurity("seat_limit_reached", request, { status_code: 403, auth_method: "dashboard" });
          return reply.code(403).send({ error: msg });
        }
        logSecurity("dashboard_token_expired", request, { status_code: 401, auth_method: "dashboard" });
        return reply.code(401).send({ error: "Invalid or expired dashboard token" });
      }
    }

    if (deployment.sso.enabled && token.includes(".") && token.split(".").length === 3) {
      const ssoResult = await verifySsoToken(token);
      if (ssoResult.identity) {
        try {
          request.userId = findOrCreateUserByEmail(db, ssoResult.identity.email);
        } catch (err) {
          const msg = (err as Error).message || "";
          if (msg.includes("Seat limit reached")) {
            logSecurity("seat_limit_reached", request, { status_code: 403, auth_method: "sso" });
            return reply.code(403).send({ error: msg });
          }
          throw err;
        }
        request.role = "user";
        request.vendor = null;
        request.authMethod = "sso";
        return;
      }
      if (ssoResult.failureReason && ssoResult.failureReason !== "disabled" && ssoResult.failureReason !== "invalid_token") {
        logSecurity("sso_auth_failure", request, {
          reason: ssoResult.failureReason,
          auth_method: "sso",
        });
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
        const allowed =
          path === "/health" ||
          path === "/whoami" ||
          path === "/query" ||
          path.startsWith("/agent/") ||
          (config.mcpPort != null && path.startsWith("/mcp"));
        if (!allowed) {
          logSecurity("agent_route_forbidden", request, {
            vendor,
            path,
            status_code: 403,
            auth_method: "agent_key",
          });
          return reply.code(403).send({
            error: "Agent keys cannot access this endpoint",
          });
        }

        return;
      }
    }

    // Try DB-stored per-user API keys (rm_live_* format)
    const dbKeyAuth = authenticateApiKey(db, token);
    if (dbKeyAuth) {
      request.userId = dbKeyAuth.userId;
      request.role = "user";
      request.vendor = null;
      request.authMethod = "api_key";
      return;
    }

    // Try OAuth access tokens (issued via ChatGPT or MCP OAuth flows)
    if (token.startsWith("rma_")) {
      const oauthRow = db
        .prepare(`SELECT client_id, user_id, expires_at FROM oauth_tokens WHERE token = ? AND token_type = 'access'`)
        .get(token) as { client_id: string; user_id: string | null; expires_at: string | null } | undefined;
      if (oauthRow) {
        if (oauthRow.expires_at && new Date(oauthRow.expires_at) < new Date()) {
          db.prepare(`DELETE FROM oauth_tokens WHERE token = ?`).run(token);
        } else {
          const resolvedUserId = oauthRow.user_id || userId;
          const clientRow = db
            .prepare(`SELECT client_name FROM oauth_clients WHERE client_id = ?`)
            .get(oauthRow.client_id) as { client_name: string | null } | undefined;
          const vendor = clientRow?.client_name?.toLowerCase().replace(/[^a-z0-9]/g, "") || "oauth";
          request.userId = resolvedUserId;
          request.role = "agent";
          request.vendor = vendor;
          request.authMethod = "oauth";

          const allowed =
            path === "/health" ||
            path === "/whoami" ||
            path === "/query" ||
            path.startsWith("/agent/") ||
            (config.mcpPort != null && path.startsWith("/mcp"));
          if (!allowed) {
            logSecurity("oauth_route_forbidden", request, {
              vendor,
              path,
              status_code: 403,
              auth_method: "oauth",
            });
            return reply.code(403).send({
              error: "OAuth tokens cannot access this endpoint",
            });
          }
          return;
        }
      }
    }

    logSecurity("auth_invalid_key", request, { status_code: 401 });
    return reply.code(401).send({ error: "Invalid API key" });
  });

  // ===========================================================================
  // Quota enforcement -- reject requests when plan limits are exceeded
  // ===========================================================================

  const WRITE_ROUTES = new Set(["/memories", "/agent/memories"]);
  const READ_ROUTES = new Set([
    "/memories/list", "/agent/memories/browse", "/agent/memories/by-tag",
    "/query", "/chat",
  ]);

  server.addHook("preHandler", async (request, reply) => {
    if (!request.userId) return;
    const path = request.url.split("?")[0];
    if (
      deployment.disableModelEgress &&
      request.method === "POST" &&
      (path === "/query" || path === "/chat")
    ) {
      return reply.code(503).send({
        error: "Model egress disabled by deployment policy",
        mode: deployment.mode,
      });
    }
    if (request.method !== "POST") return;

    const isWrite = WRITE_ROUTES.has(path);
    const isRead = READ_ROUTES.has(path);
    if (!isWrite && !isRead) return;

    const quota = checkQuota(db, request.userId);
    if (isWrite && quota.memories_remaining <= 0) {
      return reply.code(429).send({
        error: "Memory limit reached",
        plan: quota.plan,
        memory_count: quota.memory_count,
        limit: quota.limits.maxMemories,
        upgrade_url: "https://reflectmemory.com/dashboard/settings",
      });
    }
  });

  // ===========================================================================
  // Usage metering hook -- records operations after successful responses
  // ===========================================================================

  const METERED_ROUTES: Record<string, { method: string; operation: Operation }> = {
    "/memories": { method: "POST", operation: "memory_write" },
    "/agent/memories": { method: "POST", operation: "memory_write" },
    "/memories/list": { method: "POST", operation: "memory_read" },
    "/agent/memories/browse": { method: "POST", operation: "memory_read" },
    "/agent/memories/by-tag": { method: "POST", operation: "memory_read" },
    "/query": { method: "POST", operation: "query" },
    "/chat": { method: "POST", operation: "chat" },
  };

  server.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode >= 400 || !request.userId) return;

    const path = request.url.split("?")[0];
    const origin = request.vendor ?? (request.authMethod === "dashboard" ? "dashboard" : "api");

    // POST routes from METERED_ROUTES table
    const route = METERED_ROUTES[path];
    if (route && request.method === route.method) {
      // For reads: only meter when the handler actually returned data.
      // Empty list results, empty searches, and 0-memory accounts
      // should not inflate read metrics or mask real access patterns.
      if (route.operation === "memory_read" && !request.dataAccessed) return;
      try { recordUsage(db, request.userId, route.operation, origin); } catch {}
      return;
    }

    // GET single-memory reads (GET /memories/:id, /agent/memories/:id, /agent/memories/latest)
    // Only metered when the handler found and returned a memory (dataAccessed=true).
    // 404s already exit above (statusCode >= 400), but dataAccessed is defense-in-depth.
    if (request.method === "GET" && request.dataAccessed) {
      const isMemoryGet =
        (path.startsWith("/memories/") && path !== "/memories/list") ||
        path.startsWith("/agent/memories/");
      if (isMemoryGet) {
        try { recordUsage(db, request.userId, "memory_read", origin); } catch {}
      }
    }
  });

  const SENSITIVE_AUDIT_PATHS = new Set([
    "/memories",
    "/agent/memories",
    "/api/keys",
    "/api/keys/revoke",
    "/api/auth/logout",
    "/webhooks/stripe",
    "/webhooks/clerk",
  ]);

  server.addHook("onResponse", async (request, reply) => {
    if (!request.userId) return;
    const path = request.url.split("?")[0];
    const isSensitive =
      SENSITIVE_AUDIT_PATHS.has(path) ||
      path.startsWith("/admin/") ||
      path.startsWith("/oauth/");
    if (!isSensitive) return;
    try {
      const requestIdHeader = request.headers["x-request-id"];
      const requestId =
        typeof requestIdHeader === "string" && requestIdHeader.trim().length > 0
          ? requestIdHeader.trim()
          : null;
      recordAuditEvent(db, {
        userId: request.userId,
        eventType: "sensitive.route_access",
        severity: reply.statusCode >= 400 ? "warn" : "info",
        authMethod: request.authMethod,
        vendor: request.vendor,
        path,
        statusCode: reply.statusCode,
        ip: request.ip,
        requestId,
        metadata: {
          method: request.method,
          deployment_mode: deployment.mode,
        },
      });
    } catch {
      // Do not fail request completion on audit write failures.
    }
  });

  // ===========================================================================
  // GET /health -- Public health check
  // ===========================================================================

  server.get("/health", async () => {
    const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
    return {
      service: "reflect-memory",
      status: "ok",
      uptime_seconds: uptimeSeconds,
      deployment_mode: deployment.mode,
      network_boundary: deployment.networkBoundary,
      model_egress: deployment.disableModelEgress ? "disabled" : "enabled",
      public_webhooks: deployment.allowPublicWebhooks,
    };
  });

  // ===========================================================================
  // GET /favicon.ico, /icon.png -- Public brand assets (used by Claude connectors, crawlers)
  // ===========================================================================

  const publicAssetsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");

  server.get("/favicon.ico", async (_request, reply) => {
    try {
      const buf = readFileSync(resolve(publicAssetsDir, "favicon.ico"));
      return reply.header("content-type", "image/x-icon").header("cache-control", "public, max-age=86400").send(buf);
    } catch {
      return reply.code(404).send();
    }
  });

  server.get("/icon.png", async (_request, reply) => {
    try {
      const buf = readFileSync(resolve(publicAssetsDir, "icon.png"));
      return reply.header("content-type", "image/png").header("cache-control", "public, max-age=86400").send(buf);
    } catch {
      return reply.code(404).send();
    }
  });

  // ===========================================================================
  // GET /openapi.json -- Public OpenAPI spec for Custom Actions
  // ===========================================================================

  const openapiSpecPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "openapi-agent.yaml",
  );

  let cachedOpenApiSpec: unknown = null;
  try {
    const yaml = require("js-yaml");
    cachedOpenApiSpec = yaml.load(readFileSync(openapiSpecPath, "utf-8"));
  } catch {
    console.warn("Could not pre-load OpenAPI spec; will attempt on first request");
  }

  server.get("/openapi.json", async (_request, reply) => {
    if (cachedOpenApiSpec) {
      reply.type("application/json");
      return cachedOpenApiSpec;
    }
    try {
      const yaml = await import("js-yaml");
      cachedOpenApiSpec = yaml.load(readFileSync(openapiSpecPath, "utf-8"));
      reply.type("application/json");
      return cachedOpenApiSpec;
    } catch {
      reply.code(500);
      return { error: "Failed to load OpenAPI spec" };
    }
  });

  // ===========================================================================
  // GET /whoami -- Identity debugging
  // ===========================================================================
  // Returns the caller's resolved role and vendor from their auth key.
  // No sensitive data. Just what the server sees for this key.
  // ===========================================================================

  server.get("/whoami", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request) => {
    // Surface deployment context + the log-sharing toggle so the dashboard
    // can show/hide the "Share logs" entry without an extra round-trip.
    // log_sharing_enabled is opt-in via env (RM_LOG_SHARING_ENABLED=true);
    // private-deploy admins flip it on to expose the export UI.
    const logSharingEnabled =
      (process.env.RM_LOG_SHARING_ENABLED ?? "").toLowerCase() === "true";
    return {
      role: request.role,
      vendor: request.vendor,
      deployment_mode: deployment.mode,
      log_sharing_enabled: logSharingEnabled,
    };
  });

  // ===========================================================================
  // GET /briefing -- Condensed memory snapshot for LLM first-contact context
  // ===========================================================================
  // Mirrors the briefing sent in the MCP `initialize.instructions` field.
  // Useful for the dashboard (future "at a glance" panel) and for integration
  // tests without going through the MCP transport.
  //
  // Auth: user keys + dashboard sessions. Agent keys get 403 — the MCP
  // initialize already gave them the briefing; a separate HTTP path would
  // just duplicate it.
  //
  // Query params:
  //   format=json (default) | markdown
  //   top_tags=30 | recency_days=7 | active_threads=5
  // ===========================================================================

  server.get(
    "/briefing",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.role === "agent") {
        reply.code(403);
        return { error: "Briefing is delivered to agents via MCP initialize" };
      }

      const qs = request.query as Record<string, string | undefined>;
      const format = qs.format === "markdown" ? "markdown" : "json";
      const topTagsN = qs.top_tags ? parseInt(qs.top_tags, 10) : undefined;
      const recencyDays = qs.recency_days ? parseInt(qs.recency_days, 10) : undefined;
      const activeThreadsN = qs.active_threads
        ? parseInt(qs.active_threads, 10)
        : undefined;

      const briefing = buildMemoryBriefing(db, request.userId, {
        topTagsN,
        recencyDays,
        activeThreadsN,
      });

      if (format === "markdown") {
        reply.header("Content-Type", "text/markdown; charset=utf-8");
        return formatBriefingAsMarkdown(briefing);
      }
      return briefing;
    },
  );

  // ===========================================================================
  // GET /graph -- Memory graph projection for the dashboard visualiser
  // ===========================================================================
  // Returns nodes + edges + named clusters for a user's memory landscape.
  // Designed to feed react-force-graph-2d in the dashboard but also useful
  // as a programmatic graph API.
  //
  // Query params:
  //   scope=personal|team|both (default both)
  //   days=N                  filter to memories created in the last N days
  //                           (default 0 = no filter)
  //   max_nodes=N             cap (default 500) — graph layouts get unread-
  //                           able past this; protects the browser
  //   include_similarity=1|0  include shared-tag edges (default 1)
  //   sim_min_shared=2        min shared tags for a similarity edge
  //
  // Auth: user key or dashboard session, NOT agent keys (graph view is
  // human-facing only).
  // ===========================================================================

  server.get(
    "/graph",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.role === "agent") {
        reply.code(403);
        return { error: "Graph view is human-facing; agents have get_graph_around" };
      }

      const qs = request.query as Record<string, string | undefined>;
      const scope = (qs.scope as "personal" | "team" | "both" | undefined) ?? "both";
      const days = qs.days ? Math.max(0, parseInt(qs.days, 10)) : 0;
      // Cap at 2000 to protect the browser; floor at 1 so tiny graphs +
      // tests can request small sizes. Default 500 is the practical
      // sweet-spot for force-directed readability.
      const maxNodes = Math.min(2000, Math.max(1, parseInt(qs.max_nodes ?? "500", 10)));
      const includeSimilarity = (qs.include_similarity ?? "1") !== "0";
      const simMinShared = Math.max(2, parseInt(qs.sim_min_shared ?? "2", 10));

      const user = getUserById(db, request.userId);
      const teamId = user?.team_id ?? null;
      const sinceClause =
        days > 0
          ? `AND m.created_at >= '${new Date(Date.now() - days * 86400_000).toISOString()}'`
          : "";

      // Visibility scope: personal = own only; team = team-shared only;
      // both = own + team-shared. Use COALESCE so a no-team caller's
      // team clause never matches.
      let scopeWhere: string;
      const scopeArgs: unknown[] = [];
      if (scope === "personal") {
        scopeWhere = `m.user_id = ?`;
        scopeArgs.push(request.userId);
      } else if (scope === "team") {
        if (!teamId) {
          return { nodes: [], edges: [], clusters: [], scope, days, max_nodes: maxNodes, truncated: false };
        }
        scopeWhere = `m.shared_with_team_id = ?`;
        scopeArgs.push(teamId);
      } else {
        scopeWhere = `(m.user_id = ? OR m.shared_with_team_id = COALESCE(?, ''))`;
        scopeArgs.push(request.userId, teamId ?? "");
      }

      // Pull memories. Newest first so when we hit max_nodes we keep the
      // most relevant. Includes thread root + reply count for sizing.
      const memoryRows = db
        .prepare(
          `SELECT m.id, m.title, m.tags, m.user_id, m.shared_with_team_id,
                  m.parent_memory_id, m.created_at,
                  (SELECT COUNT(*) FROM memories c
                   WHERE c.parent_memory_id = m.id AND c.deleted_at IS NULL) AS reply_count
           FROM memories m
           WHERE m.deleted_at IS NULL
             AND ${scopeWhere}
             ${sinceClause}
           ORDER BY m.created_at DESC
           LIMIT ?`,
        )
        .all(...scopeArgs, maxNodes + 1) as Array<{
          id: string;
          title: string;
          tags: string;
          user_id: string;
          shared_with_team_id: string | null;
          parent_memory_id: string | null;
          created_at: string;
          reply_count: number;
        }>;

      const truncated = memoryRows.length > maxNodes;
      const visible = memoryRows.slice(0, maxNodes);
      const visibleIds = new Set(visible.map((m) => m.id));

      // Topic clusters (combined personal + team for "both" scope; just
      // the requested scope otherwise). Drives node colors.
      const personalCluster =
        scope !== "team"
          ? clusterTags(
              ...((): [Array<{ tag_a: string; tag_b: string; count: number }>, Map<string, number>] => {
                const c = getTagCooccurrence(db, { scope: "personal", userId: request.userId });
                return [c.pairs, c.tagFrequencies];
              })(),
            )
          : [];
      const teamCluster =
        scope !== "personal" && teamId
          ? clusterTags(
              ...((): [Array<{ tag_a: string; tag_b: string; count: number }>, Map<string, number>] => {
                const c = getTagCooccurrence(db, { scope: "team", userId: request.userId, teamId });
                return [c.pairs, c.tagFrequencies];
              })(),
            )
          : [];
      const [namedPersonal, namedTeam] = await Promise.all([
        nameClusters(db, request.userId, "personal", null, personalCluster, {}),
        nameClusters(db, request.userId, "team", teamId, teamCluster, {}),
      ]);
      const allNamed = [...namedPersonal, ...namedTeam];

      // Build a tag → cluster index. A tag may appear in both personal and
      // team clusters; we prefer team scope (more authoritative for shared
      // memories) but fall back to personal.
      const tagToCluster = new Map<string, string>();
      for (const c of namedPersonal) for (const t of c.tags) tagToCluster.set(t, c.cluster_hash);
      for (const c of namedTeam) for (const t of c.tags) tagToCluster.set(t, c.cluster_hash);

      // Stable color palette (categorical). Cycle through if more clusters
      // than colors. Picked to be distinguishable in both light + dark
      // themes (rendered by the dashboard, not embedded here).
      const PALETTE = [
        "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
        "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#14b8a6",
        "#a855f7", "#22c55e",
      ];
      const clustersOut = allNamed
        .sort((a, b) => b.size + b.internal_weight - (a.size + a.internal_weight))
        .map((c, i) => ({
          id: c.cluster_hash,
          name: c.name,
          description: c.description,
          tags: c.tags,
          member_count: c.size,
          color: PALETTE[i % PALETTE.length],
        }));
      const clusterIdToColor = new Map(clustersOut.map((c) => [c.id, c.color]));

      // Assign each memory a cluster_id from its first tag-cluster hit.
      // If no cluster matches, mark as "unclustered" (no color).
      function pickClusterForTags(tags: string[]): string | null {
        for (const t of tags) {
          const cid = tagToCluster.get(t);
          if (cid) return cid;
        }
        return null;
      }

      const nodes = visible.map((m) => {
        let tags: string[] = [];
        try {
          tags = JSON.parse(m.tags) as string[];
        } catch {
          tags = [];
        }
        const clusterId = pickClusterForTags(tags);
        return {
          id: m.id,
          title: m.title,
          tags,
          author_id: m.user_id,
          shared: m.shared_with_team_id !== null,
          is_thread_root: m.parent_memory_id === null && m.reply_count > 0,
          is_thread_child: m.parent_memory_id !== null,
          reply_count: m.reply_count,
          created_at: m.created_at,
          cluster_id: clusterId,
          color: clusterId ? clusterIdToColor.get(clusterId) ?? "#94a3b8" : "#94a3b8",
        };
      });

      // Edges:
      //   parent_of  — strong, threading
      //   shared_tag — weak (filtered by sim_min_shared), only when both
      //                endpoints are visible in this graph snapshot
      const edges: Array<{
        source: string;
        target: string;
        type: "parent_of" | "shared_tag";
        weight: number;
      }> = [];
      for (const m of visible) {
        if (m.parent_memory_id && visibleIds.has(m.parent_memory_id)) {
          edges.push({
            source: m.parent_memory_id,
            target: m.id,
            type: "parent_of",
            weight: 3,
          });
        }
      }
      if (includeSimilarity && nodes.length > 1) {
        // Compute pairwise tag overlap among visible nodes. O(n²) where
        // n = visible count; capped by maxNodes so worst case 500² = 250k
        // pair comparisons, each O(t) where t is tag count. Ms-fast at
        // our scale.
        const tagSets = nodes.map((n) => new Set(n.tags));
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            let shared = 0;
            for (const t of tagSets[i]) if (tagSets[j].has(t)) shared++;
            if (shared >= simMinShared) {
              edges.push({
                source: nodes[i].id,
                target: nodes[j].id,
                type: "shared_tag",
                weight: shared,
              });
            }
          }
        }
      }

      request.dataAccessed = true;
      return {
        nodes,
        edges,
        clusters: clustersOut,
        scope,
        days,
        max_nodes: maxNodes,
        truncated,
      };
    },
  );

  // ===========================================================================
  // GET /events -- Server-Sent Events stream of memory mutations
  // ===========================================================================
  // Auth: user key or dashboard session (NOT agent keys — agents don't need
  // realtime). Subscribes the caller to their own user channel + their team
  // channel (if any). Emits a keepalive comment every 15s so proxies don't
  // close idle connections.
  //
  // Client contract:
  //   event: hello                 { subscribed: {user_id, team_id} }
  //   event: memory.created        MemoryEvent
  //   event: memory.updated        MemoryEvent
  //   event: memory.deleted        MemoryEvent
  //   event: memory.restored       MemoryEvent
  //   event: memory.purged         MemoryEvent  (memory:null)
  //   event: memory.shared         MemoryEvent
  //   event: memory.unshared       MemoryEvent
  //
  // EventSource in the browser auto-reconnects on network errors; no Last-Event-ID
  // replay is implemented today — clients should treat the stream as best-effort
  // and reconcile via their periodic fetch fallback.
  // ===========================================================================

  server.get(
    "/events",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.role === "agent") {
        reply.code(403);
        return { error: "Agent keys cannot subscribe to the event stream" };
      }

      const teamId = getUserTeamId(request.userId);

      // Take over the raw response. Fastify will not try to finalize after
      // we return; lifecycle is fully ours until the client disconnects.
      reply.hijack();

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Disable proxy buffering so events flush immediately under Caddy/Nginx.
        "X-Accel-Buffering": "no",
      });

      function write(eventName: string, data: unknown): boolean {
        try {
          reply.raw.write(`event: ${eventName}\n`);
          reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
          return true;
        } catch {
          return false;
        }
      }

      // Initial hello so the client can verify auth + scope before trusting
      // silence as "no events yet."
      write("hello", {
        subscribed: { user_id: request.userId, team_id: teamId },
        emitted_at: new Date().toISOString(),
      });

      const client: EventClient = {
        send: (event) => {
          write(event.type, event);
        },
        close: () => {
          try {
            reply.raw.end();
          } catch {
            // already closed
          }
        },
      };

      const unsubscribe = eventBroker.subscribe(
        { userId: request.userId, teamId: teamId ?? undefined },
        client,
      );

      // Keepalive comment every 15s. SSE comments are lines starting with ":" —
      // the client ignores them, but they keep proxies from timing out idle
      // connections.
      const keepalive = setInterval(() => {
        try {
          reply.raw.write(`: keepalive ${Date.now()}\n\n`);
        } catch {
          // Connection is gone; cleanup happens in the close handler below.
        }
      }, 15_000);

      const cleanup = () => {
        clearInterval(keepalive);
        unsubscribe();
      };

      request.raw.on("close", cleanup);
      reply.raw.on("close", cleanup);
      reply.raw.on("error", cleanup);

      // Return nothing: we've hijacked the reply. Fastify skips its
      // own send/serialize phase.
    },
  );

  // ===========================================================================
  // GET /admin/metrics -- Owner-only usage stats
  // ===========================================================================
  // Dashboard auth or API key. Only the owner (userId) can access.
  // Returns user counts, memory counts, and growth metrics for alpha tracking
  // and investor/acquisition storytelling.
  // ===========================================================================

  server.get("/admin/check", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!ownerUserIds.has(request.userId)) {
      reply.code(403);
      return { error: "Admin access required" };
    }
    return { owner: true };
  });

  server.get("/admin/users", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!ownerUserIds.has(request.userId)) {
      reply.code(403);
      return { error: "Admin access required" };
    }
    const rows = db
      .prepare(`SELECT id, email, created_at FROM users ORDER BY created_at DESC`)
      .all() as { id: string; email: string | null; created_at: string }[];
    return { users: rows };
  });

  server.get("/admin/metrics", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!ownerUserIds.has(request.userId)) {
      reply.code(403);
      return { error: "Admin access required" };
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

    const usersByPlan = db
      .prepare(`SELECT plan, count(*) as n FROM users GROUP BY plan`)
      .all() as { plan: string; n: number }[];

    const usersByRole = db
      .prepare(`SELECT role, count(*) as n FROM users GROUP BY role`)
      .all() as { role: string; n: number }[];

    const paidUsers = (
      db.prepare(`SELECT count(*) as n FROM users WHERE plan != 'free' AND plan != 'admin'`).get() as { n: number }
    ).n;

    const usersWithStripe = (
      db.prepare(`SELECT count(*) as n FROM users WHERE stripe_customer_id IS NOT NULL`).get() as { n: number }
    ).n;

    const month = new Date().toISOString().slice(0, 7);
    const prevMonth = (() => {
      const d = new Date();
      d.setMonth(d.getMonth() - 1);
      return d.toISOString().slice(0, 7);
    })();

    const monthlyAgg = db
      .prepare(`SELECT SUM(writes) as w, SUM(reads) as r, SUM(queries) as q, SUM(total_ops) as ops FROM monthly_usage WHERE month = ?`)
      .get(month) as { w: number | null; r: number | null; q: number | null; ops: number | null } | undefined;

    const prevMonthAgg = db
      .prepare(`SELECT SUM(writes) as w, SUM(reads) as r, SUM(queries) as q, SUM(total_ops) as ops FROM monthly_usage WHERE month = ?`)
      .get(prevMonth) as { w: number | null; r: number | null; q: number | null; ops: number | null } | undefined;

    const activeUsersThisMonth = (
      db.prepare(`SELECT count(DISTINCT user_id) as n FROM monthly_usage WHERE month = ? AND total_ops > 0`).get(month) as { n: number }
    ).n;

    const topUsers = db
      .prepare(`
        SELECT u.email, u.plan, u.role, u.created_at,
               (SELECT count(*) FROM memories m WHERE m.user_id = u.id AND m.deleted_at IS NULL) as memory_count,
               COALESCE(mu.writes, 0) as writes_this_month,
               COALESCE(mu.reads, 0) as reads_this_month,
               COALESCE(mu.total_ops, 0) as ops_this_month
        FROM users u
        LEFT JOIN monthly_usage mu ON mu.user_id = u.id AND mu.month = ?
        ORDER BY ops_this_month DESC
        LIMIT 20
      `)
      .all(month) as {
        email: string; plan: string; role: string; created_at: string;
        memory_count: number; writes_this_month: number; reads_this_month: number; ops_this_month: number;
      }[];

    const totalApiKeys = (
      db.prepare(`SELECT count(*) as n FROM api_keys WHERE revoked_at IS NULL`).get() as { n: number }
    ).n;

    const domainClusters = db
      .prepare(`
        SELECT
          LOWER(SUBSTR(email, INSTR(email, '@') + 1)) as domain,
          COUNT(*) as user_count,
          SUM(CASE WHEN plan = 'pro' OR plan = 'builder' THEN 1 ELSE 0 END) as paid_count
        FROM users
        WHERE email IS NOT NULL
          AND email LIKE '%@%'
          AND LOWER(SUBSTR(email, INSTR(email, '@') + 1)) NOT IN (
            'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
            'icloud.com', 'aol.com', 'protonmail.com', 'proton.me',
            'live.com', 'me.com', 'mac.com', 'msn.com',
            'ymail.com', 'mail.com', 'zoho.com', 'fastmail.com',
            'hey.com', 'pm.me', 'tutanota.com', 'gmx.com',
            'reflectmemory.com', 'demo.local'
          )
        GROUP BY domain
        HAVING user_count >= 3
        ORDER BY user_count DESC
      `)
      .all() as { domain: string; user_count: number; paid_count: number }[];

    const deletedMemories = (
      db.prepare(`SELECT count(*) as n FROM memories WHERE deleted_at IS NOT NULL`).get() as { n: number }
    ).n;

    const conversionRate = totalUsers > 0
      ? Math.round((paidUsers / totalUsers) * 10000) / 100
      : 0;

    const mrr = paidUsers * 20;

    return {
      users: {
        total: totalUsers,
        new_7d: newUsers7d,
        new_30d: newUsers30d,
        with_memories: usersWithMemories,
        by_plan: Object.fromEntries(usersByPlan.map((r) => [r.plan, r.n])),
        by_role: Object.fromEntries(usersByRole.map((r) => [r.role, r.n])),
        paid: paidUsers,
        with_stripe: usersWithStripe,
        active_this_month: activeUsersThisMonth,
      },
      memories: {
        total: totalMemories,
        deleted: deletedMemories,
        new_7d: newMemories7d,
        new_30d: newMemories30d,
        by_origin: Object.fromEntries(
          memoriesByOrigin.map((r) => [r.origin, r.n]),
        ),
        avg_per_user: avgMemoriesPerUser,
      },
      usage: {
        current_month: month,
        writes: monthlyAgg?.w ?? 0,
        reads: monthlyAgg?.r ?? 0,
        queries: monthlyAgg?.q ?? 0,
        total_ops: monthlyAgg?.ops ?? 0,
        prev_month: {
          month: prevMonth,
          writes: prevMonthAgg?.w ?? 0,
          reads: prevMonthAgg?.r ?? 0,
          queries: prevMonthAgg?.q ?? 0,
          total_ops: prevMonthAgg?.ops ?? 0,
        },
      },
      revenue: {
        mrr,
        paid_users: paidUsers,
        conversion_rate: conversionRate,
      },
      api_keys: {
        active: totalApiKeys,
      },
      domain_clusters: domainClusters,
      top_users: topUsers,
      generated_at: now,
    };
  });

  // ===========================================================================
  // GET /admin/audit -- Query audit events (owner-only)
  // ===========================================================================

  server.get("/admin/audit", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!ownerUserIds.has(request.userId)) {
      reply.code(403);
      return { error: "Admin access required" };
    }
    const q = request.query as Record<string, string | undefined>;
    const events = queryAuditEvents(db, {
      eventType: q.event_type,
      userId: q.user_id,
      severity: q.severity as "info" | "warn" | "error" | undefined,
      since: q.since,
      until: q.until,
      limit: q.limit ? parseInt(q.limit, 10) : 100,
      offset: q.offset ? parseInt(q.offset, 10) : 0,
    });
    const total = countAuditEvents(db, {
      eventType: q.event_type,
      userId: q.user_id,
      severity: q.severity as "info" | "warn" | "error" | undefined,
      since: q.since,
      until: q.until,
    });
    return { events, total, limit: events.length, offset: q.offset ? parseInt(q.offset, 10) : 0 };
  });

  // ===========================================================================
  // GET /admin/audit/export -- Export audit events for compliance (owner-only)
  // ===========================================================================

  server.get("/admin/audit/export", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!ownerUserIds.has(request.userId)) {
      reply.code(403);
      return { error: "Admin access required" };
    }
    const q = request.query as Record<string, string | undefined>;
    if (!q.since || !q.until) {
      reply.code(400);
      return { error: "since and until query parameters are required (ISO 8601)" };
    }
    const events = exportAuditEvents(db, q.since, q.until);
    reply.header("content-disposition", `attachment; filename="audit-${q.since}-${q.until}.json"`);
    return { events, count: events.length, exported_at: new Date().toISOString() };
  });

  // ===========================================================================
  // GET /admin/log-export -- Self-host log bundle for sharing with vendor
  // ===========================================================================
  // Admin-only. Gated on RM_LOG_SHARING_ENABLED — opt-in for private deploys
  // who want to share usage + audit data with us for support / debugging.
  // Returns a JSON file the customer reviews before sending.
  //
  // Excludes user content (memories) and credentials by design — see
  // log-export-service.ts for the full exclusion list and rationale.
  //
  // Query params:
  //   from, to (ISO 8601, required)
  // ===========================================================================

  server.get(
    "/admin/log-export",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!ownerUserIds.has(request.userId)) {
        reply.code(403);
        return { error: "Admin access required" };
      }
      const enabled =
        (process.env.RM_LOG_SHARING_ENABLED ?? "").toLowerCase() === "true";
      if (!enabled) {
        reply.code(404);
        return {
          error:
            "Log sharing is disabled on this instance. Set RM_LOG_SHARING_ENABLED=true to enable.",
        };
      }
      const q = request.query as Record<string, string | undefined>;
      if (!q.from || !q.to) {
        reply.code(400);
        return { error: "from and to query parameters are required (ISO 8601)" };
      }
      const tenantId = process.env.RM_TENANT_ID ?? null;
      const bundle = buildLogExport(db, {
        from: q.from,
        to: q.to,
        deploymentMode: deployment.mode,
        tenantId,
      });
      reply.header(
        "content-disposition",
        `attachment; filename="${logExportFilename(tenantId, q.from, q.to)}"`,
      );
      return bundle;
    },
  );

  // ===========================================================================
  // POST /memories -- Create a memory (user path)
  // ===========================================================================
  // allowed_vendors is optional. Defaults to ["*"] server-side.
  // origin is always "user" -- set server-side, never from the body.
  // ===========================================================================

  server.post(
    "/memories",
    {
      schema: {
        body: memoryBodySchema,
      },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = request.body as {
        title: string;
        content: string;
        tags: string[];
        allowed_vendors?: string[];
        memory_type?: string;
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
        origin: request.authMethod === "dashboard" ? "dashboard" : "api",
        allowed_vendors: allowedVendors,
        memory_type: body.memory_type as MemoryType | undefined,
      };

      const memory = createMemory(db, request.userId, input);
      emitMemoryEvent("memory.created", request.userId, memory.id);
      reply.code(201);
      return memory;
    },
  );

  // ===========================================================================
  // POST /agent/memories -- Create a memory (agent path)
  // ===========================================================================
  // allowed_vendors is required. origin is set server-side from the auth key.
  // The body schema does NOT include origin -- additionalProperties: false
  // rejects it with a 400 if present.
  // ===========================================================================

  server.post(
    "/agent/memories",
    {
      schema: {
        body: agentMemoryBodySchema,
      },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = request.body as {
        title: string;
        content: string;
        tags: string[];
        allowed_vendors: string[];
        origin?: string;
        memory_type?: string;
      };

      const vendorErr = validateAllowedVendors(body.allowed_vendors, validVendors);
      if (vendorErr) {
        reply.code(400);
        return { error: vendorErr };
      }

      const origin = request.vendor || body.origin || "user";

      const input: CreateMemoryInput = {
        title: body.title,
        content: body.content,
        tags: body.tags,
        origin,
        allowed_vendors: body.allowed_vendors,
        memory_type: body.memory_type as MemoryType | undefined,
      };

      const memory = createMemory(db, request.userId, input);
      if (!testMode && isCiTestMemory(memory)) {
        softDeleteMemory(db, request.userId, memory.id);
      } else {
        emitMemoryEvent("memory.created", request.userId, memory.id);
      }
      reply.code(201);
      return memory;
    },
  );

  // ===========================================================================
  // GET /agent/memories/latest -- Single most recent memory for agents
  // ===========================================================================
  // Zero-config "most recent" retrieval. No limit parameter, no filter schema.
  // Optional ?tag= query param: returns most recent memory with that tag.
  // Use ?tag=cto_response to always get latest CTO response, even if other
  // memories were written after. Prevents "latest" from being overwritten by
  // agent's own writes.
  // ===========================================================================

  server.get("/agent/memories/latest", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const vendorFilter = request.vendor;
    const query = request.query as { tag?: string; origin?: string };
    const tag = query.tag?.trim();
    const originParam = query.origin?.trim();

    let filter: MemoryFilter;
    if (tag) {
      filter = { by: "tags" as const, tags: [tag] };
    } else if (originParam) {
      filter = { by: "origin" as const, origin: originParam };
    } else {
      filter = { by: "all" as const };
    }

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
      const desc = tag ? `tag "${tag}"` : originParam ? `origin "${originParam}"` : "";
      return { error: desc ? `No memories found with ${desc}` : "No memories found" };
    }
    request.dataAccessed = true;
    return memory;
  });

  // ===========================================================================
  // GET /agent/memories/:id -- Full-body retrieval by ID for agents
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
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
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

      request.dataAccessed = true;
      return memory;
    },
  );

  // ===========================================================================
  // GET /agent/memories/:id/versions -- Version history for agents
  // ===========================================================================

  server.get(
    "/agent/memories/:id/versions",
    {
      schema: { params: memoryIdParamSchema },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
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
      const versions = getVersionHistory(db, request.userId, id);
      return { versions, current_version: versions.length + 1 };
    },
  );

  // ===========================================================================
  // PUT /agent/memories/:id -- Update a memory (agent path)
  // ===========================================================================
  // Agents can update memories they wrote (origin must match vendor).
  // Version history preserved. Trashed memories cannot be updated.
  // ===========================================================================

  server.put(
    "/agent/memories/:id",
    {
      schema: {
        params: memoryIdParamSchema,
        body: updateMemoryBodySchema,
      },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        title: string;
        content: string;
        tags: string[];
        allowed_vendors: string[];
      };

      const existing = readMemoryById(db, request.userId, id);
      if (!existing || existing.deleted_at) {
        reply.code(404);
        return { error: "Memory not found" };
      }

      if (request.vendor && existing.origin !== request.vendor) {
        reply.code(403);
        return { error: "Agents can only update memories they created" };
      }

      const vendorErr = validateAllowedVendors(body.allowed_vendors, validVendors);
      if (vendorErr) {
        reply.code(400);
        return { error: vendorErr };
      }

      const memory = updateMemory(db, request.userId, id, {
        title: body.title,
        content: body.content,
        tags: body.tags,
        allowed_vendors: body.allowed_vendors,
      });
      if (!memory) {
        reply.code(404);
        return { error: "Memory not found" };
      }
      emitMemoryEvent("memory.updated", request.userId, memory.id);
      return memory;
    },
  );

  // ===========================================================================
  // DELETE /agent/memories/:id -- Soft-delete a memory (agent path)
  // ===========================================================================
  // Agents can delete memories they wrote (origin must match vendor).
  // Moves to trash (recoverable from dashboard).
  // ===========================================================================

  server.delete(
    "/agent/memories/:id",
    {
      schema: {
        params: memoryIdParamSchema,
      },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const existing = readMemoryById(db, request.userId, id);
      if (!existing || existing.deleted_at) {
        reply.code(404);
        return { error: "Memory not found" };
      }

      if (request.vendor && existing.origin !== request.vendor) {
        reply.code(403);
        return { error: "Agents can only delete memories they created" };
      }

      const memory = softDeleteMemory(db, request.userId, id);
      if (!memory) {
        reply.code(404);
        return { error: "Memory not found" };
      }
      const teamScope = memory.shared_with_team_id
        ? { teamId: memory.shared_with_team_id }
        : {};
      emitMemoryEvent("memory.deleted", request.userId, id, teamScope);
      if (!memory.parent_memory_id) {
        const cascadedIds = cascadeSoftDelete(db, request.userId, id);
        for (const childId of cascadedIds) {
          emitMemoryEvent("memory.deleted", request.userId, childId, teamScope);
        }
      }
      reply.code(200);
      return { deleted: true, id, title: memory.title };
    },
  );

  // ===========================================================================
  // POST /agent/memories/by-tag -- Full-body retrieval by tags for agents
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
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
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

      if (memories.length > 0) request.dataAccessed = true;
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
  // POST /agent/memories/browse -- Lightweight memory listing for agents
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
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
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

      if (summaries.length > 0) request.dataAccessed = true;
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
  // POST /agent/memories/search -- Full-content text search for agents
  // ===========================================================================

  server.post(
    "/agent/memories/search",
    {
      schema: {
        body: {
          type: "object" as const,
          required: ["term"],
          additionalProperties: false,
          properties: {
            term: { type: "string" as const, minLength: 1, maxLength: 500 },
            limit: { type: "integer" as const, minimum: 1, maximum: 50 },
          },
        },
      },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request) => {
      const { term, limit } = request.body as { term: string; limit?: number };
      const vendorFilter = request.role === "agent" ? request.vendor : null;
      const memories = listMemories(db, request.userId, { by: "search", term }, vendorFilter, { limit: limit ?? 10 });
      if (memories.length > 0) request.dataAccessed = true;
      return { memories, count: memories.length };
    },
  );

  // ===========================================================================
  // POST /agent/memories/list -- Bulk read recent memories for agents
  // ===========================================================================

  server.post(
    "/agent/memories/list",
    {
      schema: {
        body: {
          type: "object" as const,
          additionalProperties: false,
          properties: {
            limit: { type: "integer" as const, minimum: 1, maximum: 50 },
          },
        },
      },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request) => {
      const { limit } = request.body as { limit?: number };
      const vendorFilter = request.role === "agent" ? request.vendor : null;
      const memories = listMemories(db, request.userId, { by: "all" }, vendorFilter, { limit: limit ?? 10 });
      if (memories.length > 0) request.dataAccessed = true;
      return { memories, count: memories.length };
    },
  );

  // ===========================================================================
  // GET /agent/team/memories -- Read team memories for agents
  // ===========================================================================

  server.get(
    "/agent/team/memories",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const query = request.query as { limit?: string; offset?: string };
      const limit = Math.min(Math.max(parseInt(query.limit || "20", 10) || 20, 1), 50);
      const offset = Math.max(parseInt(query.offset || "0", 10) || 0, 0);

      const user = getUserById(db, request.userId);
      if (!user?.team_id) {
        reply.code(404);
        return { error: "Not a member of any team" };
      }

      const memories = listTeamMemories(db, user.team_id, { limit, offset });
      const total = countTeamMemories(db, user.team_id);
      return {
        team_memories: memories,
        total,
        limit,
        offset,
        has_more: offset + memories.length < total,
      };
    },
  );

  // ===========================================================================
  // POST /agent/team/share -- Share a memory with the team for agents
  // ===========================================================================

  server.post(
    "/agent/team/share",
    {
      schema: {
        body: {
          type: "object" as const,
          required: ["memory_id"],
          additionalProperties: false,
          properties: {
            memory_id: { type: "string" as const, minLength: 1 },
          },
        },
      },
      config: { rateLimit: { max: 15, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { memory_id } = request.body as { memory_id: string };

      const user = getUserById(db, request.userId);
      if (!user?.team_id) {
        reply.code(404);
        return { error: "Not a member of any team" };
      }

      const memory = readMemoryById(db, request.userId, memory_id);
      if (!memory || memory.deleted_at) {
        reply.code(404);
        return { error: "Memory not found" };
      }

      try {
        shareMemoryToTeam(db, memory_id, request.userId, user.team_id);
        emitMemoryEvent("memory.shared", request.userId, memory_id, {
          teamId: user.team_id,
        });
        return { shared: true, memory_id, team_id: user.team_id };
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("already shared")) {
          return { shared: true, memory_id, team_id: user.team_id, note: "Already shared" };
        }
        reply.code(400);
        return { error: "Failed to share memory" };
      }
    },
  );

  // ===========================================================================
  // GET /memories/:id -- Read a single memory
  // ===========================================================================

  server.get(
    "/memories/:id",
    {
      schema: {
        params: memoryIdParamSchema,
      },
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const memory = readMemoryById(db, request.userId, id);
      if (!memory) {
        reply.code(404);
        return { error: "Memory not found" };
      }
      request.dataAccessed = true;
      return memory;
    },
  );

  // ===========================================================================
  // GET /memories/:id/versions -- Version history for a memory (dashboard)
  // ===========================================================================

  server.get(
    "/memories/:id/versions",
    {
      schema: { params: memoryIdParamSchema },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const versions = getVersionHistory(db, request.userId, id);
      if (versions.length === 0) {
        const memory = readMemoryById(db, request.userId, id);
        if (!memory) {
          reply.code(404);
          return { error: "Memory not found" };
        }
      }
      return { versions };
    },
  );

  // ===========================================================================
  // POST /memories/list -- List memories with an explicit filter
  // ===========================================================================

  server.post(
    "/memories/list",
    {
      schema: {
        body: listFilterBodySchema,
      },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
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
      if (memories.length > 0) request.dataAccessed = true;
      return { memories };
    },
  );

  // ===========================================================================
  // PUT /memories/:id -- Update a memory (full replacement)
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
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
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
      emitMemoryEvent("memory.updated", request.userId, memory.id);
      return memory;
    },
  );

  // ===========================================================================
  // DELETE /memories/:id -- Soft delete (move to trash)
  // ===========================================================================
  // Sets deleted_at. Memory can be restored within 30 days.
  // ===========================================================================

  server.delete(
    "/memories/:id",
    {
      schema: {
        params: memoryIdParamSchema,
      },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const memory = softDeleteMemory(db, request.userId, id);
      if (!memory) {
        reply.code(404);
        return { error: "Memory not found" };
      }
      const teamScope = memory.shared_with_team_id
        ? { teamId: memory.shared_with_team_id }
        : {};
      emitMemoryEvent("memory.deleted", request.userId, id, teamScope);

      // Thread cascade: only parents have children; a child delete is a no-op.
      if (!memory.parent_memory_id) {
        const cascadedIds = cascadeSoftDelete(db, request.userId, id);
        for (const childId of cascadedIds) {
          emitMemoryEvent("memory.deleted", request.userId, childId, teamScope);
        }
      }
      return memory;
    },
  );

  // ===========================================================================
  // POST /memories/:id/restore -- Restore from trash
  // ===========================================================================

  server.post(
    "/memories/:id/restore",
    {
      schema: {
        params: memoryIdParamSchema,
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const memory = restoreMemory(db, request.userId, id);
      if (!memory) {
        reply.code(404);
        return { error: "Memory not found or not in trash" };
      }
      const teamScope = memory.shared_with_team_id
        ? { teamId: memory.shared_with_team_id }
        : {};
      emitMemoryEvent("memory.restored", request.userId, memory.id, teamScope);

      if (!memory.parent_memory_id) {
        const restoredIds = cascadeRestore(db, request.userId, memory.id);
        for (const childId of restoredIds) {
          emitMemoryEvent("memory.restored", request.userId, childId, teamScope);
        }
      }
      return memory;
    },
  );

  // ===========================================================================
  // DELETE /memories/:id/permanent -- Permanently delete a single memory
  // ===========================================================================

  server.delete(
    "/memories/:id/permanent",
    {
      schema: {
        params: memoryIdParamSchema,
      },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      // Snapshot the row before purge so we can emit cascade events against
      // the right team scope (the row is gone afterward).
      const snapshot = db
        .prepare(
          `SELECT parent_memory_id, shared_with_team_id FROM memories
           WHERE id = ? AND user_id = ?`,
        )
        .get(id, request.userId) as
        | { parent_memory_id: string | null; shared_with_team_id: string | null }
        | undefined;

      // Cascade BEFORE the parent purge: caller's own children get fully
      // purged, teammates' children get orphaned (parent_memory_id = NULL)
      // so the FK constraint on the parent's row doesn't fire.
      const cascade =
        snapshot && snapshot.parent_memory_id === null
          ? cascadeHardDelete(db, request.userId, id)
          : { purged: [] as string[], orphaned: [] as string[] };

      const deleted = deleteMemory(db, request.userId, id);
      if (!deleted) {
        reply.code(404);
        return { error: "Memory not found" };
      }
      const teamScope = snapshot?.shared_with_team_id
        ? { teamId: snapshot.shared_with_team_id }
        : {};
      // includeBody:false — the row is gone; we only emit the id so clients
      // can remove it from local state.
      emitMemoryEvent("memory.purged", request.userId, id, {
        ...teamScope,
        includeBody: false,
      });
      for (const childId of cascade.purged) {
        emitMemoryEvent("memory.purged", request.userId, childId, {
          ...teamScope,
          includeBody: false,
        });
      }
      // Teammate children are orphaned, not purged. Surface as `memory.updated`
      // so dashboards repaint them (parent_memory_id changed; the row now
      // shows up at top level instead of nested).
      for (const childId of cascade.orphaned) {
        emitMemoryEvent("memory.updated", request.userId, childId, teamScope);
      }
      reply.code(204);
    },
  );

  // ===========================================================================
  // DELETE /memories/trash -- Empty trash (permanently delete all trashed)
  // ===========================================================================

  server.delete(
    "/memories/trash",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      // Capture IDs before purge so we can emit per-memory events (lets
      // clients remove rows from local state without a full refetch).
      const trashedIds = (
        db
          .prepare(
            `SELECT id FROM memories WHERE user_id = ? AND deleted_at IS NOT NULL`,
          )
          .all(request.userId) as { id: string }[]
      ).map((r) => r.id);

      const count = emptyTrash(db, request.userId);
      for (const id of trashedIds) {
        emitMemoryEvent("memory.purged", request.userId, id, { includeBody: false });
      }
      return { deleted: count };
    },
  );

  // ===========================================================================
  // POST /query -- AI query with explicit memory selection
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

      // Agents get a slim receipt -- no full prompt or memory objects echoed back.
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
  // GET /chat/models -- Available chat models
  // ===========================================================================
  // Returns models that have API keys configured. Dashboard uses this to
  // populate the model selector.
  // ===========================================================================

  server.get("/chat/models", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async () => {
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
  // POST /chat -- Multi-model chat with Reflect Memory tool calling
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

  // ===========================================================================
  // POST /waitlist -- Public waitlist signup
  // ===========================================================================

  const waitlistBodySchema = {
    type: "object" as const,
    required: ["email"],
    additionalProperties: false,
    properties: {
      email: { type: "string" as const, minLength: 1, maxLength: 320 },
    },
  };

  server.post(
    "/waitlist",
    {
      schema: { body: waitlistBodySchema },
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { email } = request.body as { email: string };

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        reply.code(400);
        return { error: "Invalid email format" };
      }

      const normalizedEmail = email.toLowerCase().trim();

      const existing = db
        .prepare(`SELECT position FROM waitlist WHERE email = ?`)
        .get(normalizedEmail) as { position: number } | undefined;

      if (existing) {
        return { already_registered: true, position: existing.position };
      }

      const { count } = db
        .prepare(`SELECT count(*) as count FROM waitlist`)
        .get() as { count: number };

      const position = count + 1;
      const id = randomUUID();
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO waitlist (id, email, position, created_at) VALUES (?, ?, ?, ?)`,
      ).run(id, normalizedEmail, position, now);

      return { success: true, position, email: normalizedEmail };
    },
  );

  // ===========================================================================
  // POST /early-access -- Public early access request
  // ===========================================================================

  const earlyAccessBodySchema = {
    type: "object" as const,
    required: ["email"],
    additionalProperties: false,
    properties: {
      email: { type: "string" as const, minLength: 1, maxLength: 320 },
      linkedin: { type: "string" as const, maxLength: 500 },
      company: { type: "string" as const, maxLength: 200 },
      use_case: { type: "string" as const, maxLength: 2000 },
      details: { type: "string" as const, maxLength: 5000 },
    },
  };

  server.post(
    "/early-access",
    {
      schema: { body: earlyAccessBodySchema },
      config: { rateLimit: { max: 3, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = request.body as {
        email: string;
        linkedin?: string;
        company?: string;
        use_case?: string;
        details?: string;
      };

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(body.email)) {
        reply.code(400);
        return { error: "Invalid email format" };
      }

      const normalizedEmail = body.email.toLowerCase().trim();
      const id = randomUUID();
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO early_access_requests (id, email, linkedin, company, use_case, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        normalizedEmail,
        body.linkedin ?? null,
        body.company ?? null,
        body.use_case ?? null,
        body.details ?? null,
        now,
      );

      const existingWaitlist = db
        .prepare(`SELECT 1 FROM waitlist WHERE email = ?`)
        .get(normalizedEmail);

      if (!existingWaitlist) {
        const { count } = db
          .prepare(`SELECT count(*) as count FROM waitlist`)
          .get() as { count: number };

        db.prepare(
          `INSERT INTO waitlist (id, email, position, created_at) VALUES (?, ?, ?, ?)`,
        ).run(randomUUID(), normalizedEmail, count + 1, now);
      }

      return { success: true, id };
    },
  );

  // ===========================================================================
  // GET /admin/waitlist -- Owner-only waitlist view
  // ===========================================================================

  server.get(
    "/admin/waitlist",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!ownerUserIds.has(request.userId)) {
        reply.code(403);
        return { error: "Admin access required" };
      }

      const rows = db
        .prepare(
          `SELECT id, email, position, notified, created_at FROM waitlist ORDER BY position ASC`,
        )
        .all() as { id: string; email: string; position: number; notified: number; created_at: string }[];

      return { waitlist: rows, total: rows.length };
    },
  );

  // ===========================================================================
  // GET /admin/early-access -- Owner-only early access requests view
  // ===========================================================================

  server.get(
    "/admin/early-access",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!ownerUserIds.has(request.userId)) {
        reply.code(403);
        return { error: "Admin access required" };
      }

      const rows = db
        .prepare(
          `SELECT id, email, linkedin, company, use_case, details, status, created_at FROM early_access_requests ORDER BY created_at DESC`,
        )
        .all() as {
        id: string;
        email: string;
        linkedin: string | null;
        company: string | null;
        use_case: string | null;
        details: string | null;
        status: string;
        created_at: string;
      }[];

      return { requests: rows, total: rows.length };
    },
  );

  // ===========================================================================
  // PUT /admin/early-access/:id -- Owner-only status update
  // ===========================================================================

  const earlyAccessStatusSchema = {
    type: "object" as const,
    required: ["status"],
    additionalProperties: false,
    properties: {
      status: { type: "string" as const, enum: ["pending", "approved", "rejected"] },
    },
  };

  const earlyAccessIdParamSchema = {
    type: "object" as const,
    required: ["id"],
    additionalProperties: false,
    properties: {
      id: { type: "string" as const, minLength: 1 },
    },
  };

  server.put(
    "/admin/early-access/:id",
    {
      schema: {
        params: earlyAccessIdParamSchema,
        body: earlyAccessStatusSchema,
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!ownerUserIds.has(request.userId)) {
        reply.code(403);
        return { error: "Admin access required" };
      }

      const { id } = request.params as { id: string };
      const { status } = request.body as { status: string };

      const result = db
        .prepare(`UPDATE early_access_requests SET status = ? WHERE id = ?`)
        .run(status, id);

      if (result.changes === 0) {
        reply.code(404);
        return { error: "Early access request not found" };
      }

      const updated = db
        .prepare(
          `SELECT id, email, linkedin, company, use_case, details, status, created_at FROM early_access_requests WHERE id = ?`,
        )
        .get(id) as {
        id: string;
        email: string;
        linkedin: string | null;
        company: string | null;
        use_case: string | null;
        details: string | null;
        status: string;
        created_at: string;
      };

      return updated;
    },
  );

  // ===========================================================================
  // POST /admin/waitlist/mark-notified -- Mark waitlist entries as notified
  // ===========================================================================

  server.post(
    "/admin/waitlist/mark-notified",
    {
      schema: {
        body: {
          type: "object" as const,
          required: ["ids"],
          additionalProperties: false,
          properties: {
            ids: { type: "array" as const, items: { type: "string" as const }, minItems: 1 },
          },
        },
      },
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!ownerUserIds.has(request.userId)) {
        reply.code(403);
        return { error: "Admin access required" };
      }

      const { ids } = request.body as { ids: string[] };
      const placeholders = ids.map(() => "?").join(",");
      const result = db
        .prepare(`UPDATE waitlist SET notified = 1 WHERE id IN (${placeholders}) AND notified = 0`)
        .run(...ids);

      return { updated: result.changes };
    },
  );

  // ===========================================================================
  // POST /integration-requests -- Public integration request submission
  // ===========================================================================

  const integrationRequestBodySchema = {
    type: "object" as const,
    required: ["email", "company_name"],
    additionalProperties: false,
    properties: {
      email: { type: "string" as const, minLength: 1, maxLength: 320 },
      company_name: { type: "string" as const, minLength: 1, maxLength: 200 },
      website: { type: "string" as const, maxLength: 500 },
      description: { type: "string" as const, maxLength: 2000 },
    },
  };

  server.post(
    "/integration-requests",
    {
      schema: { body: integrationRequestBodySchema },
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { email, company_name, website, description } = request.body as {
        email: string;
        company_name: string;
        website?: string;
        description?: string;
      };

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        reply.code(400);
        return { error: "Invalid email format" };
      }

      const id = randomUUID();
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO integration_requests (id, email, company_name, website, description, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(id, email.toLowerCase().trim(), company_name.trim(), website?.trim() || null, description?.trim() || null, now);

      return { success: true, id };
    },
  );

  // ===========================================================================
  // GET /admin/integration-requests -- Owner-only integration requests view
  // ===========================================================================

  server.get(
    "/admin/integration-requests",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!ownerUserIds.has(request.userId)) {
        reply.code(403);
        return { error: "Admin access required" };
      }

      const rows = db
        .prepare(
          `SELECT id, email, company_name, website, description, status, created_at
           FROM integration_requests ORDER BY created_at DESC`,
        )
        .all();

      return { requests: rows, total: rows.length };
    },
  );

  // ===========================================================================
  // API Key Management -- per-user key CRUD
  // ===========================================================================

  server.post(
    "/api/keys",
    {
      schema: {
        body: {
          type: "object" as const,
          additionalProperties: false,
          properties: {
            label: { type: "string" as const, minLength: 1, maxLength: 100 },
          },
        },
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const user = db
        .prepare(`SELECT plan FROM users WHERE id = ?`)
        .get(request.userId) as { plan: string } | undefined;
      const plan = user?.plan ?? "free";
      const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
      const activeCount = countActiveApiKeys(db, request.userId);

      if (isFinite(limits.maxApiKeys) && activeCount >= limits.maxApiKeys) {
        return reply.code(429).send({
          error: "API key limit reached for your plan",
          plan,
          active_keys: activeCount,
          limit: limits.maxApiKeys,
          upgrade_url: "https://reflectmemory.com/dashboard/settings",
        });
      }

      const { label } = (request.body ?? {}) as { label?: string };
      const result = generateApiKey(db, request.userId, label ?? "Default");
      return {
        key: result.key,
        id: result.record.id,
        key_prefix: result.record.key_prefix,
        label: result.record.label,
        created_at: result.record.created_at,
      };
    },
  );

  server.get(
    "/api/keys",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const keys = listApiKeys(db, request.userId);
      return { keys };
    },
  );

  server.delete(
    "/api/keys/:id",
    {
      schema: { params: memoryIdParamSchema },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const revoked = revokeApiKey(db, id, request.userId);
      if (!revoked) {
        return reply.code(404).send({ error: "Key not found or already revoked" });
      }
      return { revoked: true };
    },
  );

  // ===========================================================================
  // Usage -- quota status and monthly breakdown
  // ===========================================================================

  server.get(
    "/usage",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const month = (request.query as { month?: string })?.month;
      return getUsageForMonth(db, request.userId, month);
    },
  );

  server.get(
    "/usage/check",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      return checkQuota(db, request.userId);
    },
  );

  // ===========================================================================
  // Billing -- Stripe checkout and management
  // ===========================================================================

  server.post(
    "/billing/checkout",
    {
      schema: {
        body: {
          type: "object" as const,
          required: ["plan"],
          additionalProperties: false,
          properties: {
            plan: { type: "string" as const, enum: ["pro", "builder", "team"] },
            success_url: { type: "string" as const },
            cancel_url: { type: "string" as const },
          },
        },
      },
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!isStripeConfigured()) {
        return reply.code(503).send({ error: "Billing not configured" });
      }

      const { plan, success_url, cancel_url } = request.body as {
        plan: "pro" | "builder" | "team";
        success_url?: string;
        cancel_url?: string;
      };

      const defaultBase = "https://www.reflectmemory.com";

      function validateRedirectUrl(url: string | undefined, fallback: string): string {
        if (!url) return fallback;
        try {
          const parsed = new URL(url);
          const allowed = new Set(["www.reflectmemory.com", "reflectmemory.com", "localhost"]);
          if (allowed.has(parsed.hostname)) return url;
        } catch {}
        return fallback;
      }

      const url = await createCheckoutSession(
        db,
        request.userId,
        plan,
        validateRedirectUrl(success_url, `${defaultBase}/dashboard?billing=success`),
        validateRedirectUrl(cancel_url, `${defaultBase}/dashboard?billing=cancelled`),
      );

      if (!url) {
        return reply.code(500).send({ error: "Failed to create checkout session" });
      }

      return { url };
    },
  );

  server.post(
    "/billing/portal",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!isStripeConfigured()) {
        return reply.code(503).send({ error: "Billing not configured" });
      }

      const body = (request.body ?? {}) as { return_url?: string };
      let returnUrl = "https://www.reflectmemory.com/dashboard";
      if (body.return_url) {
        try {
          const parsed = new URL(body.return_url);
          const allowed = new Set(["www.reflectmemory.com", "reflectmemory.com", "localhost"]);
          if (allowed.has(parsed.hostname)) returnUrl = body.return_url;
        } catch { /* invalid URL, use default */ }
      }
      const url = await createBillingPortalSession(
        db,
        request.userId,
        returnUrl,
      );

      if (!url) {
        return reply.code(400).send({ error: "No billing account found. Subscribe to a plan first." });
      }

      return { url };
    },
  );

  server.get(
    "/billing/status",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const user = db
        .prepare(`SELECT plan, stripe_customer_id FROM users WHERE id = ?`)
        .get(request.userId) as { plan: string; stripe_customer_id: string | null } | undefined;

      let plan = user?.plan ?? "free";
      let cancelAtPeriodEnd = false;
      let currentPeriodEnd: string | null = null;

      if (user?.stripe_customer_id && isStripeConfigured()) {
        const synced = await syncPlanFromStripe(db, request.userId);
        if (synced.synced) {
          plan = synced.plan;
          cancelAtPeriodEnd = synced.cancel_at_period_end ?? false;
          currentPeriodEnd = synced.current_period_end ?? null;
        }
      }

      const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
      const quota = checkQuota(db, request.userId);

      return {
        plan,
        has_billing: Boolean(user?.stripe_customer_id),
        limits,
        memory_count: quota.memory_count,
        memories_remaining: quota.memories_remaining,
        cancel_at_period_end: cancelAtPeriodEnd,
        current_period_end: currentPeriodEnd,
      };
    },
  );

  // ===========================================================================
  // POST /webhooks/stripe -- Stripe event handler (public, verified by signature)
  // ===========================================================================

  server.post(
    "/webhooks/stripe",
    {
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute" },
        rawBody: true,
      },
    },
    async (request, reply) => {
      const signature = request.headers["stripe-signature"];
      if (typeof signature !== "string") {
        return reply.code(400).send({ error: "Missing stripe-signature" });
      }

      const rawBody = (request as unknown as { rawBody?: string }).rawBody
        ?? (typeof request.body === "string" ? request.body : JSON.stringify(request.body));

      const event = await constructStripeEvent(rawBody, signature);
      if (!event) {
        return reply.code(400).send({ error: "Invalid webhook signature" });
      }

      console.log(`[stripe-webhook] received ${event.id} type=${event.type}`);
      await handleStripeWebhook(db, event);
      console.log(`[stripe-webhook] processed ${event.id}`);
      return { received: true };
    },
  );

  // ===========================================================================
  // POST /webhooks/clerk -- Clerk user sync (public, verified by Svix signature)
  // ===========================================================================

  const clerkWebhookSecret = process.env.CLERK_WEBHOOK_SECRET;

  server.post(
    "/webhooks/clerk",
    { config: { rateLimit: { max: 50, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!clerkWebhookSecret) {
        return reply.code(404).send({ error: "Not configured" });
      }

      // Verify Svix signature -- Clerk signs every webhook with svix-id, svix-timestamp, svix-signature
      const svixId = request.headers["svix-id"] as string | undefined;
      const svixTimestamp = request.headers["svix-timestamp"] as string | undefined;
      const svixSignature = request.headers["svix-signature"] as string | undefined;

      if (!svixId || !svixTimestamp || !svixSignature) {
        logSecurity("clerk_webhook_missing_headers", request);
        return reply.code(400).send({ error: "Missing Svix verification headers" });
      }

      let verifiedPayload: Record<string, unknown>;
      try {
        const { Webhook } = await import("svix");
        const wh = new Webhook(clerkWebhookSecret);
        const rawBody = typeof request.body === "string"
          ? request.body
          : JSON.stringify(request.body);
        verifiedPayload = wh.verify(rawBody, {
          "svix-id": svixId,
          "svix-timestamp": svixTimestamp,
          "svix-signature": svixSignature,
        }) as Record<string, unknown>;
      } catch (err) {
        logSecurity("clerk_webhook_invalid_signature", request);
        return reply.code(400).send({ error: "Invalid webhook signature" });
      }

      const eventType = verifiedPayload.type as string | undefined;
      const data = verifiedPayload.data as {
        id?: string;
        email_addresses?: Array<{ email_address?: string }>;
        primary_email_address_id?: string;
      } | undefined;

      if (!eventType || !data?.id) {
        return reply.code(400).send({ error: "Invalid webhook payload" });
      }

      console.log(`[clerk-webhook] received type=${eventType} clerk_id=${data.id}`);

      const email = data.email_addresses?.[0]?.email_address?.trim().toLowerCase();

      if (eventType === "user.created" || eventType === "user.updated") {
        if (!email) {
          return reply.code(400).send({ error: "No email in webhook" });
        }

        let isNewUser = false;
        let resolvedUserId: string | null = null;

        const existing = db
          .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
          .get(data.id) as { id: string } | undefined;

        if (existing) {
          db.prepare(`UPDATE users SET email = ?, updated_at = ? WHERE clerk_id = ?`)
            .run(email, new Date().toISOString(), data.id);
          resolvedUserId = existing.id;
        } else {
          const byEmail = db
            .prepare(`SELECT id FROM users WHERE email = ?`)
            .get(email) as { id: string } | undefined;

          if (byEmail) {
            db.prepare(`UPDATE users SET clerk_id = ?, updated_at = ? WHERE id = ?`)
              .run(data.id, new Date().toISOString(), byEmail.id);
            resolvedUserId = byEmail.id;
          } else {
            const newId = randomUUID();
            const now = new Date().toISOString();
            db.prepare(
              `INSERT INTO users (id, clerk_id, email, role, plan, created_at, updated_at)
               VALUES (?, ?, ?, 'user', 'free', ?, ?)`,
            ).run(newId, data.id, email, now, now);
            isNewUser = true;
            resolvedUserId = newId;
          }
        }

        // Seed a welcome memory for brand-new users (idempotent: skip if one already exists)
        if (isNewUser && eventType === "user.created" && resolvedUserId) {
          const hasWelcome = listMemories(db, resolvedUserId, { by: "tags", tags: ["welcome"] }, null, { limit: 1 });
          if (hasWelcome.length === 0) {
            try {
              createMemory(db, resolvedUserId, {
                title: "Welcome to Reflect Memory",
                content: WELCOME_MEMORY_CONTENT,
                tags: ["welcome", "frx", "onboarding"],
                origin: "system",
                allowed_vendors: ["*"],
                memory_type: "procedural",
              });
              console.log(`[clerk] Seeded welcome memory for ${email}`);
            } catch (err) {
              console.error(`[clerk] Failed to seed welcome memory for ${email}:`, err);
            }
          }
        }

        console.log(`[clerk] Synced user ${data.id} (${email})`);
        return { received: true };
      }

      console.log(`[clerk-webhook] ignored type=${eventType} clerk_id=${data.id}`);
      return { received: true, ignored: true };
    },
  );

  // ===========================================================================
  // Team endpoints
  // ===========================================================================

  server.post(
    "/teams",
    {
      schema: {
        body: {
          type: "object" as const,
          required: ["name"],
          properties: {
            name: { type: "string" as const, minLength: 1, maxLength: 100 },
            first_name: { type: "string" as const, maxLength: 100 },
            last_name: { type: "string" as const, maxLength: 100 },
            seed_memory: {
              type: "object" as const,
              properties: {
                title: { type: "string" as const },
                content: { type: "string" as const },
              },
            },
          },
          additionalProperties: false,
        },
      },
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const user = getUserById(db, request.userId);
      if (!user) return reply.code(404).send({ error: "User not found" });
      if (user.team_id) return reply.code(409).send({ error: "Already on a team" });

      const body = request.body as {
        name: string;
        first_name?: string;
        last_name?: string;
        seed_memory?: { title: string; content: string };
      };

      const teamId = randomUUID();
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO teams (id, name, owner_id, plan, created_at, updated_at) VALUES (?, ?, ?, 'team', ?, ?)`,
      ).run(teamId, body.name.trim(), request.userId, now, now);

      addUserToTeam(db, request.userId, teamId, "owner");

      if (body.first_name || body.last_name) {
        updateUserName(db, request.userId, body.first_name ?? "", body.last_name ?? "");
      }

      if (body.seed_memory?.title && body.seed_memory?.content) {
        const mem = createMemory(db, request.userId, {
          title: body.seed_memory.title,
          content: body.seed_memory.content,
          tags: ["team-seed"],
          origin: "dashboard",
          allowed_vendors: ["*"],
        });
        shareMemoryToTeam(db, mem.id, request.userId, teamId);
      }

      reply.code(201);
      return {
        id: teamId,
        name: body.name.trim(),
        owner_id: request.userId,
        plan: "team",
        created_at: now,
      };
    },
  );

  server.get(
    "/teams/:id",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { id: teamId } = request.params as { id: string };
      const user = getUserById(db, request.userId);
      if (!user || user.team_id !== teamId) {
        return reply.code(403).send({ error: "Not a member of this team" });
      }

      const team = db.prepare(`SELECT id, name, owner_id, plan, created_at, updated_at FROM teams WHERE id = ?`).get(teamId) as {
        id: string; name: string; owner_id: string; plan: string; created_at: string; updated_at: string;
      } | undefined;

      if (!team) return reply.code(404).send({ error: "Team not found" });

      const members = getTeamMembers(db, teamId);
      const memoryCount = countTeamMemories(db, teamId);

      const invites = db
        .prepare(`SELECT id, email, status, created_at, expires_at FROM team_invites WHERE team_id = ? AND status = 'pending' ORDER BY created_at DESC`)
        .all(teamId);

      return { ...team, members, memory_count: memoryCount, pending_invites: invites };
    },
  );

  server.post(
    "/teams/:id/invite",
    {
      schema: {
        body: {
          type: "object" as const,
          required: ["emails"],
          properties: {
            emails: { type: "array" as const, items: { type: "string" as const }, minItems: 1, maxItems: 10 },
          },
          additionalProperties: false,
        },
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id: teamId } = request.params as { id: string };
      const user = getUserById(db, request.userId);
      if (!user || user.team_id !== teamId || user.team_role !== "owner") {
        return reply.code(403).send({ error: "Only team owner can invite" });
      }

      const memberCount = getTeamMemberCount(db, teamId);
      const body = request.body as { emails: string[] };

      if (memberCount + body.emails.length > 10) {
        return reply.code(400).send({
          error: `Team is limited to 10 seats. Currently ${memberCount} members.`,
        });
      }

      const team = db.prepare(`SELECT name FROM teams WHERE id = ?`).get(teamId) as { name: string } | undefined;
      const inviterName = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email;
      const results: { email: string; token: string; status: string }[] = [];
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      for (const rawEmail of body.emails) {
        const email = rawEmail.trim().toLowerCase();
        if (!email) continue;

        const existing = db
          .prepare(`SELECT id FROM team_invites WHERE team_id = ? AND email = ? AND status = 'pending'`)
          .get(teamId, email) as { id: string } | undefined;
        if (existing) {
          results.push({ email, token: "", status: "already_invited" });
          continue;
        }

        const alreadyMember = db
          .prepare(`SELECT id FROM users WHERE team_id = ? AND email = ?`)
          .get(teamId, email) as { id: string } | undefined;
        if (alreadyMember) {
          results.push({ email, token: "", status: "already_member" });
          continue;
        }

        const token = randomUUID();
        const inviteId = randomUUID();
        db.prepare(
          `INSERT INTO team_invites (id, team_id, email, token, invited_by, status, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        ).run(inviteId, teamId, email, token, request.userId, now, expiresAt);

        results.push({ email, token, status: "invited" });
      }

      return { invites: results, team_name: team?.name ?? "" };
    },
  );

  server.post(
    "/teams/join",
    {
      schema: {
        body: {
          type: "object" as const,
          required: ["token"],
          properties: {
            token: { type: "string" as const },
            first_name: { type: "string" as const, maxLength: 100 },
            last_name: { type: "string" as const, maxLength: 100 },
          },
          additionalProperties: false,
        },
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = request.body as { token: string; first_name?: string; last_name?: string };
      const invite = db
        .prepare(`SELECT id, team_id, email, status, expires_at FROM team_invites WHERE token = ?`)
        .get(body.token) as {
          id: string; team_id: string; email: string | null; status: string; expires_at: string;
        } | undefined;

      if (!invite) return reply.code(404).send({ error: "Invite not found" });
      if (invite.status !== "pending") return reply.code(400).send({ error: "Invite already used" });
      if (new Date(invite.expires_at) < new Date()) {
        db.prepare(`UPDATE team_invites SET status = 'expired' WHERE id = ?`).run(invite.id);
        return reply.code(400).send({ error: "Invite expired" });
      }

      const user = getUserById(db, request.userId);
      if (!user) return reply.code(404).send({ error: "User not found" });
      if (user.team_id) return reply.code(409).send({ error: "Already on a team" });

      const memberCount = getTeamMemberCount(db, invite.team_id);
      if (memberCount >= 10) {
        return reply.code(400).send({ error: "Team is full (10 seats)" });
      }

      addUserToTeam(db, request.userId, invite.team_id, "member");
      if (body.first_name || body.last_name) {
        updateUserName(db, request.userId, body.first_name ?? "", body.last_name ?? "");
      }

      db.prepare(`UPDATE team_invites SET status = 'accepted' WHERE id = ?`).run(invite.id);

      const team = db.prepare(`SELECT id, name FROM teams WHERE id = ?`).get(invite.team_id) as { id: string; name: string };
      return { team_id: team.id, team_name: team.name, role: "member" };
    },
  );

  server.get(
    "/teams/invite/:token",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      const invite = db
        .prepare(
          `SELECT ti.id, ti.team_id, ti.email, ti.status, ti.expires_at, ti.invited_by,
                  t.name AS team_name, u.first_name AS inviter_first, u.last_name AS inviter_last, u.email AS inviter_email
           FROM team_invites ti
           JOIN teams t ON t.id = ti.team_id
           JOIN users u ON u.id = ti.invited_by
           WHERE ti.token = ?`,
        )
        .get(token) as {
          id: string; team_id: string; email: string | null; status: string; expires_at: string;
          team_name: string; inviter_first: string | null; inviter_last: string | null; inviter_email: string;
        } | undefined;

      if (!invite) return reply.code(404).send({ error: "Invite not found" });

      const expired = new Date(invite.expires_at) < new Date();
      if (expired && invite.status === "pending") {
        db.prepare(`UPDATE team_invites SET status = 'expired' WHERE id = ?`).run(invite.id);
      }

      const inviterName = [invite.inviter_first, invite.inviter_last].filter(Boolean).join(" ") || invite.inviter_email;

      return {
        team_name: invite.team_name,
        inviter_name: inviterName,
        status: expired ? "expired" : invite.status,
        email: invite.email,
      };
    },
  );

  // ===========================================================================
  // Memory threading endpoints
  // ===========================================================================

  const childMemoryBodySchema = {
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
      memory_type: {
        type: "string" as const,
        enum: ["semantic", "episodic", "procedural"],
      },
    },
  };

  function handleThreadingError(reply: FastifyReply, err: unknown): boolean {
    if (err instanceof ThreadingError) {
      const status =
        err.code === "parent_not_found"
          ? 404
          : err.code === "not_owner"
            ? 403
            : 400; // parent_deleted, parent_is_child
      reply.code(status);
      return true;
    }
    return false;
  }

  server.post(
    "/memories/:id/children",
    {
      schema: {
        params: memoryIdParamSchema,
        body: childMemoryBodySchema,
      },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id: parentId } = request.params as { id: string };
      const body = request.body as {
        title: string;
        content: string;
        tags: string[];
        allowed_vendors?: string[];
        memory_type?: string;
      };

      const allowedVendors = body.allowed_vendors ?? ["*"];
      const vendorErr = validateAllowedVendors(allowedVendors, validVendors);
      if (vendorErr) {
        reply.code(400);
        return { error: vendorErr };
      }

      try {
        const child = createChildMemory(db, request.userId, parentId, {
          title: body.title,
          content: body.content,
          tags: body.tags,
          origin: request.authMethod === "dashboard" ? "dashboard" : "api",
          allowed_vendors: allowedVendors,
          memory_type: body.memory_type as MemoryType | undefined,
        });
        // Child inherits parent's team scope — fan the event to the team
        // channel too so teammates see the reply appear instantly.
        emitMemoryEvent(
          "memory.created",
          request.userId,
          child.id,
          child.shared_with_team_id ? { teamId: child.shared_with_team_id } : {},
        );
        reply.code(201);
        return child;
      } catch (err) {
        if (handleThreadingError(reply, err)) {
          return { error: (err as ThreadingError).message };
        }
        throw err;
      }
    },
  );

  server.post(
    "/agent/memories/:id/children",
    {
      schema: {
        params: memoryIdParamSchema,
        body: {
          ...childMemoryBodySchema,
          required: ["title", "content", "tags", "allowed_vendors"],
        },
      },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id: parentId } = request.params as { id: string };
      const body = request.body as {
        title: string;
        content: string;
        tags: string[];
        allowed_vendors: string[];
        memory_type?: string;
      };

      const vendorErr = validateAllowedVendors(body.allowed_vendors, validVendors);
      if (vendorErr) {
        reply.code(400);
        return { error: vendorErr };
      }

      try {
        const origin = request.vendor || "api";
        const child = createChildMemory(db, request.userId, parentId, {
          title: body.title,
          content: body.content,
          tags: body.tags,
          origin,
          allowed_vendors: body.allowed_vendors,
          memory_type: body.memory_type as MemoryType | undefined,
        });
        emitMemoryEvent(
          "memory.created",
          request.userId,
          child.id,
          child.shared_with_team_id ? { teamId: child.shared_with_team_id } : {},
        );
        reply.code(201);
        return child;
      } catch (err) {
        if (handleThreadingError(reply, err)) {
          return { error: (err as ThreadingError).message };
        }
        throw err;
      }
    },
  );

  server.get(
    "/memories/:id/thread",
    {
      schema: { params: memoryIdParamSchema },
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      // Team-aware read: caller must own the memory OR be on the team it's
      // shared with. This is what lets Van open a thread Tamer started.
      const memory = readMemoryWithTeamAccess(db, request.userId, id);
      if (!memory) {
        reply.code(404);
        return { error: "Memory not found" };
      }
      // Thread is rooted at the parent. If id IS a child, return the parent's
      // thread — more useful than an empty list.
      const rootId = memory.parent_memory_id ?? memory.id;
      const root =
        rootId === memory.id
          ? memory
          : readMemoryWithTeamAccess(db, request.userId, rootId);
      if (!root) {
        reply.code(404);
        return { error: "Thread root not found" };
      }
      const children = listChildren(db, request.userId, rootId);
      request.dataAccessed = true;
      return { parent: root, children };
    },
  );

  // ===========================================================================
  // GET /agent/memories/:id/thread -- Thread fetch for agents (mirrors user)
  // ===========================================================================
  // Same shape as the user endpoint. Vendor-agnostic: an agent can read any
  // thread the user owns. Vendor filtering is intentionally NOT applied to
  // children — a thread is a discussion unit; if the agent can see the
  // parent, it should see the replies.
  // ===========================================================================

  server.get(
    "/agent/memories/:id/thread",
    {
      schema: { params: memoryIdParamSchema },
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const memory = readMemoryWithTeamAccess(db, request.userId, id);
      if (!memory) {
        reply.code(404);
        return { error: "Memory not found" };
      }
      // Vendor allow-list check on the parent — agent shouldn't peek at
      // memories the user wrote against a different vendor scope.
      const allowed =
        memory.allowed_vendors.includes("*") ||
        (request.vendor && memory.allowed_vendors.includes(request.vendor));
      if (!allowed) {
        reply.code(404);
        return { error: "Memory not found" };
      }
      const rootId = memory.parent_memory_id ?? memory.id;
      const root =
        rootId === memory.id
          ? memory
          : readMemoryWithTeamAccess(db, request.userId, rootId);
      if (!root) {
        reply.code(404);
        return { error: "Thread root not found" };
      }
      const children = listChildren(db, request.userId, rootId);
      request.dataAccessed = true;
      return { parent: root, children };
    },
  );

  // ===========================================================================
  // GET /agent/briefing -- Memory briefing for agents (HTTP path)
  // ===========================================================================
  // Mirrors the briefing sent on MCP `initialize.instructions` and the
  // user-facing GET /briefing. Designed for ChatGPT Custom Actions and any
  // other OAuth/agent caller that doesn't speak MCP — they need an explicit
  // endpoint to fetch the briefing on demand.
  //
  // Agents typically prefer JSON output (easier for LLMs to parse against
  // an OpenAPI schema). Markdown available via ?format=markdown.
  // ===========================================================================

  server.get(
    "/agent/briefing",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const qs = request.query as Record<string, string | undefined>;
      const format = qs.format === "markdown" ? "markdown" : "json";
      const topTagsN = qs.top_tags ? parseInt(qs.top_tags, 10) : undefined;
      const recencyDays = qs.recency_days ? parseInt(qs.recency_days, 10) : undefined;
      const activeThreadsN = qs.active_threads
        ? parseInt(qs.active_threads, 10)
        : undefined;

      const briefing = buildMemoryBriefing(db, request.userId, {
        topTagsN,
        recencyDays,
        activeThreadsN,
      });

      if (format === "markdown") {
        reply.header("Content-Type", "text/markdown; charset=utf-8");
        return formatBriefingAsMarkdown(briefing);
      }
      return briefing;
    },
  );

  // ===========================================================================
  // Memory sharing endpoints
  // ===========================================================================

  server.post(
    "/memories/:id/share",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { id: memoryId } = request.params as { id: string };
      const user = getUserById(db, request.userId);
      if (!user?.team_id) return reply.code(400).send({ error: "Not on a team" });

      const result = shareMemoryToTeam(db, memoryId, request.userId, user.team_id);
      if (!result) return reply.code(404).send({ error: "Memory not found or already shared" });
      emitMemoryEvent("memory.shared", request.userId, memoryId, {
        teamId: user.team_id,
      });

      // Share cascades to children: any replies under this parent become
      // visible to the team too. Operates on ALL children regardless of
      // author — the whole thread's visibility flips together.
      if (!result.parent_memory_id) {
        const sharedIds = cascadeShare(db, memoryId, user.team_id);
        for (const childId of sharedIds) {
          // We use request.userId for the event scope so it lands on the
          // sharing user's stream too. The team channel is the important one
          // since teammates receive shared events through it.
          emitMemoryEvent("memory.shared", request.userId, childId, {
            teamId: user.team_id,
          });
        }
      }
      return result;
    },
  );

  server.post(
    "/memories/:id/unshare",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { id: memoryId } = request.params as { id: string };
      // Capture team id BEFORE unshare so we still know which team channel
      // to notify (the row's shared_with_team_id is cleared in the mutation).
      const priorRow = db
        .prepare("SELECT shared_with_team_id, parent_memory_id FROM memories WHERE id = ? AND user_id = ?")
        .get(memoryId, request.userId) as
        | { shared_with_team_id: string | null; parent_memory_id: string | null }
        | undefined;
      const priorTeamId = priorRow?.shared_with_team_id ?? null;

      const result = unshareMemory(db, memoryId, request.userId);
      if (!result) return reply.code(404).send({ error: "Memory not found" });
      emitMemoryEvent("memory.unshared", request.userId, memoryId, {
        teamId: priorTeamId,
      });

      if (priorRow && priorRow.parent_memory_id === null) {
        const unsharedIds = cascadeUnshare(db, memoryId);
        for (const childId of unsharedIds) {
          emitMemoryEvent("memory.unshared", request.userId, childId, {
            teamId: priorTeamId,
          });
        }
      }
      return result;
    },
  );

  server.get(
    "/teams/:id/memories",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { id: teamId } = request.params as { id: string };
      const user = getUserById(db, request.userId);
      if (!user || user.team_id !== teamId) {
        return reply.code(403).send({ error: "Not a member of this team" });
      }

      const qs = request.query as { limit?: string; offset?: string; term?: string };
      const pagination: PaginationOptions = {
        limit: qs.limit ? parseInt(qs.limit, 10) : 50,
        offset: qs.offset ? parseInt(qs.offset, 10) : 0,
      };

      const term = qs.term?.trim() ?? "";
      if (term.length > 0) {
        const memories = searchTeamMemories(db, teamId, term, pagination);
        const total = countSearchTeamMemories(db, teamId, term);
        return { memories, total, term };
      }

      const memories = listTeamMemories(db, teamId, pagination);
      const total = countTeamMemories(db, teamId);
      return { memories, total };
    },
  );

  // ===========================================================================
  // Team management endpoints
  // ===========================================================================

  server.patch(
    "/teams/:id",
    {
      schema: {
        body: {
          type: "object" as const,
          properties: {
            name: { type: "string" as const, minLength: 1, maxLength: 100 },
          },
          additionalProperties: false,
        },
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id: teamId } = request.params as { id: string };
      const user = getUserById(db, request.userId);
      if (!user || user.team_id !== teamId || user.team_role !== "owner") {
        return reply.code(403).send({ error: "Only team owner can update" });
      }

      const body = request.body as { name?: string };
      if (body.name) {
        db.prepare(`UPDATE teams SET name = ?, updated_at = ? WHERE id = ?`).run(
          body.name.trim(),
          new Date().toISOString(),
          teamId,
        );
      }

      return { success: true };
    },
  );

  server.delete(
    "/teams/:id/members/:userId",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { id: teamId, userId: targetUserId } = request.params as { id: string; userId: string };
      const user = getUserById(db, request.userId);
      if (!user || user.team_id !== teamId || user.team_role !== "owner") {
        return reply.code(403).send({ error: "Only team owner can remove members" });
      }
      if (targetUserId === request.userId) {
        return reply.code(400).send({ error: "Cannot remove yourself" });
      }

      removeUserFromTeam(db, targetUserId);
      return { success: true };
    },
  );

  server.post(
    "/teams/leave",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = getUserById(db, request.userId);
      if (!user?.team_id) return reply.code(400).send({ error: "Not on a team" });
      if (user.team_role === "owner") {
        return reply.code(400).send({ error: "Team owner cannot leave. Transfer ownership or delete the team." });
      }

      removeUserFromTeam(db, request.userId);
      return { success: true };
    },
  );

  server.delete(
    "/teams/:id/invites/:inviteId",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { id: teamId, inviteId } = request.params as { id: string; inviteId: string };
      const user = getUserById(db, request.userId);
      if (!user || user.team_id !== teamId || user.team_role !== "owner") {
        return reply.code(403).send({ error: "Only team owner can revoke invites" });
      }

      db.prepare(`DELETE FROM team_invites WHERE id = ? AND team_id = ?`).run(inviteId, teamId);
      return { success: true };
    },
  );

  // ===========================================================================
  // User profile update (name)
  // ===========================================================================

  server.patch(
    "/users/me",
    {
      schema: {
        body: {
          type: "object" as const,
          properties: {
            first_name: { type: "string" as const, maxLength: 100 },
            last_name: { type: "string" as const, maxLength: 100 },
          },
          additionalProperties: false,
        },
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = request.body as { first_name?: string; last_name?: string };
      if (body.first_name !== undefined || body.last_name !== undefined) {
        updateUserName(db, request.userId, body.first_name ?? "", body.last_name ?? "");
      }
      const updated = getUserById(db, request.userId);
      return updated;
    },
  );

  server.get(
    "/users/me",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      return getUserById(db, request.userId);
    },
  );

  return server;
}
