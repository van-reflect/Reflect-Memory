// One-off: seed the harness fixture corpus into REAL dev accounts
// (ts@reflectmemory.com + vm@reflectmemory.com), and create the
// "Reflect" team with both as members.
//
// Unlike tests/harness/seed.ts (which wipes + re-seeds the dedicated
// harness-tamer / harness-van users on every run), this script is
// strictly ADDITIVE — it never deletes existing memories on either
// account. Existing memories on ts@ stay untouched. The fixtures are
// inserted alongside.
//
// Output: writes docs/dev-real-seed-manifest.json with the (ref → id)
// map for everything we created, so the seeded data can be cleanly
// removed later via:
//   sqlite3 ... "DELETE FROM memories WHERE id IN (<ids from manifest>);"
//
// Usage (one shot, not part of the harness loop):
//   npx tsx tests/harness/seed-real-dev-account.ts

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getAllFixtures } from "./fixtures/index.js";
import type { MemoryFixture, FixtureAuthor } from "./fixtures/types.js";

const DEV_HOST = process.env.HARNESS_DEV_HOST ?? "root@144.202.1.205";
const DEV_DB = process.env.HARNESS_DEV_DB ?? "/var/lib/reflect/dev/data/reflect-memory.db";
const TEAM_NAME = process.env.SEED_TEAM_NAME ?? "Reflect";
const MANIFEST_PATH = "../docs/dev-real-seed-manifest.json";

interface UserRow {
  id: string;
  email: string;
  team_id: string | null;
}

function ssh(remoteCmd: string): string {
  return execSync(`ssh ${DEV_HOST} ${JSON.stringify(remoteCmd)}`, {
    encoding: "utf-8",
    maxBuffer: 4 * 1024 * 1024,
  });
}

