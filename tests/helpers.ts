// Shared helpers for Vitest integration tests.
// Reads server config written by global-setup.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";

interface TestServerConfig {
  port: number;
  mcpPort: number;
  baseUrl: string;
  apiKey: string;
  agentKeys: {
    cursor: string;
    claude: string;
  };
  dashboardServiceKey: string;
  dashboardJwtSecret: string;
  /** Same value the test server received in RM_LLM_KEY_ENCRYPTION_KEY.
   *  Pin it in your test process before any encryption call so blobs
   *  written by either side are decryptable by the other. */
  llmKeyMasterKey: string;
  ownerEmail: string;
  tmpDir: string;
  dbPath: string;
}

let cached: TestServerConfig | null = null;

// Re-exported as convenience for tests that need the full config.
export type { TestServerConfig };

export function getTestServer(): TestServerConfig {
  if (cached) return cached;
  const path = join(__dirname, ".test-server.json");
  cached = JSON.parse(readFileSync(path, "utf-8")) as TestServerConfig;
  return cached;
}

export interface ApiResponse<T = unknown> {
  status: number;
  json: T;
  text: string;
  headers: Headers;
}

function buildHeaders(
  token: string | null,
  hasBody: boolean,
  extra?: Record<string, string>,
): Record<string, string> {
  const h: Record<string, string> = { ...(extra || {}) };
  // Only send Content-Type when a body is present. Sending it without a body
  // causes Fastify's JSON parser to return 400 on DELETE/GET without body.
  if (hasBody) h["Content-Type"] = "application/json";
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export async function api<T = unknown>(
  method: string,
  path: string,
  options: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {},
): Promise<ApiResponse<T>> {
  const server = getTestServer();
  const token = options.token === undefined ? server.apiKey : options.token;
  const hasBody = options.body !== undefined;
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: buildHeaders(token, hasBody, options.headers),
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json: json as T, text, headers: res.headers };
}

export function withAgentKey(vendor: "cursor" | "claude"): string {
  return getTestServer().agentKeys[vendor];
}

/** Generates a unique tag for tests so parallel tests don't collide. */
export function uniqueTag(prefix = "t"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
