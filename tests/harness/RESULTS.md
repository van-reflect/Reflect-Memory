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

