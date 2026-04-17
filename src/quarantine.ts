// Detect memories that look like leftovers from CI/integration test runs.
// Used to soft-delete obvious test pollution from real user accounts when
// RM_TEST_MODE is OFF. In RM_TEST_MODE the check is bypassed so integration
// suites can write/read freely against the ephemeral DB.
//
// Patterns considered "CI-flavoured":
//   - title starts with "CI " (e.g., "CI write t-abcd")
//   - title contains "ci-" anywhere
//   - any tag starts with "ci_"
//   - any tag contains "integration_test"
export function isCiTestMemory(m: { title: string; tags: string[] }): boolean {
  if (m.title.startsWith("CI ") || m.title.includes("ci-")) return true;
  return m.tags.some(
    (t) => t.startsWith("ci_") || t.includes("integration_test"),
  );
}
