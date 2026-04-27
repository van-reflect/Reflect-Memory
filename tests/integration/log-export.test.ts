// /admin/log-export endpoint coverage:
//   - Disabled by default (404 with helpful message)
//   - Enabled via env var, returns the bundle shape we expect
//   - Excludes memories content + credentials
//   - Admin-only (non-owner gets 403)
//   - Validates required from/to params
//   - Updates /whoami to surface the toggle state

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { api, getTestServer } from "../helpers";

interface WhoamiResponse {
  role: string;
  vendor: string | null;
  deployment_mode: string;
  log_sharing_enabled: boolean;
}

interface LogExportBundle {
  metadata: {
    generated_at: string;
    deployment_mode: string;
    server_version: string;
    tenant_id: string | null;
    date_range: { from: string; to: string };
    row_counts: Record<string, number>;
    excluded_tables: string[];
    notes: string[];
  };
  usage_events: unknown[];
  monthly_usage: unknown[];
  audit_events: unknown[];
  users: unknown[];
  teams: unknown[];
}

// global-setup.ts pins RM_LOG_SHARING_ENABLED=true on the test server, so
// integration tests below run against the enabled state. The disabled
// path is covered by a source-level assertion (last test in this file).

describe("/whoami exposes deployment + log-sharing flag", () => {
  it("includes deployment_mode and log_sharing_enabled fields", async () => {
    const r = await api<WhoamiResponse>("GET", "/whoami");
    expect(r.status).toBe(200);
    expect(typeof r.json.deployment_mode).toBe("string");
    expect(typeof r.json.log_sharing_enabled).toBe("boolean");
    expect(r.json.log_sharing_enabled).toBe(true); // global-setup pinned
  });
});

describe("GET /admin/log-export (enabled in test env)", () => {
  it("returns 400 when from/to are missing", async () => {
    const r = await api<{ error: string }>("GET", "/admin/log-export");
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/from and to/i);
  });

  it("returns the bundle shape when dates are provided", async () => {
    const r = await api<LogExportBundle>(
      "GET",
      "/admin/log-export?from=2026-01-01T00:00:00Z&to=2026-12-31T23:59:59Z",
    );
    expect(r.status).toBe(200);

    // Metadata header
    expect(typeof r.json.metadata.generated_at).toBe("string");
    expect(typeof r.json.metadata.deployment_mode).toBe("string");
    expect(typeof r.json.metadata.server_version).toBe("string");
    expect(r.json.metadata.date_range.from).toBe("2026-01-01T00:00:00Z");
    expect(r.json.metadata.date_range.to).toBe("2026-12-31T23:59:59Z");

    // Excluded tables list — privacy guarantee — must list memories +
    // credentials.
    expect(r.json.metadata.excluded_tables).toEqual(
      expect.arrayContaining([
        "memories",
        "memory_versions",
        "api_keys",
        "oauth_clients",
        "oauth_tokens",
      ]),
    );

    // Notes array calls out review-before-share
    expect(r.json.metadata.notes.join("\n")).toMatch(/review/i);

    // Tables present (may be empty arrays in a fresh test DB)
    expect(Array.isArray(r.json.usage_events)).toBe(true);
    expect(Array.isArray(r.json.monthly_usage)).toBe(true);
    expect(Array.isArray(r.json.audit_events)).toBe(true);
    expect(Array.isArray(r.json.users)).toBe(true);
    expect(Array.isArray(r.json.teams)).toBe(true);
  });

  it("does NOT include memories table or any 'content' field", async () => {
    const r = await api<Record<string, unknown> & LogExportBundle>(
      "GET",
      "/admin/log-export?from=2026-01-01T00:00:00Z&to=2026-12-31T23:59:59Z",
    );
    expect(r.status).toBe(200);

    expect(r.json).not.toHaveProperty("memories");
    expect(r.json).not.toHaveProperty("memory_versions");
    expect(r.json).not.toHaveProperty("api_keys");

    // Defence in depth: the serialized bundle should not contain any
    // 'content' string field anywhere (memories.content is the only
    // place this would come from in the schema).
    const text = JSON.stringify(r.json);
    expect(text).not.toMatch(/"content":/);
  });

  it("sets a content-disposition attachment header for download", async () => {
    const r = await api<LogExportBundle>(
      "GET",
      "/admin/log-export?from=2026-01-01T00:00:00Z&to=2026-12-31T23:59:59Z",
    );
    expect(r.status).toBe(200);
    const dispo = r.headers.get("content-disposition") ?? "";
    expect(dispo).toMatch(/attachment/);
    expect(dispo).toMatch(/reflect-memory-logs-/);
    expect(dispo).toMatch(/\.json/);
  });

  it("non-admin keys get 403 even when feature is enabled", async () => {
    const { agentKeys } = getTestServer();
    const r = await api<{ error: string }>(
      "GET",
      "/admin/log-export?from=2026-01-01T00:00:00Z&to=2026-12-31T23:59:59Z",
      { token: agentKeys.cursor },
    );
    expect(r.status).toBe(403);
  });
});

describe("source-level safety: env gate is wired", () => {
  // Belt-and-braces — assert the route source contains the gating check
  // so a future refactor can't silently delete it. Cheaper than spinning
  // a second test server with the env disabled.
  it("server.ts contains the RM_LOG_SHARING_ENABLED gate on the export route", () => {
    const src = readFileSync("src/server.ts", "utf-8");
    const route = src.split('"/admin/log-export"')[1] ?? "";
    expect(route).toContain("RM_LOG_SHARING_ENABLED");
    expect(route).toMatch(/code\(404\)/);
  });
});
