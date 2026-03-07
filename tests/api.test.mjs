#!/usr/bin/env node

// Reflect Memory — API Integration Tests
// Zero dependencies. Uses native fetch + node:assert.
// Run: REFLECT_TEST_API_KEY=your-key node tests/api.test.mjs

import { strict as assert } from "node:assert";

const BASE_URL = (
  process.env.REFLECT_TEST_BASE_URL || "https://api.reflectmemory.com"
).replace(/\/$/, "");
const API_KEY = process.env.REFLECT_TEST_API_KEY;

if (!API_KEY) {
  console.error("Fatal: REFLECT_TEST_API_KEY is required");
  process.exit(1);
}

const TIMEOUT_MS = 15_000;
const RUN_TAG = `ci-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

let passed = 0;
let failed = 0;
const failures = [];
const createdIds = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetchWithTimeout(`${BASE_URL}${path}`, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function apiRaw(method, path, customHeaders) {
  const res = await fetchWithTimeout(`${BASE_URL}${path}`, {
    method,
    headers: customHeaders || {},
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
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

function writeBody(overrides = {}) {
  return {
    title: `CI test ${RUN_TAG}`,
    content: `Integration test memory. Run: ${RUN_TAG}`,
    tags: [RUN_TAG],
    allowed_vendors: ["*"],
    ...overrides,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

console.log(`\nReflect Memory API Integration Tests`);
console.log(`Target:  ${BASE_URL}`);
console.log(`Run tag: ${RUN_TAG}\n`);

// --- Health ---

console.log("Health");

await test("GET /health — 200 with status ok", async () => {
  const { status, json } = await api("GET", "/health");
  assert.equal(status, 200);
  assert.equal(json.status, "ok");
});

// --- Auth ---

console.log("\nAuthentication");

await test("Missing Authorization header — 401", async () => {
  const { status } = await apiRaw("GET", "/whoami");
  assert.equal(status, 401);
});

await test("Invalid API key — 401", async () => {
  const { status } = await apiRaw("GET", "/whoami", {
    Authorization: "Bearer rm_invalid_000000000000000000000000",
  });
  assert.equal(status, 401);
});

await test("Malformed Authorization header (no Bearer prefix) — 401", async () => {
  const { status } = await apiRaw("GET", "/whoami", {
    Authorization: API_KEY,
  });
  assert.equal(status, 401);
});

await test("GET /whoami — returns role and vendor", async () => {
  const { status, json } = await api("GET", "/whoami");
  assert.equal(status, 200);
  assert.ok("role" in json, "missing role");
  assert.ok("vendor" in json, "missing vendor");
});

// --- Write ---

console.log("\nWrite Memories");

for (const memoryType of ["semantic", "episodic", "procedural"]) {
  await test(`POST /agent/memories — memory_type=${memoryType}`, async () => {
    const { status, json } = await api(
      "POST",
      "/agent/memories",
      writeBody({ memory_type: memoryType, title: `CI ${memoryType} ${RUN_TAG}` }),
    );
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(json)}`);
    assert.ok(json.id, "missing id in response");
    assert.equal(json.memory_type, memoryType);
    createdIds.push(json.id);
  });
}

