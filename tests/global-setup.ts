// Vitest globalSetup: spawns a real Reflect-Memory API server against a
// temp SQLite DB with RM_TEST_MODE=1, waits for /health, writes the config
// to tests/.test-server.json. Torn down in globalTeardown.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const CONFIG_FILE = join(__dirname, ".test-server.json");
const READY_TIMEOUT_MS = 20_000;

interface ServerHandle {
  proc: ChildProcess;
  tmpDir: string;
}

let handle: ServerHandle | null = null;

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms. Last err: ${String(lastErr)}`);
}

function pickPort(): number {
  // 19000-19999 range is reserved for ephemeral test servers
  return 19000 + Math.floor(Math.random() * 1000);
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export async function setup(): Promise<void> {
  const port = pickPort();
  const mcpPort = port + 1000;
  const tmpDir = mkdtempSync(join(tmpdir(), "reflect-test-"));
  const dbPath = join(tmpDir, "reflect-memory.db");

  const apiKey = `rm_test_${randomHex(24)}`;
  const agentCursor = randomHex(32);
  const agentClaude = randomHex(32);
  const dashboardServiceKey = randomHex(32);
  const dashboardJwtSecret = randomHex(32);
  // Shared with in-process tests via .test-server.json so they can encrypt /
  // decrypt blobs created by the test server (e.g. directly upserting a
  // slack_workspaces row in a test, then having the server's uninstall
  // route decrypt the bot token).
  const llmKeyMasterKey = randomHex(32);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    RM_TEST_MODE: "1",
    RM_PORT: String(port),
    RM_MCP_PORT: String(mcpPort),
    RM_DB_PATH: dbPath,
    RM_API_KEY: apiKey,
    RM_OWNER_EMAIL: "owner@test.local",
    RM_MODEL_API_KEY: "sk-test-fake",
    RM_MODEL_NAME: "gpt-4o-mini",
    RM_AGENT_KEY_CURSOR: agentCursor,
    RM_AGENT_KEY_CLAUDE: agentClaude,
    RM_DASHBOARD_SERVICE_KEY: dashboardServiceKey,
    RM_DASHBOARD_JWT_SECRET: dashboardJwtSecret,
    RM_PUBLIC_URL: `http://127.0.0.1:${port}`,
    // Always-on in tests so log-export integration tests work; the
    // "disabled returns 404" path is covered by unit/source assertions.
    RM_LOG_SHARING_ENABLED: "true",
    // 32-byte hex master key for AES-256-GCM LLM key encryption.
    // Random per test-server boot so a leaked test fixture can't decrypt
    // anything in another env.
    RM_LLM_KEY_ENCRYPTION_KEY: llmKeyMasterKey,
    // Stub Slack OAuth config so /slack/install-url returns a 200 (the
    // integration tests check the URL shape, not actual install). Real
    // exchange against slack.com is exercised during manual smoke.
    REFLECT_DEV_SLACK_CLIENT_ID: "1234567890.0987654321",
    REFLECT_DEV_SLACK_CLIENT_SECRET: "test-client-secret",
    REFLECT_DEV_SLACK_SIGNING_SECRET: "test-signing-secret",
    REFLECT_DEV_SLACK_REDIRECT_URI: `http://127.0.0.1:${port}/slack/oauth/callback`,
    RM_DASHBOARD_PUBLIC_URL: `http://127.0.0.1:${port + 1}`,
    RM_DASHBOARD_URL: `http://127.0.0.1:${port + 1}`,
    STRIPE_SECRET_KEY: "sk_test_fake",
    STRIPE_WEBHOOK_SECRET: "whsec_test_fake",
    STRIPE_PRICE_PRO: "price_test_pro",
    STRIPE_PRICE_TEAM: "price_test_team",
    CLERK_WEBHOOK_SECRET: "whsec_test_clerk",
    RESEND_API_KEY: "re_test_fake",
  };

  const proc = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env,
    cwd: join(__dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs: string[] = [];
  proc.stdout?.on("data", (chunk: Buffer) => logs.push(`[stdout] ${chunk.toString()}`));
  proc.stderr?.on("data", (chunk: Buffer) => logs.push(`[stderr] ${chunk.toString()}`));
  proc.on("exit", (code, signal) => {
    logs.push(`[exit] code=${code} signal=${signal}`);
  });

  try {
    await waitForHealth(port, READY_TIMEOUT_MS);
  } catch (err) {
    proc.kill("SIGKILL");
    rmSync(tmpDir, { recursive: true, force: true });
    console.error("Test server failed to start:\n" + logs.join(""));
    throw err;
  }

  const config = {
    port,
    mcpPort,
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey,
    agentKeys: {
      cursor: agentCursor,
      claude: agentClaude,
    },
    dashboardServiceKey,
    dashboardJwtSecret,
    llmKeyMasterKey,
    ownerEmail: "owner@test.local",
    tmpDir,
    dbPath,
  };
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

  handle = { proc, tmpDir };
}

export async function teardown(): Promise<void> {
  if (!handle) return;
  handle.proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  if (!handle.proc.killed) handle.proc.kill("SIGKILL");
  try {
    rmSync(handle.tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
  try {
    rmSync(CONFIG_FILE, { force: true });
  } catch {
    // Best-effort cleanup
  }
}
