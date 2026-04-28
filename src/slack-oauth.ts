/**
 * Slack OAuth helpers — state signing, install URL building, code exchange.
 *
 * The OAuth state parameter must:
 *   - Be unforgeable (CSRF protection — Slack will redirect back to our
 *     callback with whatever state we sent; we have to verify it's something
 *     WE issued, not something the attacker crafted).
 *   - Carry the originating Reflect user_id so the callback knows who
 *     installed the workspace.
 *   - Have a short TTL (10 minutes) so a leaked URL doesn't allow indefinite
 *     install redirection.
 *
 * We HMAC-SHA256 the (userId, timestamp, nonce) tuple with a secret derived
 * from the encryption master key (so we don't need yet another env var).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { decryptString, encryptString } from "./llm-key-crypto.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_SALT = "slack:oauth-state-v1";

/**
 * Signs an OAuth state for the given Reflect user. The state is opaque and
 * URL-safe; verifyState returns the user_id back if valid.
 */
export function signOauthState(reflectUserId: string): string {
  const payload = JSON.stringify({
    u: reflectUserId,
    t: Date.now(),
    n: randomBytes(8).toString("hex"),
  });
  const blob = encryptString(payload, STATE_SALT);
  // Pack as: base64url(nonce) . base64url(ciphertext)
  return `${blob.nonce.toString("base64url")}.${blob.ciphertext.toString("base64url")}`;
}

export interface VerifiedState {
  reflectUserId: string;
  ageMs: number;
}

export function verifyOauthState(state: string): VerifiedState | null {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  let nonce: Buffer;
  let ciphertext: Buffer;
  try {
    nonce = Buffer.from(parts[0], "base64url");
    ciphertext = Buffer.from(parts[1], "base64url");
  } catch {
    return null;
  }
  let payloadJson: string;
  try {
    payloadJson = decryptString({ nonce, ciphertext }, STATE_SALT);
  } catch {
    return null;
  }
  let parsed: { u?: unknown; t?: unknown; n?: unknown };
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (typeof parsed.u !== "string" || typeof parsed.t !== "number") {
    return null;
  }
  const ageMs = Date.now() - parsed.t;
  if (ageMs < 0 || ageMs > STATE_TTL_MS) return null;
  return { reflectUserId: parsed.u, ageMs };
}

export interface SlackOauthConfig {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  redirectUri: string;
}

export function loadSlackOauthConfig(envPrefix: "REFLECT_DEV_SLACK" | "REFLECT_PROD_SLACK"): SlackOauthConfig | null {
  const clientId = process.env[`${envPrefix}_CLIENT_ID`];
  const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`];
  const signingSecret = process.env[`${envPrefix}_SIGNING_SECRET`];
  const redirectUri = process.env[`${envPrefix}_REDIRECT_URI`];
  if (!clientId || !clientSecret || !signingSecret || !redirectUri) {
    return null;
  }
  return {
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    signingSecret: signingSecret.trim(),
    redirectUri: redirectUri.trim(),
  };
}

/**
 * Resolves which Slack OAuth config to use. Defaults to dev unless the
 * RM_SLACK_ENV env explicitly says prod. Returns null if no config is set
 * for the resolved env.
 */
export function getActiveSlackConfig(): SlackOauthConfig | null {
  const env = (process.env.RM_SLACK_ENV ?? "dev").toLowerCase();
  if (env === "prod") return loadSlackOauthConfig("REFLECT_PROD_SLACK");
  return loadSlackOauthConfig("REFLECT_DEV_SLACK");
}

const BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "im:history",
  "im:read",
  "im:write",
  "users:read",
  "users:read.email",
  "team:read",
  "channels:read",
  "groups:read",
];

/**
 * Builds the Slack OAuth v2 authorization URL with the given signed state.
 */
export function buildInstallUrl(config: SlackOauthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    scope: BOT_SCOPES.join(","),
    redirect_uri: config.redirectUri,
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export interface SlackOauthExchangeResult {
  ok: true;
  slackTeamId: string;
  slackTeamName: string;
  botUserId: string;
  botToken: string;
}

export interface SlackOauthExchangeError {
  ok: false;
  error: string;
}

/**
 * Exchanges an OAuth code for a bot token via Slack's oauth.v2.access endpoint.
 * Returns the workspace metadata + bot token on success.
 */
export async function exchangeOauthCode(
  config: SlackOauthConfig,
  code: string,
): Promise<SlackOauthExchangeResult | SlackOauthExchangeError> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
  });
  let res: Response;
  try {
    res = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Network error contacting Slack: ${err instanceof Error ? err.message : err}`,
    };
  }
  let data: {
    ok?: boolean;
    error?: string;
    access_token?: string;
    bot_user_id?: string;
    team?: { id?: string; name?: string };
  };
  try {
    data = (await res.json()) as typeof data;
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse Slack response: ${err instanceof Error ? err.message : err}`,
    };
  }
  if (!data.ok) {
    return { ok: false, error: data.error ?? "Slack returned ok=false" };
  }
  if (!data.access_token || !data.bot_user_id || !data.team?.id || !data.team?.name) {
    return { ok: false, error: "Slack response missing required fields" };
  }
  return {
    ok: true,
    slackTeamId: data.team.id,
    slackTeamName: data.team.name,
    botUserId: data.bot_user_id,
    botToken: data.access_token,
  };
}

/**
 * Verifies a Slack request signature per the Slack signing-secret protocol.
 *   v0:<timestamp>:<raw_body> -> HMAC-SHA256 with signing_secret -> "v0=<hex>"
 * Returns true iff:
 *   - The signature header matches the computed HMAC (timing-safe).
 *   - The timestamp is within `toleranceSeconds` of now (default 5 min).
 */
export function verifySlackSignature(options: {
  signingSecret: string;
  timestamp: string;
  signature: string;
  rawBody: string;
  toleranceSeconds?: number;
}): boolean {
  const tolerance = options.toleranceSeconds ?? 300;
  const ts = parseInt(options.timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > tolerance) return false;
  const base = `v0:${options.timestamp}:${options.rawBody}`;
  const expected = `v0=${createHmac("sha256", options.signingSecret).update(base).digest("hex")}`;
  if (expected.length !== options.signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(options.signature));
  } catch {
    return false;
  }
}

/**
 * Optional helper: revoke a bot token via Slack's auth.revoke endpoint.
 * Best-effort; we don't surface the result to the user (uninstall in our DB
 * has already happened). Logs failures.
 */
export async function revokeSlackToken(botToken: string): Promise<void> {
  try {
    await fetch("https://slack.com/api/auth.revoke", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
  } catch {
    // best-effort; nothing actionable to do here
  }
}
