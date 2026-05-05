// Seed the harness corpus into the dev DB.
//
// Reads tests/harness/.harness-config.json (provisioned by setup.ts) for
// the harness user IDs + team id, generates UUIDs for each fixture locally,
// resolves parent_ref → id internally, then ships ONE SQL transaction over
// SSH to the dev VM. This bypasses the dev API's per-user rate limit (we
// were hitting 429s) and the createMemory dedup path (irrelevant for our
// distinct seeded fixtures), and lets us set created_at directly so we
// don't need a separate timestamp-backfill round-trip.
//
// Wipes any existing memories owned by either harness user before seeding,
// so every run starts from the same clean state.
//
// Output: tests/harness/.seeded.json with the ref→id map and a summary so
// downstream scripts (scenarios, judge) can resolve fixture refs into real
// memory IDs.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getAllFixtures } from "./fixtures/index.js";
import type { MemoryFixture, FixtureAuthor } from "./fixtures/types.js";

const CONFIG_PATH = "tests/harness/.harness-config.json";
const SEEDED_PATH = "tests/harness/.seeded.json";
const DEV_HOST = process.env.HARNESS_DEV_HOST ?? "root@144.202.1.205";
const DEV_DB = process.env.HARNESS_DEV_DB ?? "/var/lib/reflect/dev/data/reflect-memory.db";

interface HarnessConfig {
  run_id: string;
  org_id: string;
  team_name: string;
  mcp_url: string;
  generated_at: string;
  users: {
    tamer: { id: string; email: string; api_key: string };
    van: { id: string; email: string; api_key: string };
  };
}

interface SeededRecord {
  ref: string;
  id: string;
  author: FixtureAuthor;
  parent_id: string | null;
  shared: boolean;
  created_at: string;
}

interface SeededOutput {
  run_id: string;
  seeded_at: string;
  api_base: string;
  org_id: string;
  user_ids: { tamer: string; van: string };
  records: SeededRecord[];
  ref_to_id: Record<string, string>;
}

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as HarnessConfig;
const API_BASE = config.mcp_url.replace(/\/mcp$/, "");

const USER_BY_AUTHOR: Record<FixtureAuthor, string> = {
  tamer: config.users.tamer.id,
  van: config.users.van.id,
};

function isoOffsetDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/** Single-quote escape for SQLite string literals. */
function sql(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function buildSeedSql(records: Array<{ fx: MemoryFixture; rec: SeededRecord }>): string {
  const stmts: string[] = ["BEGIN TRANSACTION;"];

  // Wipe everything currently owned by either harness user. This is the
  // "fresh state per run" guarantee.
  const userIdList = [config.users.tamer.id, config.users.van.id]
    .map((id) => `'${id}'`)
    .join(",");
  stmts.push(
    `DELETE FROM memory_versions WHERE memory_id IN (SELECT id FROM memories WHERE user_id IN (${userIdList}));`,
  );
  stmts.push(`DELETE FROM memories WHERE user_id IN (${userIdList});`);

  // Insert all fixtures. Order matters because parent_memory_id has an FK
  // back into memories — but we already sorted parents-before-children in
  // the loader.
  for (const { fx, rec } of records) {
    const userId = USER_BY_AUTHOR[fx.author];
    const tagsJson = JSON.stringify(fx.tags);
    // Children inherit sharing from their parent. For top-level fixtures
    // we set shared_with_org_id directly when fx.shared is true.
    let sharedTeam = "NULL";
    let sharedAt = "NULL";
    if (rec.parent_id) {
      // Children inherit — look up parent's shared status from records list.
      const parentRec = records.find((r) => r.rec.id === rec.parent_id);
      if (parentRec?.rec.shared) {
        sharedTeam = sql(config.org_id);
        sharedAt = sql(rec.created_at);
      }
    } else if (fx.shared) {
      sharedTeam = sql(config.org_id);
      sharedAt = sql(rec.created_at);
    }

    const parentClause = rec.parent_id ? sql(rec.parent_id) : "NULL";
    const memoryType = fx.memory_type ?? "semantic";

    stmts.push(
      `INSERT INTO memories (id, user_id, title, content, tags, origin, allowed_vendors, memory_type, created_at, updated_at, shared_with_org_id, shared_at, parent_memory_id) VALUES (${sql(rec.id)}, ${sql(userId)}, ${sql(fx.title)}, ${sql(fx.content)}, ${sql(tagsJson)}, 'user', '["*"]', ${sql(memoryType)}, ${sql(rec.created_at)}, ${sql(rec.created_at)}, ${sharedTeam}, ${sharedAt}, ${parentClause});`,
    );
  }

  stmts.push("COMMIT;");
  return stmts.join("\n");
}

function applySql(sql: string): void {
  execSync(`ssh ${DEV_HOST} "sqlite3 ${DEV_DB}"`, {
    input: sql,
    encoding: "utf-8",
    stdio: ["pipe", "inherit", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function main(): void {
  const fixtures = getAllFixtures();

  // Resolve refs to UUIDs upfront so the SQL pass can reference parents.
  const refToId = new Map<string, string>();
  const records: Array<{ fx: MemoryFixture; rec: SeededRecord }> = [];
  // Two-pass-friendly: first assign every ref an id, then build records
  // with parent_id resolved.
  for (const fx of fixtures) {
    refToId.set(fx.ref, randomUUID());
  }
  for (const fx of fixtures) {
    const id = refToId.get(fx.ref)!;
    const parentId = fx.parent_ref ? refToId.get(fx.parent_ref) ?? null : null;
    if (fx.parent_ref && !parentId) {
      throw new Error(`fixture ${fx.ref} parent_ref ${fx.parent_ref} unresolved`);
    }
    records.push({
      fx,
      rec: {
        ref: fx.ref,
        id,
        author: fx.author,
        parent_id: parentId,
        // shared is computed in buildSeedSql (children inherit), this just
        // records the user-facing intent.
        shared: Boolean(
          fx.shared || (fx.parent_ref && fixtures.find((p) => p.ref === fx.parent_ref)?.shared),
        ),
        created_at: isoOffsetDays(fx.created_offset_days),
      },
    });
  }

  console.log(
    `[seed] building SQL for ${records.length} fixtures (${records.filter((r) => r.rec.shared).length} effectively shared, ${records.filter((r) => r.rec.parent_id).length} children)`,
  );
  const sqlText = buildSeedSql(records);
  console.log(`[seed] applying transaction (${sqlText.split("\n").length} stmts) over SSH`);
  applySql(sqlText);

  const out: SeededOutput = {
    run_id: config.run_id,
    seeded_at: new Date().toISOString(),
    api_base: API_BASE,
    org_id: config.org_id,
    user_ids: {
      tamer: config.users.tamer.id,
      van: config.users.van.id,
    },
    records: records.map((r) => r.rec),
    ref_to_id: Object.fromEntries(refToId),
  };
  writeFileSync(SEEDED_PATH, JSON.stringify(out, null, 2));
  execSync(`chmod 600 ${SEEDED_PATH}`);
  console.log(`[seed] wrote ${SEEDED_PATH}`);
  console.log(`[seed] DONE.`);
}

main();
