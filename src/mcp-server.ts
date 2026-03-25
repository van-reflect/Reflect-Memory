// Reflect Memory -- MCP Server
// Remote Streamable HTTP MCP server for any vendor that supports MCP.
// Exposes memory tools (read, write, browse, query) via the Model Context Protocol.
// Runs as a standalone Express app on RM_MCP_PORT (default: 3001).
// Auth: Bearer token validated via OAuth 2.1 or legacy RM_AGENT_KEY_* tokens.

import express from "express";
import { randomUUID, createHash, timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { jwtVerify } from "jose";
import type Database from "better-sqlite3";
import { ReflectOAuthProvider, resolveAgentKeyUser, hasUserIdColumns } from "./oauth-store.js";
import { authenticateApiKey } from "./api-key-service.js";
import { findOrCreateUserByEmail, getUserById } from "./user-service.js";
import {
  listMemories,
  listMemorySummaries,
  createMemory,
  readMemoryById,
  countMemories,
  shareMemoryToTeam,
  listTeamMemories,
  type PaginationOptions,
} from "./memory-service.js";

export interface McpServerConfig {
  db: Database.Database;
  /** Fallback userId only used when no per-user resolution is possible */
  userId: string;
  agentKeys: Record<string, string>;
  publicUrl?: string;
  dashboardUrl?: string;
  dashboardJwtSecret?: string;
  dashboardServiceKey?: string;
}

function createMcpServerWithTools(
  db: Database.Database,
  userId: string,
  vendor: string,
): McpServer {
  const mcp = new McpServer(
    { name: "reflect-memory", version: "1.0.0" },
    { capabilities: { logging: {}, tools: { listChanged: false } } },
  );

  mcp.tool(
    "read_memories",
    "Get the most recent memories. Returns full content. Use limit to control how many.",
    { limit: z.number().min(1).max(50).default(10).describe("Max memories to return (1-50)") },
    { title: "Read Memories", readOnlyHint: true },
    async ({ limit }) => {
      const memories = listMemories(db, userId, { by: "all" }, vendor, { limit });
      return {
        content: [{ type: "text", text: JSON.stringify(memories, null, 2) }],
      };
    },
  );

  mcp.tool(
    "get_memory_by_id",
    "Retrieve a single memory by its UUID. Returns full content.",
    { id: z.string().describe("The memory UUID") },
    { title: "Get Memory by ID", readOnlyHint: true },
    async ({ id }) => {
      const memory = readMemoryById(db, userId, id);
      if (!memory || memory.deleted_at) {
        return { content: [{ type: "text", text: "Memory not found" }], isError: true };
      }
      const allowed = memory.allowed_vendors.includes("*") || memory.allowed_vendors.includes(vendor);
      if (!allowed) {
        return { content: [{ type: "text", text: "Memory not found" }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(memory, null, 2) }] };
    },
  );

  mcp.tool(
    "get_latest_memory",
    "Get the single most recent memory, ordered by created_at. Optional tag filter.",
    { tag: z.string().optional().describe("Optional tag to filter by") },
    { title: "Get Latest Memory", readOnlyHint: true },
    async ({ tag }) => {
      const filter = tag ? { by: "tags" as const, tags: [tag] } : { by: "all" as const };
      const memories = listMemories(db, userId, filter, vendor, { limit: 1 });
      if (memories.length === 0) {
        return { content: [{ type: "text", text: tag ? `No memories with tag "${tag}"` : "No memories found" }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(memories[0], null, 2) }] };
    },
  );

  mcp.tool(
    "browse_memories",
    "Browse memory summaries (title, tags, dates - no content). Use to discover what exists before reading specific ones.",
    {
      limit: z.number().min(1).max(200).default(50).describe("Max results"),
      offset: z.number().min(0).default(0).describe("Skip this many results"),
    },
    { title: "Browse Memories", readOnlyHint: true },
    async ({ limit, offset }) => {
      const summaries = listMemorySummaries(db, userId, { by: "all" }, vendor, { limit, offset });
      const total = countMemories(db, userId, { by: "all" }, vendor);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ memories: summaries, total, limit, offset, has_more: offset + summaries.length < total }, null, 2),
        }],
      };
    },
  );

  mcp.tool(
    "search_memories",
    "Search memories by text in title or content. Returns full content.",
    {
      term: z.string().min(1).describe("Search term"),
      limit: z.number().min(1).max(50).default(10).describe("Max results"),
    },
    { title: "Search Memories", readOnlyHint: true },
    async ({ term, limit }) => {
      const memories = listMemories(db, userId, { by: "search", term }, vendor, { limit });
      return { content: [{ type: "text", text: JSON.stringify(memories, null, 2) }] };
    },
  );

  mcp.tool(
    "get_memories_by_tag",
    "Get full-body memories filtered by tags. Returns memories matching ANY of the given tags.",
    {
      tags: z.array(z.string()).min(1).describe("Tags to filter by"),
      limit: z.number().min(1).max(100).default(20).describe("Max results"),
      offset: z.number().min(0).default(0).describe("Skip this many"),
    },
    { title: "Get Memories by Tag", readOnlyHint: true },
    async ({ tags, limit, offset }) => {
      const memories = listMemories(db, userId, { by: "tags", tags }, vendor, { limit, offset });
      const total = countMemories(db, userId, { by: "tags", tags }, vendor);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ memories, total, limit, offset, has_more: offset + memories.length < total }, null, 2),
        }],
      };
    },
  );

  mcp.tool(
    "write_memory",
    "Create a new memory entry. Returns the created memory with its ID.",
    {
      title: z.string().min(1).describe("Short title for the memory"),
      content: z.string().min(1).describe("The memory content"),
      tags: z.array(z.string()).default([]).describe("Tags for categorization"),
      allowed_vendors: z.array(z.string()).default(["*"]).describe("Which vendors can see this. Use ['*'] for all."),
      memory_type: z.enum(["semantic", "episodic", "procedural"]).default("semantic").describe("Type of memory: semantic (facts/knowledge), episodic (events/decisions), procedural (workflows/patterns)"),
    },
    { title: "Create Memory", destructiveHint: true },
    async ({ title, content, tags, allowed_vendors, memory_type }) => {
      const memory = createMemory(db, userId, {
        title,
        content,
        tags,
        origin: vendor,
        allowed_vendors,
        memory_type,
      });
      return { content: [{ type: "text", text: JSON.stringify(memory, null, 2) }] };
    },
  );

  // ---------------------------------------------------------------------------
  // Team memory tools — shared knowledge pool across team members
  // ---------------------------------------------------------------------------

  mcp.tool(
    "read_team_memories",
    "Get memories shared with your team. Returns the team knowledge pool with author attribution. Only available if you belong to a team.",
    {
      limit: z.number().min(1).max(50).default(20).describe("Max team memories to return (1-50)"),
      offset: z.number().min(0).default(0).describe("Skip this many results for pagination"),
    },
    { title: "Read Team Memories", readOnlyHint: true },
    async ({ limit, offset }) => {
      const user = getUserById(db, userId);
      if (!user?.team_id) {
        return { content: [{ type: "text", text: "You are not part of a team. Team memories are only available to team members." }], isError: true };
      }

      const memories = listTeamMemories(db, user.team_id, { limit, offset });
      if (memories.length === 0) {
        return { content: [{ type: "text", text: "No shared team memories yet. Use share_memory to share a personal memory with your team." }] };
      }

      const formatted = memories.map((m) => ({
        id: m.id,
        title: m.title,
        content: m.content,
        tags: m.tags,
        origin: m.origin,
        memory_type: m.memory_type,
        author: [m.author_first_name, m.author_last_name].filter(Boolean).join(" ") || m.author_email,
        shared_at: m.shared_at,
        created_at: m.created_at,
      }));

      return { content: [{ type: "text", text: JSON.stringify({ team_memories: formatted, count: formatted.length, offset, has_more: formatted.length === limit }, null, 2) }] };
    },
  );

  mcp.tool(
    "share_memory",
    "Share one of your personal memories with your team. The memory becomes visible to all team members via read_team_memories. You must own the memory.",
    {
      memory_id: z.string().describe("The UUID of your memory to share with the team"),
    },
    { title: "Share Memory with Team", destructiveHint: true },
    async ({ memory_id }) => {
      const user = getUserById(db, userId);
      if (!user?.team_id) {
        return { content: [{ type: "text", text: "You are not part of a team. Team sharing is only available to team members." }], isError: true };
      }

      const updated = shareMemoryToTeam(db, memory_id, userId, user.team_id);
      if (!updated) {
        return { content: [{ type: "text", text: "Memory not found or you don't own it." }], isError: true };
      }

      return { content: [{ type: "text", text: JSON.stringify({ shared: true, memory: updated }, null, 2) }] };
    },
  );

  return mcp;
}

