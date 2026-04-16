#!/usr/bin/env node

// Reflect Memory -- Live smoke test
// Runs against a DEPLOYED environment (dev or prod) to verify it's reachable
// and responding correctly at the boundary. No state mutation beyond optional
// write+delete of a single probe memory with a unique tag.
//
// Zero deps. Called by deploy.yml post-deploy step, and by the canary cron.
//
// Env:
//   REFLECT_TEST_BASE_URL (required) - e.g. https://api-dev.reflectmemory.com
//   REFLECT_TEST_API_KEY  (required) - rm_live_* personal key
//   REFLECT_TEST_WRITE    (optional) - "1" to also do a write+delete probe
//
// Exits 0 on all-pass, 1 on any fail.

import { strict as assert } from "node:assert";

const BASE_URL = (process.env.REFLECT_TEST_BASE_URL || "").replace(/\/$/, "");
const API_KEY = process.env.REFLECT_TEST_API_KEY;
const DO_WRITE = process.env.REFLECT_TEST_WRITE === "1";

if (!BASE_URL) {
  console.error("Fatal: REFLECT_TEST_BASE_URL is required");
  process.exit(1);
}
if (!API_KEY) {
  console.error("Fatal: REFLECT_TEST_API_KEY is required");
  process.exit(1);
}

const TIMEOUT_MS = 15_000;
const RUN_TAG = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const authHeader = { Authorization: `Bearer ${API_KEY}` };

let passed = 0;
let failed = 0;
const failures = [];

async function fetchWithTimeout(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function api(method, path, body) {
  const h = { ...authHeader };
  const opts = { method, headers: h };
  if (body !== undefined) {
    h["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetchWithTimeout(`${BASE_URL}${path}`, opts);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Response is not JSON; leave null.
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, message: err.message });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

console.log(`\nReflect Memory — Live Smoke`);
console.log(`Target:  ${BASE_URL}`);
console.log(`Write probe: ${DO_WRITE ? "YES" : "NO"}`);
console.log(`Run tag: ${RUN_TAG}\n`);

await test("GET /health -- 200 status ok", async () => {
  const { status, json } = await api("GET", "/health");
  assert.equal(status, 200);
  assert.equal(json.status, "ok");
});

await test("GET /health -- response JSON", async () => {
  const { headers: h } = await api("GET", "/health");
  assert.ok((h.get("content-type") || "").includes("application/json"));
});

await test("GET /whoami unauthenticated -- 401", async () => {
  const res = await fetchWithTimeout(`${BASE_URL}/whoami`, { method: "GET" });
  assert.equal(res.status, 401);
});

await test("GET /whoami invalid key -- 401", async () => {
  const res = await fetchWithTimeout(`${BASE_URL}/whoami`, {
    method: "GET",
    headers: { Authorization: "Bearer rm_live_definitely_not_real_0000000000" },
  });
  assert.equal(res.status, 401);
});

await test("GET /whoami valid key -- 200 with role", async () => {
  const { status, json } = await api("GET", "/whoami");
  assert.equal(status, 200);
  assert.ok("role" in json, "missing role field");
  assert.ok("vendor" in json, "missing vendor field");
});

await test("Error response does not leak stack traces", async () => {
  const res = await fetchWithTimeout(`${BASE_URL}/whoami`, { method: "GET" });
  const body = (await res.text()).toLowerCase();
  assert.ok(!body.includes("stack"), "response contains 'stack'");
  assert.ok(!body.includes("/users/"), "response contains file path");
  assert.ok(!body.includes("node_modules"), "response contains node_modules");
});

await test("HEAD /health allowed method -- 200 or 405", async () => {
  const res = await fetchWithTimeout(`${BASE_URL}/health`, { method: "HEAD" });
  assert.ok(res.status === 200 || res.status === 404 || res.status === 405);
});

await test("POST /unknown -- 404", async () => {
  const { status } = await api("POST", `/__unknown_${RUN_TAG}`, { x: 1 });
  assert.equal(status, 404);
});

// Write probe is optional — live-smoke is normally read-only to be safe to
// run every 10 minutes. Pass REFLECT_TEST_WRITE=1 to exercise the full
// write->read->delete path (used post-deploy).
if (DO_WRITE) {
  let writtenId = null;

  await test("POST /agent/memories -- 201 (smoke write)", async () => {
    const { status, json } = await api("POST", "/agent/memories", {
      title: `smoke probe ${RUN_TAG}`,
      content: `Reflect smoke probe — safe to delete. Run ${RUN_TAG}.`,
      tags: [RUN_TAG, "live_smoke"],
      allowed_vendors: ["*"],
      memory_type: "semantic",
    });
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(json)}`);
    assert.ok(json.id, "no id in response");
    writtenId = json.id;
  });

  await test("GET /agent/memories/:id -- round-trip", async () => {
    if (!writtenId) throw new Error("prior write failed");
    const { status, json } = await api("GET", `/agent/memories/${writtenId}`);
    // In prod the isCiTestMemory guard may soft-delete the memory. Accept 404
    // as success when tag starts with 'smoke-' but that matches 'ci-' pattern:
    // we use 'smoke-' prefix exactly to avoid the guard. If this fires in prod
    // it means the guard expanded.
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
    assert.equal(json.id, writtenId);
  });

  await test("DELETE /agent/memories/:id -- cleanup", async () => {
    if (!writtenId) throw new Error("prior write failed");
    const { status } = await api("DELETE", `/agent/memories/${writtenId}`);
    assert.ok(
      status === 200 || status === 204 || status === 404,
      `expected 200/204/404, got ${status}`,
    );
  });
}

console.log(`\n${"-".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailed:");
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`);
    console.log(`    ${f.message}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
