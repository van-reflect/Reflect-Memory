// Provision dedicated harness users on the dev VM. Idempotent.
//
// What this script does:
//   1. Generates two API keys locally (rm_live_<48-hex>, sha256-hashed for
//      DB storage). Keys never leave the local machine; only the hashes are
//      pushed to the VM.
//   2. SSHes to the dev VM and runs a single SQLite transaction:
//      - Creates `harness-team` (or reuses if it exists).
//      - Creates `harness-tamer@test.local` and `harness-van@test.local`
//        users on that team.
//      - Inserts api_keys rows with the hashes.
//   3. Writes tests/harness/.harness-config.json with both API keys, both
//      user IDs, the team ID, the dev MCP URL, and a fresh run_id.
//
// Re-run safely: existing users/team are reused. New API keys are minted
// on every run (old ones revoked) so credentials stay fresh and we don't
// leak long-lived test creds. Each run still gets its own run_id which
// scopes seeded fixtures (memories tagged `harness_<run_id>`) for clean
// teardown.
//
// Usage: npx tsx tests/harness/setup.ts
//
// Requires: SSH access to the dev VM as root, sqlite3 installed on VM.

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const DEV_HOST = process.env.HARNESS_DEV_HOST ?? "root@144.202.1.205";
const DEV_DB = process.env.HARNESS_DEV_DB ?? "/var/lib/reflect/dev/data/reflect-memory.db";
const MCP_URL = process.env.HARNESS_MCP_URL ?? "https://api-dev.reflectmemory.com/mcp";
const CONFIG_PATH = "tests/harness/.harness-config.json";

interface HarnessUser {
  id: string;
  email: string;
  org_role: "owner" | "member";
  api_key: string; // raw rm_live_... — only persisted locally
  api_key_hash: string;
  api_key_prefix: string;
  api_key_id: string;
}

interface HarnessConfig {
  run_id: string;
  org_id: string;
  team_name: string;
  mcp_url: string;
  generated_at: string;
  users: {
    tamer: Omit<HarnessUser, "api_key_hash">; // hash kept off local config
    van: Omit<HarnessUser, "api_key_hash">;
  };
}

function generateKey(userId: string, label: string): HarnessUser {
  const randomPart = randomBytes(24).toString("hex");
  const fullKey = `rm_live_${randomPart}`;
  const keyHash = createHash("sha256").update(fullKey).digest("hex");
  const keyPrefix = `rm_live_${randomPart.slice(0, 8)}`;
  return {
    id: userId,
    email: "<placeholder>",
    org_role: "owner",
    api_key: fullKey,
    api_key_hash: keyHash,
    api_key_prefix: keyPrefix,
    api_key_id: randomUUID(),
  };
}

function sshExec(remoteCmd: string): string {
  return execSync(`ssh ${DEV_HOST} ${JSON.stringify(remoteCmd)}`, {
    encoding: "utf-8",
    maxBuffer: 4 * 1024 * 1024,
  });
}

function fetchExistingTeamId(name: string): string | null {
  const out = sshExec(
    `sqlite3 ${DEV_DB} "SELECT id FROM teams WHERE name = '${name}' LIMIT 1;"`,
  ).trim();
  return out || null;
}

function fetchExistingUserId(email: string): string | null {
  const out = sshExec(
    `sqlite3 ${DEV_DB} "SELECT id FROM users WHERE email = '${email}' LIMIT 1;"`,
  ).trim();
  return out || null;
}

function execSql(sql: string): void {
  // Pipe SQL via heredoc to avoid quoting hell. Fail loudly on any error.
  execSync(`ssh ${DEV_HOST} "sqlite3 ${DEV_DB}"`, {
    input: sql,
    encoding: "utf-8",
    stdio: ["pipe", "inherit", "inherit"],
  });
}