await test("POST /agent/memories — omitted memory_type defaults to semantic", async () => {
  const body = writeBody({ title: `CI default-type ${RUN_TAG}` });
  delete body.memory_type;
  const { status, json } = await api("POST", "/agent/memories", body);
  assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(json)}`);
  assert.equal(json.memory_type, "semantic");
  createdIds.push(json.id);
});

// --- Validation ---

console.log("\nInput Validation");

await test("Empty title — 400", async () => {
  const { status } = await api("POST", "/agent/memories", writeBody({ title: "" }));
  assert.equal(status, 400, `expected 400, got ${status}`);
});

await test("Invalid memory_type value — 400", async () => {
  const { status } = await api(
    "POST",
    "/agent/memories",
    writeBody({ memory_type: "not_a_type" }),
  );
  assert.equal(status, 400, `expected 400, got ${status}`);
});

await test("Missing content field — 400", async () => {
  const body = writeBody();
  delete body.content;
  const { status } = await api("POST", "/agent/memories", body);
  assert.equal(status, 400, `expected 400, got ${status}`);
});

await test("Missing title field — 400", async () => {
  const body = writeBody();
  delete body.title;
  const { status } = await api("POST", "/agent/memories", body);
  assert.equal(status, 400, `expected 400, got ${status}`);
});

// --- Read ---

console.log("\nRead Memories");

await test("GET /agent/memories/latest — returns memory with memory_type", async () => {
  const { status, json } = await api("GET", `/agent/memories/latest?tag=${RUN_TAG}`);
  assert.equal(status, 200);
  assert.ok(json.id, "missing id");
  assert.ok(json.memory_type, "missing memory_type");
});

await test("GET /agent/memories/:id — returns correct memory", async () => {
  const id = createdIds[1]; // episodic
  assert.ok(id, "no episodic memory was created");
  const { status, json } = await api("GET", `/agent/memories/${id}`);
  assert.equal(status, 200);
  assert.equal(json.id, id);
  assert.equal(json.memory_type, "episodic");
  assert.ok(json.content.includes(RUN_TAG));
});

await test("GET /agent/memories/:id — nonexistent ID returns 404", async () => {
  const { status } = await api(
    "GET",
    "/agent/memories/00000000-0000-0000-0000-000000000000",
  );
  assert.equal(status, 404);
});

// --- Browse ---

console.log("\nBrowse & Filter");

await test("POST /agent/memories/browse — paginated response with memory_type", async () => {
  const { status, json } = await api("POST", "/agent/memories/browse", {
    filter: { by: "tags", tags: [RUN_TAG] },
    limit: 10,
    offset: 0,
  });
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.memories), "memories is not an array");
  assert.ok(json.memories.length >= 3, `expected >=3, got ${json.memories.length}`);
  assert.ok("total" in json, "missing total");
  assert.ok("limit" in json, "missing limit");
  assert.ok("offset" in json, "missing offset");
  assert.ok("has_more" in json, "missing has_more");
  for (const m of json.memories) {
    assert.ok(m.memory_type, `memory ${m.id} missing memory_type`);
  }
});

await test("POST /agent/memories/by-tag — filters by tag", async () => {
  const { status, json } = await api("POST", "/agent/memories/by-tag", {
    tags: [RUN_TAG],
    limit: 10,
  });
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.memories));
  assert.ok(json.memories.length >= 3, `expected >=3, got ${json.memories.length}`);
  for (const m of json.memories) {
    const tags = Array.isArray(m.tags) ? m.tags : JSON.parse(m.tags || "[]");
    assert.ok(tags.includes(RUN_TAG), `memory ${m.id} missing run tag`);
  }
});

// --- Response shape ---

console.log("\nResponse Shape");

await test("Error responses do not leak stack traces or file paths", async () => {
  const { json, text } = await apiRaw("GET", "/whoami");
  const body = text.toLowerCase();
  assert.ok(!body.includes("stack"), "response contains stack trace");
  assert.ok(!body.includes("/users/"), "response contains file path");
  assert.ok(!body.includes("node_modules"), "response contains node_modules path");
  assert.ok(!body.includes(".ts:"), "response contains TypeScript source reference");
});

await test("GET /health — response has Content-Type application/json", async () => {
  const { headers: h } = await api("GET", "/health");
  const ct = h.get("content-type") || "";
  assert.ok(ct.includes("application/json"), `unexpected content-type: ${ct}`);
});

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\n${"—".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failures.length > 0) {
  console.log("\nFailed:");
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`);
    console.log(`    ${f.message}`);
  }
}

console.log();
process.exit(failed > 0 ? 1 : 0);
