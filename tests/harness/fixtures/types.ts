// Fixture types for the harness corpus.
//
// Each MemoryFixture describes one memory we want to seed in the harness
// users' accounts. The seeder resolves cross-fixture references (parent_ref
// → real parent_memory_id), sorts by created_offset_days ascending so
// parents always exist before their children, and rewrites the API-supplied
// `created_at` to the back-dated value so cluster + thread heuristics that
// rely on time order behave realistically.

export type FixtureAuthor = "tamer" | "van";

export interface MemoryFixture {
  /** Local id for cross-fixture linking. Must be unique across the corpus. */
  ref: string;
  /** Which harness user creates this memory. */
  author: FixtureAuthor;
  title: string;
  content: string;
  tags: string[];
  /**
   * If true, the seeder calls /memories/:id/share after creation. For child
   * memories this is implicit (children inherit their parent's sharing).
   */
  shared?: boolean;
  /** ref of the parent memory if this is a reply (single-level threading). */
  parent_ref?: string;
  /**
   * Days in the past from seeding time. Negative numbers = older.
   * The seeder UPDATEs `created_at` and `updated_at` to this value after
   * insert so time-window queries (active-this-week, etc.) behave as if
   * the corpus has matured naturally.
   */
  created_offset_days: number;
  /**
   * Memory type. Defaults to "semantic" if omitted (matches API default).
   */
  memory_type?: "semantic" | "episodic" | "procedural";
}

/** A category file exports a flat array of MemoryFixtures. */
export type FixtureCategory = MemoryFixture[];
