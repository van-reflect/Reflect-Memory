// Scenario registry. Add new scenarios here.

import type { Scenario } from "./types.js";
import s01 from "./01-reply-to-thread.js";
import s02 from "./02-create-new-top-level.js";
import s03 from "./03-cluster-recall.js";
import s04 from "./04-multi-author-thread.js";
import s05 from "./05-tag-convention-compliance.js";
import s06 from "./06-avoid-duplication.js";
import s07 from "./07-cross-reference.js";
import s08 from "./08-supersession.js";
import s09 from "./09-briefing-only-navigation.js";
import s10 from "./10-cluster-write.js";

export const SCENARIOS: Scenario[] = [
  s01, s02, s03, s04, s05,
  s06, s07, s08, s09, s10,
];

export function getScenarioByName(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name === name);
}
