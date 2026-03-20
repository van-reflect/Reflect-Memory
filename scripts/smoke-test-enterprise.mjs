#!/usr/bin/env node
const baseUrl = process.env.RM_SMOKE_BASE_URL || "http://127.0.0.1:3000";
const apiKey = process.env.RM_SMOKE_API_KEY;

if (!apiKey) {
  console.error("Missing RM_SMOKE_API_KEY");
  process.exit(1);
}

async function call(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

const health = await fetch(`${baseUrl}/health`).then((r) => r.json());
if (health.status !== "ok") {
  console.error("Health check failed", health);
  process.exit(1);
}

const write = await call("/memories", {
  method: "POST",
  body: JSON.stringify({
    title: `enterprise-smoke-${Date.now()}`,
    content: "Enterprise smoke test memory",
    tags: ["enterprise", "smoke"],
  }),
});

if (write.status !== 201) {
  console.error("Write failed:", write.status, write.body);
  process.exit(1);
}

const read = await call("/memories/list", {
  method: "POST",
  body: JSON.stringify({
    filter: { by: "all" },
    limit: 3,
    offset: 0,
  }),
});

if (read.status !== 200) {
  console.error("Read failed:", read.status, read.body);
  process.exit(1);
}

const memoryData = JSON.parse(write.body);
const memoryOrigin = memoryData.origin || "cursor";

const originBrowse = await call("/memories/list", {
  method: "POST",
  body: JSON.stringify({
    filter: { by: "origin", origin: memoryOrigin },
    limit: 3,
    offset: 0,
  }),
});

if (originBrowse.status !== 200) {
  console.error("Origin filter failed:", originBrowse.status, originBrowse.body);
  process.exit(1);
}

const originResults = JSON.parse(originBrowse.body);
if (!originResults.memories || originResults.memories.length === 0) {
  console.error("Origin filter returned no results for origin:", memoryOrigin);
  process.exit(1);
}

console.log("Enterprise smoke test passed (including origin filter).");
