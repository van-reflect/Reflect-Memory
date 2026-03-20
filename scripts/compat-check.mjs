#!/usr/bin/env node
const baseUrl = process.env.RM_COMPAT_BASE_URL || "http://127.0.0.1:3000";
const apiKey = process.env.RM_COMPAT_API_KEY || "";

async function mustGet(path) {
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) throw new Error(`${path} failed with ${res.status}`);
  return res;
}

async function mustAuthed(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${path} failed with ${res.status}: ${body}`);
  }
  return res;
}

const results = [];

try {
  const health = await mustGet("/health");
  const healthJson = await health.json();
  results.push({ check: "health", ok: healthJson.status === "ok", detail: healthJson });

  await mustGet("/openapi.json");
  results.push({ check: "openapi", ok: true });

  if (apiKey) {
    await mustAuthed("/whoami");
    results.push({ check: "whoami", ok: true });

    await mustAuthed("/memories/list", {
      method: "POST",
      body: JSON.stringify({ filter: { by: "all" }, limit: 1, offset: 0 }),
    });
    results.push({ check: "memories_list", ok: true });

    const originRes = await mustAuthed("/memories/list", {
      method: "POST",
      body: JSON.stringify({ filter: { by: "origin", origin: "cursor" }, limit: 1, offset: 0 }),
    });
    results.push({ check: "origin_filter", ok: true });
  } else {
    results.push({ check: "auth_checks", ok: false, detail: "Set RM_COMPAT_API_KEY to run auth checks" });
  }

  console.log("Compatibility checks complete:");
  for (const result of results) {
    console.log(` - ${result.check}: ${result.ok ? "ok" : "warn"}`);
  }
} catch (error) {
  console.error("Compatibility check failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