function main(): void {
  const runId = randomUUID();
  const now = new Date().toISOString();

  // 1. Resolve or create team.
  const orgName = "harness-team";
  let orgId = fetchExistingTeamId(orgName);
  let teamCreatedNow = false;
  if (!orgId) {
    orgId = randomUUID();
    teamCreatedNow = true;
    console.log(`[setup] creating team ${orgName} (${orgId})`);
  } else {
    console.log(`[setup] reusing team ${orgName} (${orgId})`);
  }

  // 2. Resolve or create users. We need the team id known before we can
  // insert user rows pointing at it. The owner_id FK on teams also needs
  // a real user, so we insert the owner user first WITHOUT org_id, then
  // create the team referencing that user, then update the user's org_id.
  const tamerEmail = "harness-tamer@test.local";
  const vanEmail = "harness-van@test.local";
  let tamerId = fetchExistingUserId(tamerEmail);
  let vanId = fetchExistingUserId(vanEmail);
  const createdTamer = !tamerId;
  const createdVan = !vanId;
  if (!tamerId) tamerId = randomUUID();
  if (!vanId) vanId = randomUUID();
  console.log(
    `[setup] tamer=${tamerId}${createdTamer ? " (new)" : ""} van=${vanId}${createdVan ? " (new)" : ""}`,
  );

  // 3. Generate fresh API keys for both users (revokes any old harness
  // keys to keep cred footprint small).
  const tamerUser = { ...generateKey(tamerId, "harness-tamer"), email: tamerEmail, org_role: "owner" as const };
  const vanUser = { ...generateKey(vanId, "harness-van"), email: vanEmail, org_role: "member" as const };

  // 4. Build the SQL transaction. Order matters: users → team → users
  // (back-fill org_id) → revoke old keys → insert new keys.
  const sql = [
    "BEGIN TRANSACTION;",
    // Users (idempotent INSERT OR IGNORE; back-fill org_id later).
    createdTamer
      ? `INSERT INTO users (id, email, created_at, updated_at) VALUES ('${tamerId}', '${tamerEmail}', '${now}', '${now}');`
      : "",
    createdVan
      ? `INSERT INTO users (id, email, created_at, updated_at) VALUES ('${vanId}', '${vanEmail}', '${now}', '${now}');`
      : "",
    // Team.
    teamCreatedNow
      ? `INSERT INTO orgs (id, name, owner_id, plan, created_at, updated_at) VALUES ('${orgId}', '${orgName}', '${tamerId}', 'team', '${now}', '${now}');`
      : "",
    // Users → team membership.
    `UPDATE users SET org_id = '${orgId}', org_role = 'owner' WHERE id = '${tamerId}';`,
    `UPDATE users SET org_id = '${orgId}', org_role = 'member' WHERE id = '${vanId}';`,
    // Revoke any old harness API keys (label-scoped to ours).
    `UPDATE api_keys SET revoked_at = '${now}' WHERE user_id IN ('${tamerId}', '${vanId}') AND revoked_at IS NULL AND label LIKE 'harness-%';`,
    // Insert new keys.
    `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, label, created_at) VALUES ('${tamerUser.api_key_id}', '${tamerId}', '${tamerUser.api_key_hash}', '${tamerUser.api_key_prefix}', 'harness-tamer', '${now}');`,
    `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, label, created_at) VALUES ('${vanUser.api_key_id}', '${vanId}', '${vanUser.api_key_hash}', '${vanUser.api_key_prefix}', 'harness-van', '${now}');`,
    "COMMIT;",
  ]
    .filter(Boolean)
    .join("\n");

  console.log(`[setup] applying transaction (${sql.split("\n").length} stmts)`);
  execSql(sql);

  // 5. Persist config locally (raw keys included for the driver). Hashes
  // intentionally NOT included — we don't need them client-side.
  const config: HarnessConfig = {
    run_id: runId,
    org_id: orgId,
    team_name: orgName,
    mcp_url: MCP_URL,
    generated_at: now,
    users: {
      tamer: {
        id: tamerUser.id,
        email: tamerUser.email,
        org_role: tamerUser.org_role,
        api_key: tamerUser.api_key,
        api_key_prefix: tamerUser.api_key_prefix,
        api_key_id: tamerUser.api_key_id,
      },
      van: {
        id: vanUser.id,
        email: vanUser.email,
        org_role: vanUser.org_role,
        api_key: vanUser.api_key,
        api_key_prefix: vanUser.api_key_prefix,
        api_key_id: vanUser.api_key_id,
      },
    },
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  execSync(`chmod 600 ${CONFIG_PATH}`);

  console.log(`[setup] wrote ${CONFIG_PATH}`);
  console.log(`[setup] run_id=${runId}`);
  console.log(`[setup] org_id=${orgId}`);
  console.log(`[setup] tamer api key prefix=${tamerUser.api_key_prefix}`);
  console.log(`[setup] van   api key prefix=${vanUser.api_key_prefix}`);
}

main();