function execSql(sql: string): void {
  execSync(`ssh ${DEV_HOST} "sqlite3 ${DEV_DB}"`, {
    input: sql,
    encoding: "utf-8",
    stdio: ["pipe", "inherit", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function fetchUser(email: string): UserRow {
  const out = ssh(
    `sqlite3 -separator '|' ${DEV_DB} "SELECT id, COALESCE(team_id, '') FROM users WHERE email = '${email}' LIMIT 1;"`,
  ).trim();
  if (!out) {
    throw new Error(
      `User ${email} not found on dev. Aborting — both ts@ and vm@ must already exist.`,
    );
  }
  const [id, team_id] = out.split("|");
  return { id, email, team_id: team_id || null };
}

function fetchTeamId(name: string): string | null {
  const out = ssh(
    `sqlite3 ${DEV_DB} "SELECT id FROM teams WHERE name = '${name.replace(/'/g, "''")}' LIMIT 1;"`,
  ).trim();
  return out || null;
}

function sql(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function isoOffsetDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function main(): void {
  const ts = fetchUser("ts@reflectmemory.com");
  const vm = fetchUser("vm@reflectmemory.com");
  console.log(`[seed-real] ts@: ${ts.id} (current team: ${ts.team_id ?? "none"})`);
  console.log(`[seed-real] vm@: ${vm.id} (current team: ${vm.team_id ?? "none"})`);

  // Resolve or create the team. NOTE: if either user is already on a
  // DIFFERENT team, we abort — joining a new team while in an existing
  // team would silently break their existing shared memories.
  let teamId = fetchTeamId(TEAM_NAME);
  const teamExisted = !!teamId;
  if (!teamId) {
    teamId = randomUUID();
    console.log(`[seed-real] creating team "${TEAM_NAME}" (${teamId})`);
  } else {
    console.log(`[seed-real] reusing existing team "${TEAM_NAME}" (${teamId})`);
  }

  for (const u of [ts, vm]) {
    if (u.team_id && u.team_id !== teamId) {
      throw new Error(
        `User ${u.email} is already on team ${u.team_id}, refusing to move them. Manually unset their team first if you want to reassign.`,
      );
    }
  }

  // Build fixture INSERTs. UUIDs allocated locally; parent_ref → real id
  // resolved via two-pass.
  const fixtures = getAllFixtures();
  const refToId = new Map<string, string>();
  for (const f of fixtures) refToId.set(f.ref, randomUUID());

  const userByAuthor: Record<FixtureAuthor, string> = {
    tamer: ts.id,
    van: vm.id,
  };

  const now = new Date().toISOString();
  const stmts: string[] = ["BEGIN TRANSACTION;"];

  // Team setup.
  if (!teamExisted) {
    stmts.push(
      `INSERT INTO teams (id, name, owner_id, plan, created_at, updated_at) VALUES (${sql(teamId)}, ${sql(TEAM_NAME)}, ${sql(ts.id)}, 'team', ${sql(now)}, ${sql(now)});`,
    );
  }
  stmts.push(
    `UPDATE users SET team_id = ${sql(teamId)}, team_role = 'owner' WHERE id = ${sql(ts.id)};`,
  );
  stmts.push(
    `UPDATE users SET team_id = ${sql(teamId)}, team_role = 'member' WHERE id = ${sql(vm.id)};`,
  );

  // Fixture inserts.
  for (const fx of fixtures) {
    const id = refToId.get(fx.ref)!;
    const userId = userByAuthor[fx.author];
    const createdAt = isoOffsetDays(fx.created_offset_days);
    const tagsJson = JSON.stringify(fx.tags);
    const memoryType = fx.memory_type ?? "semantic";

    let parentId: string | null = null;
    let parentFixture: MemoryFixture | undefined;
    if (fx.parent_ref) {
      parentId = refToId.get(fx.parent_ref) ?? null;
      parentFixture = fixtures.find((p) => p.ref === fx.parent_ref);
      if (!parentId) throw new Error(`unresolved parent_ref ${fx.parent_ref} on ${fx.ref}`);
    }

    // Sharing: child inherits from parent; top-level uses fx.shared.
    let sharedTeam = "NULL";
    let sharedAt = "NULL";
    if (parentFixture?.shared) {
      sharedTeam = sql(teamId);
      sharedAt = sql(createdAt);
    } else if (fx.shared) {
      sharedTeam = sql(teamId);
      sharedAt = sql(createdAt);
    }
    const parentClause = parentId ? sql(parentId) : "NULL";

    stmts.push(
      `INSERT INTO memories (id, user_id, title, content, tags, origin, allowed_vendors, memory_type, created_at, updated_at, shared_with_team_id, shared_at, parent_memory_id) VALUES (${sql(id)}, ${sql(userId)}, ${sql(fx.title)}, ${sql(fx.content)}, ${sql(tagsJson)}, 'user', '["*"]', ${sql(memoryType)}, ${sql(createdAt)}, ${sql(createdAt)}, ${sharedTeam}, ${sharedAt}, ${parentClause});`,
    );
  }

  stmts.push("COMMIT;");

  console.log(
    `[seed-real] applying transaction: 1 team setup + ${fixtures.length} fixture inserts`,
  );
  execSql(stmts.join("\n"));

  // Manifest for cleanup.
  const sharedCount = fixtures.filter((f) => {
    if (f.parent_ref) {
      const parent = fixtures.find((p) => p.ref === f.parent_ref);
      return parent?.shared === true;
    }
    return f.shared === true;
  }).length;
  const manifest = {
    seeded_at: new Date().toISOString(),
    team: { id: teamId, name: TEAM_NAME, created_now: !teamExisted },
    users: {
      tamer: { id: ts.id, email: ts.email, role: "owner" },
      van: { id: vm.id, email: vm.email, role: "member" },
    },
    fixture_count: fixtures.length,
    shared_count: sharedCount,
    memory_ids_by_author: {
      ts: fixtures
        .filter((f) => f.author === "tamer")
        .map((f) => ({ ref: f.ref, id: refToId.get(f.ref) })),
      vm: fixtures
        .filter((f) => f.author === "van")
        .map((f) => ({ ref: f.ref, id: refToId.get(f.ref) })),
    },
    cleanup_sql: [
      "BEGIN;",
      `DELETE FROM memory_versions WHERE memory_id IN (SELECT id FROM memories WHERE id IN (${[...refToId.values()].map((id) => `'${id}'`).join(",")}));`,
      `DELETE FROM memories WHERE id IN (${[...refToId.values()].map((id) => `'${id}'`).join(",")});`,
      `-- To leave team: UPDATE users SET team_id = NULL, team_role = NULL WHERE id IN ('${ts.id}', '${vm.id}');`,
      `-- To delete team: DELETE FROM teams WHERE id = '${teamId}';`,
      "COMMIT;",
    ].join("\n"),
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`[seed-real] manifest written to ${MANIFEST_PATH}`);

  console.log(`[seed-real] DONE.`);
  console.log(`            Team:        "${TEAM_NAME}" (${teamId})`);
  console.log(`            Owner:       ${ts.email}`);
  console.log(`            Member:      ${vm.email}`);
  console.log(`            Memories:    ${fixtures.length} new (${sharedCount} shared with team)`);
  console.log(`            Manifest:    docs/dev-real-seed-manifest.json (for cleanup if needed)`);
}

main();
