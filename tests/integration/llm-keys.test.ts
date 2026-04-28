// /admin/llm-keys endpoint coverage:
//   - Encryption round-trip (set then re-list shows last4)
//   - Set requires admin (non-owner gets 403)
//   - Unsupported provider rejected
//   - Empty/missing body rejected
//   - Rotate (PUT same provider twice) replaces, last4 updated
//   - Delete removes; second delete is 404
//   - Audit events recorded for create/rotate/remove
//
// Plus a unit test of the pure encryption module to prove HKDF/scope
// mismatch correctly fails (defense against silent key reuse bugs).

import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { api, getTestServer, withAgentKey } from "../helpers";
import {
  _resetMasterKeyCacheForTests,
  decryptLlmKey,
  encryptLlmKey,
  extractLast4,
} from "../../src/llm-key-crypto";

interface KeyListResponse {
  scope: { team_id: string | null; user_id: string | null };
  supported_providers: string[];
  keys: Array<{
    provider: string;
    last4: string;
    created_at: string;
    updated_at: string;
    created_by_user_id: string | null;
  }>;
}

interface KeySetResponse {
  provider: string;
  last4: string;
  created_at: string;
  updated_at: string;
}

interface KeyDeleteResponse {
  deleted: boolean;
  provider: string;
  last4: string;
}

// ---------------------------------------------------------------------------
// HTTP integration tests against the live test server
// ---------------------------------------------------------------------------

async function deleteIfPresent(provider: string): Promise<void> {
  await api(`DELETE`, `/admin/llm-keys/${provider}`);
}

describe("GET /admin/llm-keys (admin)", () => {
  it("returns the supported providers + (initially) an empty list", async () => {
    await deleteIfPresent("anthropic");
    const r = await api<KeyListResponse>("GET", "/admin/llm-keys");
    expect(r.status).toBe(200);
    expect(r.json.supported_providers).toContain("anthropic");
    expect(Array.isArray(r.json.keys)).toBe(true);
    expect(r.json.keys.find((k) => k.provider === "anthropic")).toBeUndefined();
  });

  it("403 for non-admin (agent key)", async () => {
    const r = await api<{ error: string }>("GET", "/admin/llm-keys", {
      token: withAgentKey("cursor"),
    });
    expect(r.status).toBe(403);
  });
});

