// Fixture loader: composes the per-category fixture files into one ordered
// list (oldest first by created_offset_days, so a parent always comes
// before any of its children when streamed to the API in order).
//
// Also re-exports the types so callers don't need to know the internal
// file layout.

import type { MemoryFixture } from "./types.js";
import ENG from "./engineering.js";
import DECISIONS from "./decisions.js";
import RUNBOOKS from "./runbooks.js";
import SESSIONS from "./sessions.js";
import NOISE from "./noise.js";

export type { MemoryFixture, FixtureAuthor } from "./types.js";

const ALL = [...ENG, ...DECISIONS, ...RUNBOOKS, ...SESSIONS, ...NOISE];

// Validate ref uniqueness — catching a typo here saves a confusing
// foreign-key style failure during seeding.
const seen = new Set<string>();
for (const f of ALL) {
  if (seen.has(f.ref)) {
    throw new Error(`Duplicate fixture ref: ${f.ref}`);
  }
  seen.add(f.ref);
}

// Validate parent_ref pointers resolve.
for (const f of ALL) {
  if (f.parent_ref && !seen.has(f.parent_ref)) {
    throw new Error(
      `Fixture ${f.ref} parent_ref=${f.parent_ref} doesn't match any known ref`,
    );
  }
}

// Sort: parents before children. Children always have created_offset_days
// >= their parent's value so a stable ascending sort is enough.
const ORDERED: MemoryFixture[] = [...ALL].sort((a, b) => {
  // Parents always strictly before children even if offsets are equal.
  if (a.parent_ref === b.ref) return 1;
  if (b.parent_ref === a.ref) return -1;
  return a.created_offset_days - b.created_offset_days;
});

export function getAllFixtures(): MemoryFixture[] {
  return ORDERED;
}

export function fixtureCount(): {
  total: number;
  byCategory: Record<string, number>;
  byAuthor: Record<string, number>;
  threads: number;
  shared: number;
} {
  const all = getAllFixtures();
  const byAuthor: Record<string, number> = {};
  for (const f of all) {
    byAuthor[f.author] = (byAuthor[f.author] ?? 0) + 1;
  }
  const threadParents = new Set(
    all.filter((f) => f.parent_ref).map((f) => f.parent_ref!),
  );
  return {
    total: all.length,
    byCategory: {
      engineering: ENG.length,
      decisions: DECISIONS.length,
      runbooks: RUNBOOKS.length,
      sessions: SESSIONS.length,
      noise: NOISE.length,
    },
    byAuthor,
    threads: threadParents.size,
    shared: all.filter((f) => f.shared).length,
  };
}
