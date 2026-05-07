// Slack OAuth + workspace endpoints — Phase 2.
//
// Coverage:
//   - State HMAC: sign/verify roundtrip, tampering rejection, expiry.
//   - verifySlackSignature: valid sig, wrong sig, stale timestamp.
//   - POST /slack/install-url: admin-only, returns slack.com URL with state.
//   - GET /slack/status: admin-only, null until workspace exists, populated
//     after a manual upsert.
//   - GET /slack/oauth/callback: missing/invalid params -> redirect with
//     error= query param.
//   - DELETE /slack/uninstall: admin-only, 404 when nothing installed,
//     succeeds + audit-events when active.
//
// We do NOT exercise the real slack.com code exchange here (that's a manual
// smoke test). The exchange wrapper is a thin fetch + JSON parse; the
// integration value of mocking it is low.

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHmac } from "node:crypto";
import { api, getTestServer, withAgentKey } from "../helpers";
import {
  signOauthState,
  verifyOauthState,
  verifySlackSignature,
} from "../../src/slack-oauth";
import { upsertSlackWorkspace } from "../../src/slack-workspace-service";
import { _resetMasterKeyCacheForTests } from "../../src/llm-key-crypto";

// Pin the SAME master key the test server uses, so anything we encrypt in
// this process (state strings, bot tokens via direct upsert) can be decrypted
// by the server (verifyOauthState in the OAuth callback, getWorkspaceWith-
// Token in the uninstall route). The test server publishes the key via
// .test-server.json — read it here and pin before any crypto call.
process.env.RM_LLM_KEY_ENCRYPTION_KEY = getTestServer().llmKeyMasterKey;
_resetMasterKeyCacheForTests();

interface InstallUrlResponse {
  url: string;
  state: string;
  redirect_uri: string;
}

interface StatusResponse {
  configured: boolean;
  workspace: {
    id: string;
    slack_team_id: string;
    slack_team_name: string;
    bot_user_id: string;
    reflect_org_id: string | null;
    reflect_user_id: string | null;
    installed_at: string;
    uninstalled_at: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (state HMAC + Slack signature verifier)
// ---------------------------------------------------------------------------

describe("signOauthState / verifyOauthState (unit)", () => {
  it("roundtrips a user id through the signed state", () => {
    const state = signOauthState("user-abc-123");
    const verified = verifyOauthState(state);
    expect(verified).not.toBeNull();
    expect(verified?.reflectUserId).toBe("user-abc-123");
    expect(verified?.ageMs ?? 0).toBeGreaterThanOrEqual(0);
    expect(verified?.ageMs ?? Infinity).toBeLessThan(2000);
  });

  it("rejects a tampered state", () => {
    const state = signOauthState("user-1");
    const parts = state.split(".");
    // Corrupt one byte of the ciphertext.
    const corrupted = Buffer.from(parts[1], "base64url");
    corrupted[0] = corrupted[0] ^ 0x01;
    const tampered = `${parts[0]}.${corrupted.toString("base64url")}`;
    expect(verifyOauthState(tampered)).toBeNull();
  });

  it("rejects a totally bogus state", () => {
    expect(verifyOauthState("not.a.real.state")).toBeNull();
    expect(verifyOauthState("garbage")).toBeNull();
    expect(verifyOauthState("")).toBeNull();
  });

  it("rejects an expired state (older than 10 min)", () => {
    // Hand-roll a state with an old timestamp by encrypting it ourselves.
    // Easier: monkey-patch Date.now and re-sign.
    const origNow = Date.now.bind(Date);
    try {
      Date.now = () => origNow() - 11 * 60 * 1000;
      const oldState = signOauthState("user-stale");
      Date.now = origNow;
      expect(verifyOauthState(oldState)).toBeNull();
    } finally {
      Date.now = origNow;
    }
  });
});

describe("verifySlackSignature (unit)", () => {
  const signingSecret = "test-secret";
  const body = '{"type":"event_callback"}';

  function signBody(timestamp: string): string {
    const base = `v0:${timestamp}:${body}`;
    return `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  }

  it("accepts a valid signature with current timestamp", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signBody(ts);
    expect(
      verifySlackSignature({
        signingSecret,
        timestamp: ts,
        signature: sig,
        rawBody: body,
      }),
    ).toBe(true);
  });

  it("rejects when signature is wrong", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(
      verifySlackSignature({
        signingSecret,
        timestamp: ts,
        signature: "v0=deadbeef",
        rawBody: body,
      }),
    ).toBe(false);
  });

  it("rejects when timestamp is stale (>5 min by default)", () => {
    const stale = String(Math.floor(Date.now() / 1000) - 600);
    const sig = signBody(stale);
    expect(
      verifySlackSignature({
        signingSecret,
        timestamp: stale,
        signature: sig,
        rawBody: body,
      }),
    ).toBe(false);
  });

  it("rejects when timestamp is in the future beyond tolerance", () => {
    const future = String(Math.floor(Date.now() / 1000) + 600);
    const sig = signBody(future);
    expect(
      verifySlackSignature({
        signingSecret,
        timestamp: future,
        signature: sig,
        rawBody: body,
      }),
    ).toBe(false);
  });

  it("rejects an empty/non-numeric timestamp", () => {
    expect(
      verifySlackSignature({
        signingSecret,
        timestamp: "abc",
        signature: "v0=00",
        rawBody: body,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HTTP integration tests
// ---------------------------------------------------------------------------

describe("POST /slack/install-url", () => {
  it("403 for non-admin (agent key)", async () => {
    const r = await api<{ error: string }>("POST", "/slack/install-url", {
      body: {},
      token: withAgentKey("cursor"),
    });
    expect(r.status).toBe(403);
  });

  it("returns a slack.com authorize URL with the state echoed back", async () => {
    const r = await api<InstallUrlResponse>("POST", "/slack/install-url", { body: {} });
    expect(r.status).toBe(200);
    expect(r.json.url).toMatch(/^https:\/\/slack\.com\/oauth\/v2\/authorize\?/);
    expect(r.json.url).toContain(`state=${encodeURIComponent(r.json.state)}`);
    expect(r.json.url).toContain("client_id=");
    expect(r.json.url).toContain("scope=");
    expect(r.json.redirect_uri).toBe(
      `http://127.0.0.1:${getTestServer().port}/slack/oauth/callback`,
    );

    // Roundtrip the state to confirm it's signed by THIS process.
    const verified = verifyOauthState(r.json.state);
    expect(verified).not.toBeNull();
  });
});

