// Unit tests: src/quarantine.ts
//
// isCiTestMemory drives the anti-pollution guard that auto-trashes test memories
// landing in real user accounts when RM_TEST_MODE is OFF. Both the patterns it
// matches AND the ones it deliberately ignores matter -- a too-loose matcher
// would soft-delete legitimate memories.

import { describe, expect, it } from "vitest";
import { isCiTestMemory } from "../../src/quarantine.js";

describe("isCiTestMemory: matches", () => {
  it.each([
    ["title starts with 'CI '", { title: "CI write t-abcd", tags: [] }],
    ["title contains 'ci-'", { title: "anything ci-abc", tags: [] }],
    ["tag starts with 'ci_'", { title: "real-looking title", tags: ["ci_test"] }],
    ["tag contains 'integration_test'", { title: "real title", tags: ["foo_integration_test_bar"] }],
    ["multiple ci_ tags", { title: "x", tags: ["a", "ci_smoke"] }],
  ])("matches when %s", (_label, m) => {
    expect(isCiTestMemory(m)).toBe(true);
  });
});

describe("isCiTestMemory: non-matches (false-positive guards)", () => {
  it.each([
    ["title starts with 'ci' but no space/dash", { title: "civilization rules", tags: [] }],
    ["lowercase 'ci ' (case-sensitive 'CI ' check)", { title: "ci write here", tags: [] }],
    ["plain everyday title", { title: "Weekly status update", tags: ["status", "work"] }],
    ["empty tags", { title: "Hello world", tags: [] }],
    ["tag named 'civic' (no underscore)", { title: "x", tags: ["civic"] }],
  ])("does NOT match when %s", (_label, m) => {
    expect(isCiTestMemory(m)).toBe(false);
  });
});