export function startMcpServer(config: McpServerConfig, port: number): void {
  const { db, userId, agentKeys, publicUrl, dashboardUrl, dashboardJwtSecret, dashboardServiceKey } = config;

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // ---------------------------------------------------------------------------
  // Legacy key helpers (backward compat for Cursor, n8n, etc.)
  // ---------------------------------------------------------------------------

  function constantTimeEqual(a: string, b: string): boolean {
    const hashA = createHash("sha256").update(a).digest();
    const hashB = createHash("sha256").update(b).digest();
    return cryptoTimingSafeEqual(hashA, hashB);
  }

  function resolveVendor(token: string): string | null {
    for (const [vendor, key] of Object.entries(agentKeys)) {
      if (constantTimeEqual(token, key)) return vendor;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // OAuth 2.1 setup
  // ---------------------------------------------------------------------------

  const baseUrl = publicUrl || `http://localhost:${port}`;
  const oauthProvider = new ReflectOAuthProvider({ db, issuerUrl: baseUrl, dashboardUrl });
  const mcpResourceUrl = new URL(`${baseUrl}/mcp`);

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(baseUrl),
      resourceServerUrl: mcpResourceUrl,
      scopesSupported: ["mcp:read", "mcp:write"],
      resourceName: "Reflect Memory MCP",
      serviceDocumentationUrl: new URL("https://reflectmemory.com/docs"),
    }),
  );

  // ---------------------------------------------------------------------------
  // OAuth consent callback: dashboard redirects here after user approves
  // ---------------------------------------------------------------------------

  app.get("/oauth/approve", async (req, res) => {
    const token = req.query.token as string | undefined;
    if (!token) {
      res.status(400).json({ error: "Missing approval token" });
      return;
    }

    if (!dashboardJwtSecret) {
      console.error("[oauth] RM_DASHBOARD_JWT_SECRET not configured");
      res.status(500).json({ error: "OAuth consent not configured on server" });
      return;
    }

    // Step 1: Verify the JWT from the dashboard
    let payload: Record<string, unknown>;
    try {
      const key = new TextEncoder().encode(dashboardJwtSecret);
      const result = await jwtVerify(token, key, {
        audience: "reflect-memory",
        issuer: "reflect-dashboard",
      });
      payload = result.payload as Record<string, unknown>;
    } catch (err) {
      const msg = (err as Error).message || String(err);
      console.error(`[oauth] JWT verification failed: ${msg}`);
      res.status(403).json({ error: "Token verification failed. Check that AUTH_SECRET and RM_DASHBOARD_JWT_SECRET match." });
      return;
    }

    const pendingId = payload.pending_id as string;
    if (!pendingId) {
      res.status(400).json({ error: "Missing pending_id in approval token" });
      return;
    }

    // Step 2: Resolve the user from the email in the JWT (non-fatal if it fails)
    let approvedUserId: string | undefined;
    const email = payload.email as string | undefined;
    if (email) {
      try {
        approvedUserId = findOrCreateUserByEmail(db, email);
        console.log(`[oauth] Resolved user ${approvedUserId} from email ${email}`);
      } catch (err) {
        console.error(`[oauth] User resolution failed for ${email}: ${(err as Error).message}`);
      }
    }

    // Step 3: Approve the pending request and redirect
    try {
      const redirectUrl = oauthProvider.approvePendingRequest(pendingId, approvedUserId);
      res.redirect(302, redirectUrl);
    } catch (err) {
      const msg = (err as Error).message || String(err);
      console.error(`[oauth] Pending request approval failed: ${msg}`);
      if (msg.includes("expired")) {
        res.status(410).json({ error: "Authorization request expired. Go back to your AI tool and try connecting again." });
      } else if (msg.includes("not found")) {
        res.status(404).json({ error: "Authorization request not found. It may have been used already. Try connecting again." });
      } else {
        res.status(500).json({ error: `Approval failed: ${msg}` });
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Server-to-server approval (dashboard calls this with its service key)
  // ---------------------------------------------------------------------------

  app.post("/oauth/approve-s2s", express.json(), async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing authorization" });
      return;
    }

    const token = authHeader.slice(7);
    const isDashboardKey = dashboardServiceKey && constantTimeEqual(token, dashboardServiceKey);
    const vendor = isDashboardKey ? "dashboard" : resolveVendor(token);
    if (!vendor) {
      res.status(403).json({ error: "Invalid service key" });
      return;
    }

    const { pending_id, email } = req.body as { pending_id?: string; email?: string };
    if (!pending_id) {
      res.status(400).json({ error: "Missing pending_id" });
      return;
    }

    let approvedUserId: string | undefined;
    if (email) {
      try {
        approvedUserId = findOrCreateUserByEmail(db, email);
        console.log(`[oauth-s2s] Resolved user ${approvedUserId} from email ${email}`);
      } catch (err) {
        console.error(`[oauth-s2s] User resolution failed for ${email}: ${(err as Error).message}`);
      }
    }

    try {
      const redirectUrl = oauthProvider.approvePendingRequest(pending_id, approvedUserId);
      res.json({ redirect_url: redirectUrl });
    } catch (err) {
      const msg = (err as Error).message || String(err);
      console.error(`[oauth-s2s] Approval failed: ${msg}`);
      res.status(400).json({ error: msg });
    }
  });

  // ---------------------------------------------------------------------------
  // Hybrid auth: legacy RM_AGENT_KEY_* tokens + OAuth Bearer tokens
  // ---------------------------------------------------------------------------

  const hybridVerifier: OAuthTokenVerifier = {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      // 1. Dashboard-generated per-user API keys (rm_live_*)
      const apiKeyAuth = authenticateApiKey(db, token);
      if (apiKeyAuth) {
        return {
          token,
          clientId: `apikey_${apiKeyAuth.keyId}`,
          scopes: ["mcp:read", "mcp:write"],
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
          extra: { vendor: "apikey", userId: apiKeyAuth.userId, isLegacy: false },
        };
      }

      // 2. Per-user MCP agent keys (rmk_*)
      const dbKey = resolveAgentKeyUser(db, token);
      if (dbKey) {
        return {
          token,
          clientId: `agentkey_${dbKey.vendor}`,
          scopes: ["mcp:read", "mcp:write"],
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
          extra: { vendor: dbKey.vendor, userId: dbKey.userId, isLegacy: false },
        };
      }

      // 3. Legacy env-var keys (backward compat, mapped to global userId)
      const vendor = resolveVendor(token);
      if (vendor) {
        console.warn(`[mcp] Legacy env-var key used (vendor=${vendor}). Migrate to per-user keys.`);
        return {
          token,
          clientId: `legacy_${vendor}`,
          scopes: ["mcp:read", "mcp:write"],
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
          extra: { vendor, userId, isLegacy: true },
        };
      }

      // 4. OAuth tokens (user_id stored on the token row)
      return oauthProvider.verifyAccessToken(token);
    },
  };

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpResourceUrl);

  const bearerAuth = requireBearerAuth({
    verifier: hybridVerifier,
    resourceMetadataUrl,
  });

  app.use("/mcp", bearerAuth, (req, _res, next) => {
    const auth = (req as any).auth as AuthInfo | undefined;
    if (!auth) return next();

    if (auth.extra?.isLegacy || auth.extra?.vendor) {
      (req as any).vendor = auth.extra.vendor as string;
    } else {
      const client = oauthProvider.clientsStore.getClient(auth.clientId) as
        | { client_name?: string }
        | undefined;
      (req as any).vendor =
        client?.client_name?.toLowerCase().replace(/[^a-z0-9]/g, "") || "oauth";
    }

    const resolvedUserId = auth.extra?.userId as string | undefined;
    (req as any).resolvedUserId = resolvedUserId || userId;

    next();
  });

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  const MAX_SESSIONS = 500;
  const SESSION_TTL_MS = 30 * 60 * 1000;

  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const sessionVendors: Record<string, string> = {};
  const sessionLastSeen: Record<string, number> = {};

  setInterval(() => {
    const now = Date.now();
    for (const sid of Object.keys(sessionLastSeen)) {
      if (now - sessionLastSeen[sid] > SESSION_TTL_MS) {
        transports[sid]?.close?.();
        delete transports[sid];
        delete sessionVendors[sid];
        delete sessionLastSeen[sid];
      }
    }
  }, 60_000);

  // ---------------------------------------------------------------------------
  // MCP transport endpoints
  // ---------------------------------------------------------------------------

  app.post("/mcp", async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && transports[sessionId]) {
        sessionLastSeen[sessionId] = Date.now();
        await transports[sessionId].handleRequest(req, res, req.body);
        return;
      }

      // Unknown session → 404 per MCP spec so the client re-initializes
      if (sessionId && !transports[sessionId]) {
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Session not found. Please re-initialize." },
          id: null,
        });
        return;
      }

      if (isInitializeRequest(req.body)) {
        if (Object.keys(transports).length >= MAX_SESSIONS) {
          res.status(503).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Too many active sessions" },
            id: null,
          });
          return;
        }

        const vendor = (req as any).vendor as string;
        const sessionUserId = (req as any).resolvedUserId as string;

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
            sessionVendors[sid] = vendor;
            sessionLastSeen[sid] = Date.now();
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            delete transports[sid];
            delete sessionVendors[sid];
            delete sessionLastSeen[sid];
          }
        };

        console.log(`[mcp] New session for user=${sessionUserId} vendor=${vendor}`);
        const mcp = createMcpServerWithTools(db, sessionUserId, vendor);
        await mcp.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: missing session ID or not an initialize request" },
        id: null,
      });
    } catch (error) {
      console.error("[mcp] Error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId) {
        res.status(400).json({ error: "Missing session ID" });
        return;
      }
      if (!transports[sessionId]) {
        res.status(404).json({ error: "Session not found. Please re-initialize." });
        return;
      }
      sessionLastSeen[sessionId] = Date.now();
      await transports[sessionId].handleRequest(req, res);
    } catch (error) {
      console.error("[mcp] GET error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.delete("/mcp", async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId) {
        res.status(400).json({ error: "Missing session ID" });
        return;
      }
      if (!transports[sessionId]) {
        res.status(404).json({ error: "Session not found." });
        return;
      }
      await transports[sessionId].handleRequest(req, res);
    } catch (error) {
      console.error("[mcp] DELETE error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/health", (_req, res) => {
    const secretLen = dashboardJwtSecret?.length ?? 0;
    const svcKeyLen = dashboardServiceKey?.length ?? 0;

    let dbDiag: Record<string, unknown> = {};
    try {
      const pendingCount = (db.prepare(`SELECT COUNT(*) as c FROM oauth_pending_requests`).get() as { c: number }).c;
      const clientCount = (db.prepare(`SELECT COUNT(*) as c FROM oauth_clients`).get() as { c: number }).c;
      const tokenCount = (db.prepare(`SELECT COUNT(*) as c FROM oauth_tokens`).get() as { c: number }).c;
      const codesCols = (db.prepare(`PRAGMA table_info(oauth_codes)`).all() as { name: string }[]).map(c => c.name);
      const tokensCols = (db.prepare(`PRAGMA table_info(oauth_tokens)`).all() as { name: string }[]).map(c => c.name);
      const pendingCols = (db.prepare(`PRAGMA table_info(oauth_pending_requests)`).all() as { name: string }[]).map(c => c.name);
      dbDiag = {
        pending_requests: pendingCount,
        clients: clientCount,
        tokens: tokenCount,
        codes_has_user_id: codesCols.includes("user_id"),
        tokens_has_user_id: tokensCols.includes("user_id"),
        pending_has_user_id: pendingCols.includes("user_id"),
      };
    } catch (err) {
      dbDiag = { error: (err as Error).message };
    }

    res.json({
      service: "reflect-memory-mcp",
      status: "ok",
      oauth: {
        jwt_secret_configured: secretLen > 0,
        service_key_configured: svcKeyLen > 0,
        has_user_id_cols: hasUserIdColumns(),
        dashboard_url: dashboardUrl || "(not set)",
        public_url: publicUrl || "(not set)",
      },
      db: dbDiag,
      sessions: Object.keys(transports).length,
    });
  });

  // Diagnostic endpoint (proxied via /oauth/status)
  app.get("/oauth/status", (_req, res) => {
    try {
      const pendingCount = (db.prepare(`SELECT COUNT(*) as c FROM oauth_pending_requests`).get() as { c: number }).c;
      const clientCount = (db.prepare(`SELECT COUNT(*) as c FROM oauth_clients`).get() as { c: number }).c;
      const tokenCount = (db.prepare(`SELECT COUNT(*) as c FROM oauth_tokens`).get() as { c: number }).c;
      const codesCols = (db.prepare(`PRAGMA table_info(oauth_codes)`).all() as { name: string }[]).map(c => c.name);
      const tokensCols = (db.prepare(`PRAGMA table_info(oauth_tokens)`).all() as { name: string }[]).map(c => c.name);
      const pendingCols = (db.prepare(`PRAGMA table_info(oauth_pending_requests)`).all() as { name: string }[]).map(c => c.name);
      res.json({
        status: "ok",
        has_user_id_cols: hasUserIdColumns(),
        service_key_configured: (dashboardServiceKey?.length ?? 0) > 0,
        jwt_secret_configured: (dashboardJwtSecret?.length ?? 0) > 0,
        db: {
          pending_requests: pendingCount,
          clients: clientCount,
          tokens: tokenCount,
          codes_has_user_id: codesCols.includes("user_id"),
          tokens_has_user_id: tokensCols.includes("user_id"),
          pending_has_user_id: pendingCols.includes("user_id"),
        },
        sessions: Object.keys(transports).length,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  const vendors = Object.keys(agentKeys);
  app.listen(port, "0.0.0.0", () => {
    console.log(`MCP server listening on port ${port} (vendors: ${vendors.join(", ")})`);
    console.log(`OAuth: ${baseUrl}/.well-known/oauth-authorization-server`);
    console.log(`Connector URL: ${baseUrl}/mcp`);
  });
}