describe("GET /slack/status", () => {
  it("403 for non-admin (agent key)", async () => {
    const r = await api<{ error: string }>("GET", "/slack/status", {
      token: withAgentKey("cursor"),
    });
    expect(r.status).toBe(403);
  });

  it("returns null workspace when nothing is installed", async () => {
    // Make sure no leftover workspace from another test in this run.
    const { dbPath } = getTestServer();
    const db = new Database(dbPath);
    db.prepare(`DELETE FROM slack_workspaces`).run();
    db.close();

    const r = await api<StatusResponse>("GET", "/slack/status");
    expect(r.status).toBe(200);
    expect(r.json.configured).toBe(true);
    expect(r.json.workspace).toBeNull();
  });

  it("returns the active workspace after a direct upsert", async () => {
    const { dbPath } = getTestServer();
    const db = new Database(dbPath);

    // Resolve the test owner user id (the one the default API key authenticates as).
    const ownerRow = db
      .prepare(`SELECT id FROM users WHERE email = ?`)
      .get(getTestServer().ownerEmail) as { id: string } | undefined;
    expect(ownerRow).toBeDefined();

    db.prepare(`DELETE FROM slack_workspaces`).run();
    // Build the fake bot token at runtime so the secret scanner doesn't match
    // the literal `xoxb-...` pattern in source. Real Slack tokens never end
    // up in repo-tracked test fixtures.
    const fakeBotToken = ["xoxb", "test", "token", "1234567890"].join("-");
    upsertSlackWorkspace(db, {
      slackTeamId: "T9999TEST",
      slackTeamName: "Test Workspace",
      reflectTeamId: null,
      reflectUserId: ownerRow!.id,
      botUserId: "B0000BOT",
      botToken: fakeBotToken,
      installedByUserId: ownerRow!.id,
    });
    db.close();

    const r = await api<StatusResponse>("GET", "/slack/status");
    expect(r.status).toBe(200);
    expect(r.json.workspace).not.toBeNull();
    expect(r.json.workspace?.slack_team_id).toBe("T9999TEST");
    expect(r.json.workspace?.slack_team_name).toBe("Test Workspace");
    expect(r.json.workspace?.bot_user_id).toBe("B0000BOT");
    // Bot token is never serialised to the public response.
    const text = JSON.stringify(r.json);
    expect(text).not.toContain(fakeBotToken);
    // Belt + braces: no real Slack bot-token prefix anywhere either. Built at
    // runtime to keep the secret-scanning regex from matching this literal.
    expect(text).not.toContain(`xoxb${"-"}`);
  });
});

