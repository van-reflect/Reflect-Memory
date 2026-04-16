// Phase 2.2 — API key CRUD integration tests.
// Covers POST /api/keys (create), GET /api/keys (list), DELETE /api/keys/:id (revoke).
// Free plan caps active keys at 2. Each test cleans up the keys it creates so the
// suite can run in any order.

import { describe, it, expect, afterEach } from "vitest";
import { api } from "../helpers";

interface ApiKeyRecord {
  id: string;
  user_id: string;
  key_prefix: string;
  label: string;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

interface CreateApiKeyResponse {
  key: string;
  id: string;
  key_prefix: string;
  label: string;
  created_at: string;
}

const createdInTest: string[] = [];

afterEach(async () => {
  // Best-effort cleanup so subsequent tests don't bump the per-plan key cap.
  while (createdInTest.length > 0) {
    const id = createdInTest.pop()!;
    await api("DELETE", `/api/keys/${id}`, {});
  }
});

async function createKey(label = "ci-test"): Promise<CreateApiKeyResponse> {
  const r = await api<CreateApiKeyResponse>("POST", "/api/keys", { body: { label } });
  if (r.status !== 200) {
    throw new Error(`createKey failed: ${r.status} ${r.text}`);
  }
  createdInTest.push(r.json.id);
  return r.json;
}

describe("POST /api/keys (create)", () => {
  it("creates a key with the requested label", async () => {
    const k = await createKey("my-test-key");
    expect(k.id).toBeTruthy();
    expect(k.key).toMatch(/^rm_live_[a-f0-9]{48}$/);
    expect(k.key_prefix).toMatch(/^rm_live_[a-f0-9]{8}$/);
    expect(k.key_prefix).toBe(k.key.slice(0, "rm_live_".length + 8));
    expect(k.label).toBe("my-test-key");
    expect(k.created_at).toBeTruthy();
  });

  it("creates a key with default label when none provided", async () => {
    const r = await api<CreateApiKeyResponse>("POST", "/api/keys", { body: {} });
    expect(r.status).toBe(200);
    createdInTest.push(r.json.id);
    expect(r.json.label).toBe("Default");
  });

  it("rejects empty label string -> 400", async () => {
    const r = await api("POST", "/api/keys", { body: { label: "" } });
    expect(r.status).toBe(400);
  });

  it("the created key authenticates against /whoami", async () => {
    const k = await createKey("whoami-probe");
    const who = await api<{ role: string; vendor: string | null }>("GET", "/whoami", {
      token: k.key,
    });
    expect(who.status).toBe(200);
    expect(who.role ?? who.json.role).toBe("user");
    expect(who.json.vendor).toBeNull();
  });
});

describe("GET /api/keys (list)", () => {
  it("includes the just-created key and never returns a key_hash field", async () => {
    const k = await createKey("listed");
    const r = await api<{ keys: ApiKeyRecord[] }>("GET", "/api/keys");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.keys)).toBe(true);

    const found = r.json.keys.find((row) => row.id === k.id);
    expect(found).toBeDefined();
    expect(found!.label).toBe("listed");
    expect(found!.key_prefix).toBe(k.key_prefix);
    expect(found!.revoked_at).toBeNull();

    for (const row of r.json.keys) {
      expect(row).not.toHaveProperty("key_hash");
      expect(row).not.toHaveProperty("key");
    }
  });
});

describe("DELETE /api/keys/:id (revoke)", () => {
  it("revokes the key and the key stops authenticating", async () => {
    const k = await createKey("to-be-revoked");

    const del = await api<{ revoked: boolean }>("DELETE", `/api/keys/${k.id}`);
    expect(del.status).toBe(200);
    expect(del.json.revoked).toBe(true);

    // Drop from cleanup tracker since we just revoked it.
    const idx = createdInTest.indexOf(k.id);
    if (idx >= 0) createdInTest.splice(idx, 1);

    const who = await api("GET", "/whoami", { token: k.key });
    expect(who.status).toBe(401);

    const list = await api<{ keys: ApiKeyRecord[] }>("GET", "/api/keys");
    const row = list.json.keys.find((r) => r.id === k.id);
    expect(row).toBeDefined();
    expect(row!.revoked_at).not.toBeNull();
  });

  it("revoking the same key twice -> second returns 404", async () => {
    const k = await createKey("twice");
    const first = await api("DELETE", `/api/keys/${k.id}`);
    expect(first.status).toBe(200);
    const idx = createdInTest.indexOf(k.id);
    if (idx >= 0) createdInTest.splice(idx, 1);

    const second = await api("DELETE", `/api/keys/${k.id}`);
    expect(second.status).toBe(404);
  });

  it("revoking a nonexistent id -> 404", async () => {
    const r = await api("DELETE", "/api/keys/00000000-0000-0000-0000-000000000000");
    expect(r.status).toBe(404);
  });
});

describe("plan limit enforcement (free = 2 active keys)", () => {
  // The seeded RM_API_KEY is env-only and is NOT stored in the api_keys table,
  // so countActiveApiKeys starts at 0. Free cap = 2 → first two creates succeed,
  // third returns 429.
  it("creating beyond maxApiKeys returns 429 with quota payload", async () => {
    const k1 = await createKey("fill-1");
    const k2 = await createKey("fill-2");
    expect(k1.id).toBeTruthy();
    expect(k2.id).toBeTruthy();

    const over = await api<{
      error: string;
      plan: string;
      active_keys: number;
      limit: number;
      upgrade_url: string;
    }>("POST", "/api/keys", { body: { label: "fill-3" } });
    expect(over.status).toBe(429);
    expect(over.json.error).toMatch(/limit/i);
    expect(over.json.plan).toBe("free");
    expect(over.json.limit).toBe(2);
    expect(over.json.active_keys).toBeGreaterThanOrEqual(2);
    expect(over.json.upgrade_url).toMatch(/^https?:\/\//);
  });

  it("revoking a key frees a slot — subsequent create succeeds", async () => {
    const k1 = await createKey("free-slot-1");
    const k2 = await createKey("free-slot-2");

    // At cap; releasing one slot via revoke.
    const del = await api("DELETE", `/api/keys/${k1.id}`);
    expect(del.status).toBe(200);
    const idx = createdInTest.indexOf(k1.id);
    if (idx >= 0) createdInTest.splice(idx, 1);

    const recovered = await api<CreateApiKeyResponse>("POST", "/api/keys", {
      body: { label: "after-revoke" },
    });
    expect(recovered.status).toBe(200);
    createdInTest.push(recovered.json.id);
    expect(k2.id).toBeTruthy();
  });
});
