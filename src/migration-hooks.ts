import type Database from "better-sqlite3";

export type MigrationApplyFn = () => void;

export function runMigrationWithHooks(
  db: Database.Database,
  migrationName: string,
  apply: MigrationApplyFn,
): void {
  const startedAt = Date.now();
  console.log(`[migration] starting ${migrationName}`);
  const tx = db.transaction(() => {
    apply();
    db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
      migrationName,
      new Date().toISOString(),
    );
  });
  tx();
  const elapsedMs = Date.now() - startedAt;
  console.log(`[migration] finished ${migrationName} in ${elapsedMs}ms`);
}