describe("GET /slack/oauth/callback (error paths)", () => {
  // We can't fully test the success path without mocking slack.com, but the
  // error redirects are pure logic and can be verified.
  async function fetchRedirect(path: string): Promise<{ status: number; location: string }> {
    const server = getTestServer();
    const r = await fetch(`${server.baseUrl}${path}`, { redirect: "manual" });
    return { status: r.status, location: r.headers.get("location") ?? "" };
  }

  it("redirects with error= when code is missing", async () => {
    const r = await fetchRedirect("/slack/oauth/callback?state=abc");
    expect([302, 303]).toContain(r.status);
    expect(r.location).toMatch(/error=/);
    expect(r.location).toMatch(/missing.*code/i);
  });

  it("redirects with error= when state is invalid", async () => {
    const r = await fetchRedirect("/slack/oauth/callback?code=fake&state=bogus");
    expect([302, 303]).toContain(r.status);
    expect(r.location).toMatch(/error=/i);
    expect(r.location).toMatch(/invalid.*expired/i);
  });

  it("redirects with error= when Slack returned an error", async () => {
    const r = await fetchRedirect("/slack/oauth/callback?error=access_denied");
    expect([302, 303]).toContain(r.status);
    expect(r.location).toMatch(/error=/i);
    expect(r.location).toMatch(/access_denied/);
  });
});

describe("DELETE /slack/uninstall", () => {
  it("403 for non-admin (agent key)", async () => {
    const r = await api<{ error: string }>("DELETE", "/slack/uninstall", {
      token: withAgentKey("cursor"),
    });
    expect(r.status).toBe(403);
  });

  it("404 when no active workspace", async () => {
    const { dbPath } = getTestServer();
    const db = new Database(dbPath);
    db.prepare(`DELETE FROM slack_workspaces`).run();
    db.close();

    const r = await api<{ error: string }>("DELETE", "/slack/uninstall");
    expect(r.status).toBe(404);
  });

  it("soft-deletes the workspace, records audit event, status returns null after", async () => {
    const { dbPath } = getTestServer();
    const db = new Database(dbPath);
    const ownerRow = db
      .prepare(`SELECT id FROM users WHERE email = ?`)
      .get(getTestServer().ownerEmail) as { id: string } | undefined;
    expect(ownerRow).toBeDefined();

    db.prepare(`DELETE FROM slack_workspaces`).run();
    // Built at runtime so the literal `xoxb-` prefix doesn't trip the
    // secret-scanning regex in CI.
    const fakeBotToken = ["xoxb", "uninstall", "test"].join("-");
    upsertSlackWorkspace(db, {
      slackTeamId: "T-uninstall-test",
      slackTeamName: "Uninstall Workspace",
      reflectTeamId: null,
      reflectUserId: ownerRow!.id,
      botUserId: "B-uninstall",
      botToken: fakeBotToken,
      installedByUserId: ownerRow!.id,
    });

    const beforeUninstallEvents = (db
      .prepare(
        `SELECT count(*) as n FROM audit_events WHERE event_type = 'slack.uninstalled'`,
      )
      .get() as { n: number }).n;

    db.close();

    const r = await api<{ uninstalled: boolean; slack_team_id: string }>(
      "DELETE",
      "/slack/uninstall",
    );
    expect(r.status).toBe(200);
    expect(r.json.uninstalled).toBe(true);
    expect(r.json.slack_team_id).toBe("T-uninstall-test");

    const afterDb = new Database(dbPath, { readonly: true });
    const afterEvents = (afterDb
      .prepare(
        `SELECT count(*) as n FROM audit_events WHERE event_type = 'slack.uninstalled'`,
      )
      .get() as { n: number }).n;
    expect(afterEvents).toBe(beforeUninstallEvents + 1);

    const row = afterDb
      .prepare(
        `SELECT uninstalled_at FROM slack_workspaces WHERE slack_team_id = ?`,
      )
      .get("T-uninstall-test") as { uninstalled_at: string | null } | undefined;
    expect(row?.uninstalled_at).not.toBeNull();
    afterDb.close();

    // Status should now report null again.
    const status = await api<StatusResponse>("GET", "/slack/status");
    expect(status.json.workspace).toBeNull();
  });
});
