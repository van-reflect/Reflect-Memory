// Reflect Memory -- HTTP API Layer
// Fastify server with memory CRUD, agent connector, and AI query route.
// No UI. No logging. No default behavior.
// Every request requires auth and explicit intent.

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import proxy from "@fastify/http-proxy";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { jwtVerify } from "jose";
import type Database from "better-sqlite3";
import { findOrCreateUserByEmail } from "./user-service.js";
import type { DeploymentConfig } from "./deployment-config.js";
import { createSsoVerifier, validateSsoConfig } from "./sso-auth.js";
import { recordAuditEvent, queryAuditEvents, countAuditEvents, exportAuditEvents } from "./audit-service.js";
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
  type MemoryType,
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
    authMethod: "dashboard" | "api_key" | "agent_key" | "sso";
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
  deployment: DeploymentConfig;
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
function isCiTestMemory(m: { title: string; tags: string[] }): boolean {
  if (m.title.startsWith("CI ") || m.title.includes("ci-")) return true;
  return m.tags.some(
    (t) => t.startsWith("ci_") || t.includes("integration_test"),
  );
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
  } = config;

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

  // Proxy /mcp and OAuth endpoints to the MCP server (Railway exposes only one port)
  if (mcpPort != null) {
    const mcpUpstream = `http://127.0.0.1:${mcpPort}`;

    await server.register(proxy, {
      upstream: mcpUpstream,
      prefix: "/mcp",
      rewritePrefix: "/mcp",
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
    ];
    for (const oauthPath of oauthPaths) {
      await server.register(proxy, {
        upstream: mcpUpstream,
        prefix: oauthPath,
        rewritePrefix: oauthPath,
      });
    }
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
    if (path === "/health" || path === "/openapi.json") return;
    if (request.method === "POST" && (path === "/waitlist" || path === "/early-access" || path === "/integration-requests")) return;
    if (deployment.allowPublicWebhooks && request.method === "POST" && path === "/webhooks/clerk") return;
    if (deployment.allowPublicWebhooks && request.method === "POST" && path === "/webhooks/stripe") return;

    // OAuth + MCP paths are handled by the MCP server's own auth middleware via proxy
    if (path.startsWith("/.well-known/oauth-")) return;
    if (path.startsWith("/oauth/")) return;
    if (path === "/authorize" || path === "/token" || path === "/register" || path.startsWith("/mcp")) {
      return;
    }

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
      } catch {
        logSecurity("dashboard_token_expired", request, { status_code: 401, auth_method: "dashboard" });
        return reply.code(401).send({ error: "Invalid or expired dashboard token" });
      }
    }

    if (deployment.sso.enabled && token.includes(".") && token.split(".").length === 3) {
      const ssoResult = await verifySsoToken(token);
      if (ssoResult.identity) {
        request.userId = findOrCreateUserByEmail(db, ssoResult.identity.email);
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

  server.get("/whoami", async (request) => {
    return {
      role: request.role,
      vendor: request.vendor,
    };
  });

  // ===========================================================================
  // GET /admin/metrics -- Owner-only usage stats
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
    if (request.userId !== userId) {
      reply.code(403);
      return { error: "Admin access restricted to owner" };
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
    if (request.userId !== userId) {
      reply.code(403);
      return { error: "Admin access restricted to owner" };
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
        origin: request.authMethod === "dashboard" ? "dashboard" : "cursor",
        allowed_vendors: allowedVendors,
        memory_type: body.memory_type as MemoryType | undefined,
      };

      const memory = createMemory(db, request.userId, input);
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
      if (isCiTestMemory(memory)) {
        softDeleteMemory(db, request.userId, memory.id);
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

  server.get("/agent/memories/latest", async (request, reply) => {
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
  // GET /memories/:id -- Read a single memory
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
      request.dataAccessed = true;
      return memory;
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
  // POST /memories/:id/restore -- Restore from trash
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
      if (request.userId !== userId) {
        reply.code(403);
        return { error: "Admin access restricted to owner" };
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
      if (request.userId !== userId) {
        reply.code(403);
        return { error: "Admin access restricted to owner" };
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
      if (request.userId !== userId) {
        reply.code(403);
        return { error: "Admin access restricted to owner" };
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
      if (request.userId !== userId) {
        reply.code(403);
        return { error: "Admin access restricted to owner" };
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
      if (request.userId !== userId) {
        reply.code(403);
        return { error: "Admin access restricted to owner" };
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
            plan: { type: "string" as const, enum: ["pro", "builder"] },
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
        plan: "pro" | "builder";
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
        rateLimit: { max: 100, timeWindow: "1 minute" },
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

      handleStripeWebhook(db, event);
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

      const email = data.email_addresses?.[0]?.email_address?.trim().toLowerCase();

      if (eventType === "user.created" || eventType === "user.updated") {
        if (!email) {
          return reply.code(400).send({ error: "No email in webhook" });
        }

        const existing = db
          .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
          .get(data.id) as { id: string } | undefined;

        if (existing) {
          db.prepare(`UPDATE users SET email = ?, updated_at = ? WHERE clerk_id = ?`)
            .run(email, new Date().toISOString(), data.id);
        } else {
          const byEmail = db
            .prepare(`SELECT id FROM users WHERE email = ?`)
            .get(email) as { id: string } | undefined;

          if (byEmail) {
            db.prepare(`UPDATE users SET clerk_id = ?, updated_at = ? WHERE id = ?`)
              .run(data.id, new Date().toISOString(), byEmail.id);
          } else {
            const newId = randomUUID();
            const now = new Date().toISOString();
            db.prepare(
              `INSERT INTO users (id, clerk_id, email, role, plan, created_at, updated_at)
               VALUES (?, ?, ?, 'user', 'free', ?, ?)`,
            ).run(newId, data.id, email, now, now);
          }
        }

        console.log(`[clerk] Synced user ${data.id} (${email})`);
        return { received: true };
      }

      return { received: true, ignored: true };
    },
  );

  return server;
}