describe("PUT /admin/llm-keys (set + rotate)", () => {
  it("400 when body is missing provider/key", async () => {
    const r1 = await api<{ error: string }>("PUT", "/admin/llm-keys", { body: {} });
    expect(r1.status).toBe(400);

    const r2 = await api<{ error: string }>("PUT", "/admin/llm-keys", {
      body: { provider: "anthropic" },
    });
    expect(r2.status).toBe(400);

    const r3 = await api<{ error: string }>("PUT", "/admin/llm-keys", {
      body: { provider: "anthropic", key: "" },
    });
    expect(r3.status).toBe(400);
  });

  it("400 for unsupported provider", async () => {
    const r = await api<{ error: string }>("PUT", "/admin/llm-keys", {
      body: { provider: "openai", key: "sk-test-1234" },
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/Unsupported provider/i);
  });

  it("403 for non-admin (agent key)", async () => {
    const r = await api<{ error: string }>("PUT", "/admin/llm-keys", {
      body: { provider: "anthropic", key: "sk-ant-test-1234" },
      token: withAgentKey("cursor"),
    });
    expect(r.status).toBe(403);
  });

  it("creates a key on first set, last4 derived from input", async () => {
    await deleteIfPresent("anthropic");
    const fakeKey = "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-Z9zZ";
    const r = await api<KeySetResponse>("PUT", "/admin/llm-keys", {
      body: { provider: "anthropic", key: fakeKey },
    });
    expect(r.status).toBe(200);
    expect(r.json.provider).toBe("anthropic");
    expect(r.json.last4).toBe("Z9zZ");
    expect(typeof r.json.created_at).toBe("string");
    expect(typeof r.json.updated_at).toBe("string");

    const list = await api<KeyListResponse>("GET", "/admin/llm-keys");
    const stored = list.json.keys.find((k) => k.provider === "anthropic");
    expect(stored).toBeDefined();
    expect(stored?.last4).toBe("Z9zZ");
  });

  it("rotating a key replaces it, updated_at advances, last4 reflects new input", async () => {
    const firstKey = "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111";
    const secondKey = "sk-ant-api03-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-2222";

    await deleteIfPresent("anthropic");
    await api("PUT", "/admin/llm-keys", {
      body: { provider: "anthropic", key: firstKey },
    });
    const before = await api<KeyListResponse>("GET", "/admin/llm-keys");
    const beforeStored = before.json.keys.find((k) => k.provider === "anthropic");
    expect(beforeStored?.last4).toBe("1111");

    // Wait a tick so updated_at can move (ISO timestamps tick at 1ms).
    await new Promise((r) => setTimeout(r, 10));

    const r = await api<KeySetResponse>("PUT", "/admin/llm-keys", {
      body: { provider: "anthropic", key: secondKey },
    });
    expect(r.status).toBe(200);
    expect(r.json.last4).toBe("2222");

    const after = await api<KeyListResponse>("GET", "/admin/llm-keys");
    const afterStored = after.json.keys.find((k) => k.provider === "anthropic");
    expect(afterStored?.last4).toBe("2222");
    expect(afterStored?.created_at).toBe(beforeStored?.created_at);
    expect(afterStored?.updated_at).not.toBe(beforeStored?.updated_at);
  });
});

describe("DELETE /admin/llm-keys/:provider", () => {
  it("400 for unsupported provider", async () => {
    const r = await api<{ error: string }>("DELETE", "/admin/llm-keys/openai");
    expect(r.status).toBe(400);
  });

  it("403 for non-admin (agent key)", async () => {
    const r = await api<{ error: string }>("DELETE", "/admin/llm-keys/anthropic", {
      token: withAgentKey("cursor"),
    });
    expect(r.status).toBe(403);
  });

  it("removes the key and reports last4; second delete is 404", async () => {
    await api("PUT", "/admin/llm-keys", {
      body: { provider: "anthropic", key: "sk-ant-api03-deleteme-9999" },
    });

    const first = await api<KeyDeleteResponse>("DELETE", "/admin/llm-keys/anthropic");
    expect(first.status).toBe(200);
    expect(first.json.deleted).toBe(true);
    expect(first.json.last4).toBe("9999");

    const second = await api<{ error: string }>("DELETE", "/admin/llm-keys/anthropic");
    expect(second.status).toBe(404);
  });
});

describe("audit_events records llm_key.* events", () => {
  it("create + rotate + remove all show up in audit_events", async () => {
    await deleteIfPresent("anthropic");

    // Snapshot current event_type counts so we measure deltas, not totals
    // (the test server is shared across files).
    const { dbPath } = getTestServer();
    const db = new Database(dbPath, { readonly: true });
    afterAll(() => {
      try {
        db.close();
      } catch {
        /* best-effort cleanup */
      }
    });

    function countOf(eventType: string): number {
      const row = db
        .prepare(
          `SELECT count(*) as n FROM audit_events WHERE event_type = ?`,
        )
        .get(eventType) as { n: number };
      return row.n;
    }

    const beforeCreated = countOf("llm_key.created");
    const beforeRotated = countOf("llm_key.rotated");
    const beforeRemoved = countOf("llm_key.removed");

    await api("PUT", "/admin/llm-keys", {
      body: { provider: "anthropic", key: "sk-ant-api03-audit-aaaa" },
    });
    await api("PUT", "/admin/llm-keys", {
      body: { provider: "anthropic", key: "sk-ant-api03-audit-bbbb" },
    });
    await api("DELETE", "/admin/llm-keys/anthropic");

    expect(countOf("llm_key.created")).toBe(beforeCreated + 1);
    expect(countOf("llm_key.rotated")).toBe(beforeRotated + 1);
    expect(countOf("llm_key.removed")).toBe(beforeRemoved + 1);

    // Confirm no audit metadata leaks the key plaintext.
    const recent = db
      .prepare(
        `SELECT metadata FROM audit_events
         WHERE event_type LIKE 'llm_key.%' ORDER BY created_at DESC LIMIT 5`,
      )
      .all() as { metadata: string | null }[];
    for (const row of recent) {
      if (!row.metadata) continue;
      expect(row.metadata).not.toMatch(/sk-ant-api03-audit/);
      // Each row should still carry the last4 for forensic value.
      expect(row.metadata).toMatch(/last4/);
    }
  });
});

// ---------------------------------------------------------------------------
// Pure encryption module unit tests
// ---------------------------------------------------------------------------

describe("llm-key-crypto module (unit)", () => {
  // Pin a deterministic master key for these tests so we don't rely on whatever
  // is in process.env. Reset cache before/after.
  const fixedMasterKey = randomBytes(32).toString("hex");
  let priorEnv: string | undefined;

  function pinKey() {
    priorEnv = process.env.RM_LLM_KEY_ENCRYPTION_KEY;
    process.env.RM_LLM_KEY_ENCRYPTION_KEY = fixedMasterKey;
    _resetMasterKeyCacheForTests();
  }

  function restoreKey() {
    if (priorEnv === undefined) delete process.env.RM_LLM_KEY_ENCRYPTION_KEY;
    else process.env.RM_LLM_KEY_ENCRYPTION_KEY = priorEnv;
    _resetMasterKeyCacheForTests();
  }

  it("encrypt then decrypt returns the original plaintext", () => {
    pinKey();
    try {
      const scope = { teamId: "team-abc", userId: null };
      const enc = encryptLlmKey("sk-ant-api03-secret-key-zzzz", scope);
      expect(enc.last4).toBe("zzzz");
      expect(enc.nonce.length).toBe(12);
      expect(enc.ciphertext.length).toBeGreaterThan(16); // payload + 16-byte tag
      const dec = decryptLlmKey(enc, scope);
      expect(dec).toBe("sk-ant-api03-secret-key-zzzz");
    } finally {
      restoreKey();
    }
  });

  it("decrypt with the wrong scope throws (HKDF derives different sub-key)", () => {
    pinKey();
    try {
      const enc = encryptLlmKey("plaintext-1", { teamId: "team-A", userId: null });
      expect(() =>
        decryptLlmKey(enc, { teamId: "team-B", userId: null }),
      ).toThrow();
      expect(() => decryptLlmKey(enc, { teamId: null, userId: "user-X" })).toThrow();
    } finally {
      restoreKey();
    }
  });

  it("decrypt with the right scope but tampered ciphertext throws (GCM auth)", () => {
    pinKey();
    try {
      const scope = { teamId: "team-1", userId: null };
      const enc = encryptLlmKey("plaintext-2", scope);
      // Flip a bit in the ciphertext.
      const tampered = Buffer.from(enc.ciphertext);
      tampered[0] = tampered[0] ^ 0x01;
      expect(() =>
        decryptLlmKey({ ciphertext: tampered, nonce: enc.nonce }, scope),
      ).toThrow();
    } finally {
      restoreKey();
    }
  });

  it("rejects KeyScope with both teamId and userId", () => {
    pinKey();
    try {
      expect(() =>
        encryptLlmKey("foo", { teamId: "t", userId: "u" }),
      ).toThrow(/exactly one/i);
    } finally {
      restoreKey();
    }
  });

  it("rejects KeyScope with neither teamId nor userId", () => {
    pinKey();
    try {
      expect(() => encryptLlmKey("foo", {})).toThrow(/teamId|userId/i);
    } finally {
      restoreKey();
    }
  });

  it("rejects empty plaintext", () => {
    pinKey();
    try {
      expect(() =>
        encryptLlmKey("   ", { teamId: "t", userId: null }),
      ).toThrow(/empty/i);
    } finally {
      restoreKey();
    }
  });

  it("rejects malformed master key (not 64 hex chars)", () => {
    priorEnv = process.env.RM_LLM_KEY_ENCRYPTION_KEY;
    process.env.RM_LLM_KEY_ENCRYPTION_KEY = "deadbeef"; // too short
    _resetMasterKeyCacheForTests();
    try {
      expect(() =>
        encryptLlmKey("foo", { teamId: "t", userId: null }),
      ).toThrow(/64 hex/i);
    } finally {
      restoreKey();
    }
  });

  it("rejects missing master key", () => {
    priorEnv = process.env.RM_LLM_KEY_ENCRYPTION_KEY;
    delete process.env.RM_LLM_KEY_ENCRYPTION_KEY;
    _resetMasterKeyCacheForTests();
    try {
      expect(() =>
        encryptLlmKey("foo", { teamId: "t", userId: null }),
      ).toThrow(/RM_LLM_KEY_ENCRYPTION_KEY/);
    } finally {
      restoreKey();
    }
  });

  it("extractLast4 returns the last 4 chars of trimmed input, empty string when blank", () => {
    expect(extractLast4("sk-anything-AbCd")).toBe("AbCd");
    expect(extractLast4("  sk-spaces-EfGh  ")).toBe("EfGh");
    expect(extractLast4("")).toBe("");
    expect(extractLast4("   ")).toBe("");
    expect(extractLast4("xy")).toBe("xy"); // shorter than 4 returns full
  });
});
