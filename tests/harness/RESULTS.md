# Harness results log

Append-only log of every harness run for tracking score deltas across iterations.

## 2026-04-23T20:13:54.168Z · sha 62c6464 · reps 1 · scenario reply-to-existing-thread

Overall hard-pass: **0.0%**

| scenario | hard% | tools | steps | ms |
|---|---|---|---|---|
| `reply-to-existing-thread` | 0% | 4.0 | 15.0 | 25331 |

## 2026-04-23T20:16:57.135Z · sha 62c6464 · reps 1

Overall hard-pass: **60.0%**

| scenario | hard% | tools | steps | ms |
|---|---|---|---|---|
| `reply-to-existing-thread` | 0% | 4.0 | 15.0 | 21049 |
| `create-new-top-level` | 100% | 1.0 | 6.0 | 7700 |
| `cluster-recall` | 100% | 5.0 | 18.0 | 24440 |
| `multi-author-thread` | 0% | 6.0 | 21.0 | 29270 |
| `tag-convention-compliance` | 100% | 1.0 | 6.0 | 10210 |

### Findings from baseline (run above):

**Briefing truncates memory IDs (`t.memory_id.slice(0, 8)`) — directly breaks threading scenarios:**

- `reply-to-existing-thread`: model used the truncated id `2c3b9385` from the briefing, write_child_memory failed, model gave up and concluded "the fix is already recorded" (it wasn't).
- `multi-author-thread`: same truncated-id issue. Model fell back to `update_memory` on the existing investigation child rather than `write_child_memory` against the root. Net result: overwrote the original investigation note instead of adding a status update.

**Phase A target locked in:** the briefing v2 must show full memory IDs in the "Current open threads" section. Truncation is a UX-for-humans choice; LLMs need machine-usable identifiers.

**Non-threading scenarios pass on first try (3/3).** The current briefing is already adequate for navigation when threading isn't involved. The graph/cluster work in Phase A is for *better* navigation, not just *adequate*.

## 2026-04-23T20:20:37.947Z · sha 62c6464 · reps 1 · scenario reply-to-existing-thread · judge

Overall hard-pass: **0.0%**

| scenario | hard% | tools | steps | ms |
|---|---|---|---|---|
| `reply-to-existing-thread` | 0% | 4.0 | 15.0 | 20695 |

## 2026-04-23T20:21:19.778Z · sha 62c6464 · reps 1 · scenario reply-to-existing-thread · judge

Overall hard-pass: **0.0%**

| scenario | hard% | tools | steps | ms |
|---|---|---|---|---|
| `reply-to-existing-thread` | 0% | 4.0 | 15.0 | 26723 |

## 2026-04-23T20:22:18.300Z · sha 62c6464 · reps 1 · scenario reply-to-existing-thread · judge

Overall hard-pass: **100.0%** · rubric: **5.67/10**

| scenario | hard% | rubric/10 | tools | steps | ms |
|---|---|---|---|---|---|
| `reply-to-existing-thread` | 100% | 5.7 | 4.0 | 15.0 | 22761 |

## 2026-04-23T20:24:24.985Z · sha 62c6464 · reps 1 · judge

Overall hard-pass: **40.0%** · rubric: **7.33/10**

| scenario | hard% | rubric/10 | tools | steps | ms |
|---|---|---|---|---|---|
| `reply-to-existing-thread` | 0% | 7.7 | 3.0 | 12.0 | 19721 |
| `create-new-top-level` | 100% | 9.0 | 1.0 | 6.0 | 8299 |
| `cluster-recall` | 100% | 8.0 | 4.0 | 14.0 | 20298 |
| `multi-author-thread` | 0% | 9.0 | 4.0 | 15.0 | 23704 |
| `tag-convention-compliance` | 0% | 3.0 | 1.0 | 6.0 | 9090 |

## 2026-04-23T20:31:26.324Z · sha 62c6464 · reps 3 · judge

Overall hard-pass: **60.0%** · rubric: **8.76/10**

| scenario | hard% | rubric/10 | tools | steps | ms |
|---|---|---|---|---|---|
| `reply-to-existing-thread` | 0% | 7.9 | 3.0 | 12.0 | 20375 |
| `create-new-top-level` | 100% | 9.2 | 1.0 | 6.0 | 8878 |
| `cluster-recall` | 100% | 8.5 | 5.3 | 18.7 | 27494 |
| `multi-author-thread` | 0% | 8.8 | 4.0 | 15.0 | 20766 |
| `tag-convention-compliance` | 100% | 9.5 | 1.0 | 6.0 | 10807 |


---

## OFFICIAL BASELINE (pre-Phase-A)

Run above (sha 62c6464, 2026-04-23T20:25, N=3 reps × 5 scenarios × judge).

**Hard pass: 60.0% (3/5 scenarios pass all reps)**
**Rubric: 8.76/10**

Stable findings (consistent across all reps):
- Threading scenarios fail 100% (6/6 reps) — root cause: briefing truncates memory IDs to 8 chars, model can't successfully reference parents.
- Non-threading scenarios pass 100% (9/9 reps).
- Judge correctly distinguishes "structurally wrong by spec" from "behaviorally reasonable" — multi-author scored rubric 8.8/10 despite hard fail because the model's fallback (UPDATE the existing investigation) is defensible even though it's not what we want.

Phase A targets in priority order:
1. **Briefing v2: full memory IDs in open-threads section.** Single biggest lever; expected to flip both threading scenarios from 0% → high.
2. Briefing v2: topic clusters + thread grouping under clusters (the original Phase A scope).
3. Tighter `write_memory` / `write_child_memory` tool descriptions nudging "check open threads first."

Phase A success target: ≥80% hard pass + ≥9.0 rubric across the same 5 scenarios.

## 2026-04-23T20:41:03.376Z · sha 698e0a6 · reps 3 · judge

Overall hard-pass: **60.0%** · rubric: **7.79/10**

| scenario | hard% | rubric/10 | tools | steps | ms |
|---|---|---|---|---|---|
| `reply-to-existing-thread` | 100% | 9.1 | 1.0 | 6.0 | 9836 |
| `create-new-top-level` | 100% | 9.3 | 1.0 | 6.0 | 8458 |
| `cluster-recall` | 100% | 8.3 | 6.0 | 21.0 | 24069 |
| `multi-author-thread` | 0% | 8.7 | 3.3 | 13.0 | 15735 |
| `tag-convention-compliance` | 0% | 3.5 | 1.0 | 6.0 | 10939 |

## 2026-04-23T20:48:33.024Z · sha 7565d21 · reps 3 · judge

Overall hard-pass: **73.3%** · rubric: **8.84/10**

| scenario | hard% | rubric/10 | tools | steps | ms |
|---|---|---|---|---|---|
| `reply-to-existing-thread` | 67% | 8.9 | 1.3 | 7.0 | 11451 |
| `create-new-top-level` | 100% | 9.0 | 1.0 | 6.0 | 7759 |
| `cluster-recall` | 100% | 8.3 | 5.0 | 18.0 | 21451 |
| `multi-author-thread` | 0% | 8.5 | 3.0 | 12.0 | 13709 |
| `tag-convention-compliance` | 100% | 9.5 | 1.0 | 6.0 | 8278 |

## 2026-04-23T20:56:28.892Z · sha 574a0ce · reps 3 · judge

Overall hard-pass: **100.0%** · rubric: **8.88/10**

| scenario | hard% | rubric/10 | tools | steps | ms |
|---|---|---|---|---|---|
| `reply-to-existing-thread` | 100% | 8.9 | 1.0 | 6.0 | 9690 |
| `create-new-top-level` | 100% | 9.0 | 1.0 | 6.0 | 8256 |
| `cluster-recall` | 100% | 8.0 | 4.3 | 16.0 | 18716 |
| `multi-author-thread` | 100% | 9.0 | 1.0 | 6.0 | 8194 |
| `tag-convention-compliance` | 100% | 9.5 | 1.0 | 6.0 | 10628 |

## 2026-04-23T21:20:29.686Z · sha 90a6048 · reps 3 · judge

Overall hard-pass: **86.7%** · rubric: **8.93/10**

| scenario | hard% | rubric/10 | tools | steps | ms |
|---|---|---|---|---|---|
| `reply-to-existing-thread` | 67% | 9.0 | 1.3 | 7.0 | 9919 |
| `create-new-top-level` | 100% | 9.2 | 1.0 | 6.0 | 8323 |
| `cluster-recall` | 100% | 8.2 | 5.7 | 19.0 | 23748 |
| `multi-author-thread` | 100% | 9.0 | 1.0 | 6.0 | 9596 |
| `tag-convention-compliance` | 67% | 9.3 | 1.0 | 6.0 | 8940 |

## 2026-04-23T21:28:16.839Z · sha 694685c · reps 3 · judge

Overall hard-pass: **93.3%** · rubric: **8.81/10**

| scenario | hard% | rubric/10 | tools | steps | ms |
|---|---|---|---|---|---|
| `reply-to-existing-thread` | 100% | 8.9 | 1.7 | 8.0 | 12403 |
| `create-new-top-level` | 100% | 9.0 | 1.0 | 6.0 | 9624 |
| `cluster-recall` | 67% | 7.7 | 6.0 | 20.7 | 21478 |
| `multi-author-thread` | 100% | 9.0 | 1.0 | 6.0 | 9246 |
| `tag-convention-compliance` | 100% | 9.5 | 1.0 | 6.0 | 9643 |

## 2026-04-23T21:30:32.139Z · sha 694685c · reps 3 · scenario cluster-recall · judge

Overall hard-pass: **100.0%** · rubric: **8.17/10**

| scenario | hard% | rubric/10 | tools | steps | ms |
|---|---|---|---|---|---|
| `cluster-recall` | 100% | 8.2 | 6.3 | 21.7 | 25391 |

## 2026-04-23T21:35:11.125Z · sha 694685c · reps 3 · judge

Overall hard-pass: **93.3%** · rubric: **8.82/10**

| scenario | hard% | rubric/10 | tools | steps | ms |
|---|---|---|---|---|---|
| `reply-to-existing-thread` | 67% | 8.4 | 1.3 | 7.0 | 11160 |
| `create-new-top-level` | 100% | 9.2 | 1.0 | 6.0 | 7667 |
| `cluster-recall` | 100% | 8.0 | 5.7 | 20.0 | 24889 |
| `multi-author-thread` | 100% | 9.0 | 1.0 | 6.0 | 9609 |
| `tag-convention-compliance` | 100% | 9.5 | 1.0 | 6.0 | 10899 |

## 2026-04-23T21:48:25.424Z · sha b2ff97c · reps 3 · judge

Overall hard-pass: **73.3%** · rubric: **7.72/10**

| scenario | hard% | rubric/10 | tools | steps | ms |
|---|---|---|---|---|---|
| `reply-to-existing-thread` | 100% | 9.0 | 1.3 | 7.0 | 11349 |
| `create-new-top-level` | 100% | 9.0 | 1.0 | 6.0 | 8888 |
| `cluster-recall` | 100% | 8.2 | 5.0 | 17.3 | 18222 |
| `multi-author-thread` | 100% | 9.0 | 1.0 | 6.0 | 8921 |
| `tag-convention-compliance` | 100% | 9.5 | 1.0 | 6.0 | 8007 |
| `avoid-duplication` | 0% | 1.0 | 1.0 | 6.0 | 10952 |
| `cross-reference` | 0% | 8.8 | 1.0 | 6.0 | 9648 |
| `supersession` | 33% | 9.3 | 1.3 | 7.0 | 12614 |
| `briefing-only-navigation` | 100% | 8.8 | 0.0 | 3.0 | 11138 |
| `cluster-write` | 100% | 4.5 | 1.0 | 6.0 | 8514 |

## 2026-04-23T22:00:42.275Z · sha 47ad4b6 · reps 3 · judge

Overall hard-pass: **80.0%** · rubric: **8.66/10**

| scenario | hard% | rubric/10 | tools | steps | ms |
|---|---|---|---|---|---|
| `reply-to-existing-thread` | 100% | 9.1 | 1.7 | 8.0 | 12464 |
| `create-new-top-level` | 100% | 8.8 | 1.0 | 6.0 | 8378 |
| `cluster-recall` | 100% | 8.3 | 6.0 | 20.7 | 25304 |
| `multi-author-thread` | 100% | 9.0 | 1.0 | 6.0 | 9653 |
| `tag-convention-compliance` | 100% | 9.5 | 1.0 | 6.0 | 9272 |
| `avoid-duplication` | 67% | 9.2 | 2.7 | 10.0 | 14084 |
| `cross-reference` | 0% | 9.3 | 1.0 | 6.0 | 8879 |
| `supersession` | 33% | 8.0 | 2.3 | 10.0 | 18936 |
| `briefing-only-navigation` | 100% | 8.8 | 0.0 | 3.0 | 12141 |
| `cluster-write` | 100% | 6.5 | 1.0 | 6.0 | 8871 |

## 2026-04-23T22:02:24.801Z · sha 47ad4b6 · reps 3 · scenario cross-reference · judge

Overall hard-pass: **66.7%** · rubric: **9.50/10**

| scenario | hard% | rubric/10 | tools | steps | ms |
|---|---|---|---|---|---|
| `cross-reference` | 67% | 9.5 | 1.0 | 6.0 | 11108 |

## 2026-04-23T22:03:35.799Z · sha 47ad4b6 · reps 3 · scenario supersession · judge

Overall hard-pass: **0.0%** · rubric: **7.17/10**

| scenario | hard% | rubric/10 | tools | steps | ms |
|---|---|---|---|---|---|
| `supersession` | 0% | 7.2 | 2.0 | 8.7 | 17939 |

## 2026-04-23T22:14:11.276Z · sha 47ad4b6 · reps 3 · judge

Overall hard-pass: **96.7%** · rubric: **8.47/10**

| scenario | hard% | rubric/10 | tools | steps | ms |
|---|---|---|---|---|---|
| `reply-to-existing-thread` | 100% | 9.3 | 2.0 | 9.0 | 11106 |
| `create-new-top-level` | 100% | 9.2 | 1.0 | 6.0 | 8621 |
| `cluster-recall` | 100% | 8.3 | 6.0 | 20.0 | 26535 |
| `multi-author-thread` | 100% | 9.2 | 1.0 | 6.0 | 9802 |
| `tag-convention-compliance` | 100% | 9.5 | 1.0 | 6.0 | 9530 |
| `avoid-duplication` | 67% | 6.5 | 2.0 | 8.7 | 11508 |
| `cross-reference` | 100% | 10.0 | 1.3 | 7.0 | 11684 |
| `supersession` | 100% | 9.0 | 2.3 | 10.0 | 19899 |
| `briefing-only-navigation` | 100% | 9.0 | 0.0 | 3.0 | 13353 |
| `cluster-write` | 100% | 4.7 | 1.0 | 6.0 | 8600 |

