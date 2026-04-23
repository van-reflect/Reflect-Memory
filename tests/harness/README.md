# Harness

End-to-end harness that drives an LLM (Anthropic API) against the **real
dev MCP server** through a self-rolled MCP client, scores its behavior
against scenario assertions + an LLM-as-judge rubric, and tracks scores
across iterations.

Built to drive iteration on the briefing / graph-tag work. See
`docs/knowledge-graph-implementation-plan.md` for the broader plan.

## What's here

| File | Role |
|---|---|
| `setup.ts` | Provisions `harness-tamer@test.local` + `harness-van@test.local` users on a dedicated `harness-team` in dev. Generates fresh API keys per run. SSH-driven SQL on the dev VM. Idempotent. |
| `fixtures/*.ts` | Realistic memory corpus across 5 categories (engineering, decisions, runbooks, sessions, noise) — currently 45 memories with 4 threads, ~73/27 Tamer/Van split, ~50% shared. |
| `seed.ts` | Wipes harness state, seeds the corpus directly into dev DB via SSH+sqlite (bypasses API rate limits and dedup). Writes `.seeded.json` with the ref→id map. |
| `driver.ts` | Connects to dev MCP via `@modelcontextprotocol/sdk` Streamable HTTP, captures briefing + tool defs, drives Anthropic Messages API, loops on tool_use, returns a structured transcript. |
| `scenarios/*.ts` | Task scenarios. Each scenario has: a prompt, hard assertions over the transcript, and rubric questions for the judge. |
| `judge.ts` | Rubric judge using Claude Opus. Renders the transcript into a compact form, asks structured-JSON questions, returns 0-10 composite. |
| `runner.ts` | Orchestrator. Runs scenarios × reps, applies assertions, optionally judges, prints scoreboard, appends to `RESULTS.md`. |
| `RESULTS.md` | Append-only log of every run. The official record of score deltas across iterations. |

## Setup

1. **API keys.** Create `tests/harness/.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
   (gitignored via `.env*` rule). The harness MCP keys come from `.harness-config.json` which `setup.ts` writes for you.

2. **Provision harness users + seed the corpus** (run once, or any time you want fresh state):
   ```bash
   npx tsx tests/harness/setup.ts   # creates users + team, mints API keys
   npx tsx tests/harness/seed.ts    # wipes + seeds 45 memories
   ```
   Both write to `tests/harness/.harness-config.json` and `.seeded.json` (both gitignored, mode 600).

3. **Run scenarios:**
   ```bash
   # 1 rep, no judge — fast smoke (~30s for all 5)
   npx tsx tests/harness/runner.ts

   # full run: 3 reps × 5 scenarios × judge (~5 min, ~$2)
   npx tsx tests/harness/runner.ts --reps 3 --judge

   # single scenario (debugging)
   npx tsx tests/harness/runner.ts --scenario reply-to-existing-thread --judge
   ```

   Output goes to `runs/<run_id>/<invocation_id>/<scenario>-rep<N>.json` and a summary line is appended to `RESULTS.md`.

## Required env / prerequisites

- SSH access to the dev VM (`root@144.202.1.205` by default; override with `HARNESS_DEV_HOST`) — used by `setup.ts` and `seed.ts`.
- `sqlite3` installed on the VM (already there).
- `ANTHROPIC_API_KEY` in `tests/harness/.env`.

## Cost

- Driver model (default Sonnet 4.5): ~$0.05-0.15 per scenario run.
- Judge model (default Opus 4.7): ~$0.05-0.10 per judged scenario.
- Full 3-rep × 5-scenario × judge run: ~$2.

## Adding a scenario

1. Create `scenarios/NN-name.ts` (use `01-reply-to-thread.ts` as template).
2. Add it to `scenarios/index.ts`.
3. Use `ctx.refToId["fixture-ref"]` in assertions to reference seeded memories by their fixture ref instead of hard-coding UUIDs.

## Adding a fixture

1. Add an entry to one of `fixtures/*.ts` (engineering / decisions / runbooks / sessions / noise).
2. Re-run `seed.ts`. The loader validates `ref` uniqueness and `parent_ref` resolution.

## Debugging a failing scenario

The transcript JSON in `runs/<run_id>/<invocation_id>/<scenario>-rep<N>.json` includes:

- Every tool_use with full input
- Every tool_result with content preview
- The full `events` log with step numbers
- Hard assertion results with `pass` + `detail`
- Judge `answers` array with reasoning per rubric question

Most useful diagnostic flow: open the transcript, look at the `toolUses` array, then look at the `judge.answers` for human-readable reasoning about why behavior was off.
