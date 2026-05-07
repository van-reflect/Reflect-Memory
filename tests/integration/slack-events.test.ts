// /slack/events endpoint coverage.
//
// Two halves:
//   1. HTTP-level integration tests against the live test server: signature
//      gate, URL verification handshake, ack-200 for valid envelopes.
//   2. In-process unit tests of processSlackEvent (no Slack network calls):
//      url_verification synth, event filtering (bot_message, non-im channel
//      messages, etc.).
//
// Note: end-to-end tests that exercise the async handler against a real DB
// would need a mocked Slack Web API in the SERVER process (cross-process,
// not the test process). We skip that for Phase 3a — manual smoke against
// the live `Reflect Dev` Slack app is faster + more honest. Phase 3b will
// pull the agent loop into a unit-testable shape.

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHmac, randomUUID } from "node:crypto";
import { getTestServer } from "../helpers";
import { _resetMasterKeyCacheForTests } from "../../src/llm-key-crypto";
import { processSlackEvent } from "../../src/slack-events-handler";

process.env.RM_LLM_KEY_ENCRYPTION_KEY = getTestServer().llmKeyMasterKey;
_resetMasterKeyCacheForTests();

const SIGNING_SECRET = "test-signing-secret"; // matches global-setup.ts

function signedHeaders(rawBody: string): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${ts}:${rawBody}`).digest("hex")}`;
  return {
    "x-slack-request-timestamp": ts,
    "x-slack-signature": sig,
  };
}

async function postEvent(envelope: unknown): Promise<{ status: number; body: unknown }> {
  const raw = JSON.stringify(envelope);
  const server = getTestServer();
  const res = await fetch(`${server.baseUrl}/slack/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...signedHeaders(raw),
    },
    body: raw,
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

describe("POST /slack/events — url_verification", () => {
  it("echoes the challenge", async () => {
    const challenge = `c-${randomUUID()}`;
    const { status, body } = await postEvent({
      type: "url_verification",
      challenge,
    });
    expect(status).toBe(200);
    expect(body).toEqual({ challenge });
  });
});

describe("POST /slack/events — signature gate", () => {
  it("401 when signature header is missing", async () => {
    const server = getTestServer();
    const res = await fetch(`${server.baseUrl}/slack/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "url_verification", challenge: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("401 when signature is wrong", async () => {
    const server = getTestServer();
    const raw = JSON.stringify({ type: "url_verification", challenge: "x" });
    const res = await fetch(`${server.baseUrl}/slack/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": "v0=deadbeef",
      },
      body: raw,
    });
    expect(res.status).toBe(401);
  });

  it("401 when timestamp is stale (>5min)", async () => {
    const server = getTestServer();
    const raw = JSON.stringify({ type: "url_verification", challenge: "x" });
    const stale = String(Math.floor(Date.now() / 1000) - 600);
    const sig = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${stale}:${raw}`).digest("hex")}`;
    const res = await fetch(`${server.baseUrl}/slack/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-slack-request-timestamp": stale,
        "x-slack-signature": sig,
      },
      body: raw,
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /slack/events — event_callback ack", () => {
  it("returns 200 {ok:true} for a well-formed event_callback (handler runs async)", async () => {
    const { status, body } = await postEvent({
      type: "event_callback",
      org_id: "T-nonexistent",
      api_app_id: "A-test",
      event_id: `Ev${randomUUID()}`,
      event: {
        type: "app_mention",
        user: "U-x",
        text: "<@U-bot> hi",
        channel: "C-x",
        ts: "111.222",
      },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    // The async handler will fail to find the workspace and bail — that's
    // fine for this test, we're only asserting the synchronous ack contract.
  });
});

// ---------------------------------------------------------------------------
// Pure unit tests of the synchronous event filter
// ---------------------------------------------------------------------------

describe("processSlackEvent (unit) — synchronous decisions", () => {
  // We don't hit the DB for these; pass a sentinel that would crash if used.
  const dummyDb = null as unknown as Database.Database;

  it("returns url_verification with the challenge", () => {
    const r = processSlackEvent(dummyDb, { type: "url_verification", challenge: "abc" });
    expect(r).toEqual({ kind: "url_verification", challenge: "abc" });
  });

  it("ignores top-level types we don't handle", () => {
    const r = processSlackEvent(dummyDb, { type: "block_actions" });
    expect(r.kind).toBe("ignored");
  });

  it("ignores bot_message subtype without DB lookup", () => {
    const r = processSlackEvent(dummyDb, {
      type: "event_callback",
      org_id: "T-x",
      event: {
        type: "message",
        subtype: "bot_message",
        bot_id: "B999",
        user: "USLACKBOT",
        text: "noise",
        channel: "C-x",
        channel_type: "im",
      },
    });
    expect(r.kind).toBe("ignored");
  });

  it("ignores message_changed and message_deleted subtypes", () => {
    for (const subtype of ["message_changed", "message_deleted"]) {
      const r = processSlackEvent(dummyDb, {
        type: "event_callback",
        org_id: "T-x",
        event: {
          type: "message",
          subtype,
          user: "U-x",
          text: "edited",
          channel: "C-x",
          channel_type: "im",
        },
      });
      expect(r.kind).toBe("ignored");
    }
  });

  it("ignores public-channel message without app_mention", () => {
    const r = processSlackEvent(dummyDb, {
      type: "event_callback",
      org_id: "T-x",
      event: {
        type: "message",
        channel_type: "channel",
        user: "U-x",
        text: "just chatting",
        channel: "C-x",
        ts: "111.222",
      },
    });
    expect(r.kind).toBe("ignored");
  });

  it("ignores incomplete event payloads (missing user/channel/text)", () => {
    const r = processSlackEvent(dummyDb, {
      type: "event_callback",
      org_id: "T-x",
      event: {
        type: "app_mention",
        channel: "C-x",
        text: "hi",
      },
    });
    expect(r.kind).toBe("ignored");
  });

  it("ignores self-app messages (api_app_id matches event.app_id)", () => {
    const r = processSlackEvent(dummyDb, {
      type: "event_callback",
      org_id: "T-x",
      api_app_id: "A-self",
      event: {
        type: "app_mention",
        app_id: "A-self",
        user: "U-x",
        text: "echo",
        channel: "C-x",
        ts: "111.222",
      },
    });
    expect(r.kind).toBe("ignored");
  });
});
