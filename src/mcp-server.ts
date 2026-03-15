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
import type Database from "better-sqlite3";
import { ReflectOAuthProvider } from "./oauth-store.js";
import {
  listMemories,
  listMemorySummaries,
  createMemory,
  readMemoryById,
  countMemories,
  type PaginationOptions,
} from "./memory-service.js";

export interface McpServerConfig {
  db: Database.Database;
  userId: string;
  agentKeys: Record<string, string>;
  publicUrl?: string;
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

  return mcp;
}

export function startMcpServer(config: McpServerConfig, port: number): void {
  const { db, userId, agentKeys, publicUrl } = config;

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
  const oauthProvider = new ReflectOAuthProvider({ db, issuerUrl: baseUrl });
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
  // Hybrid auth: legacy RM_AGENT_KEY_* tokens + OAuth Bearer tokens
  // ---------------------------------------------------------------------------

  const hybridVerifier: OAuthTokenVerifier = {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const vendor = resolveVendor(token);
      if (vendor) {
        return {
          token,
          clientId: `legacy_${vendor}`,
          scopes: ["mcp:read", "mcp:write"],
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
          extra: { vendor, isLegacy: true },
        };
      }
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

    if (auth.extra?.isLegacy) {
      (req as any).vendor = auth.extra.vendor as string;
    } else {
      const client = oauthProvider.clientsStore.getClient(auth.clientId) as
        | { client_name?: string }
        | undefined;
      (req as any).vendor =
        client?.client_name?.toLowerCase().replace(/[^a-z0-9]/g, "") || "oauth";
    }
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

        const mcp = createMcpServerWithTools(db, userId, vendor);
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
    res.json({ service: "reflect-memory-mcp", status: "ok" });
  });

  const vendors = Object.keys(agentKeys);
  app.listen(port, "0.0.0.0", () => {
    console.log(`MCP server listening on port ${port} (vendors: ${vendors.join(", ")})`);
    console.log(`OAuth: ${baseUrl}/.well-known/oauth-authorization-server`);
    console.log(`Connector URL: ${baseUrl}/mcp`);
  });
}
