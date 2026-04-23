// Scenario registry. Add new scenarios here.

import type { Scenario } from "./types.js";
import s01 from "./01-reply-to-thread.js";
import s02 from "./02-create-new-top-level.js";
import s03 from "./03-cluster-recall.js";
import s04 from "./04-multi-author-thread.js";
import s05 from "./05-tag-convention-compliance.js";

export const SCENARIOS: Scenario[] = [s01, s02, s03, s04, s05];

export function getScenarioByName(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name === name);
}
