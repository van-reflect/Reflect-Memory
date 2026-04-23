// Harness runner: orchestrates scenario runs.
//
// Reads .seeded.json + .harness-config.json, runs every scenario in the
// registry N times (default 1), applies hard assertions, writes per-rep
// transcripts to runs/<run_id>/<scenario>-<rep>.json, prints a scoreboard
// to stdout, and appends a one-line summary to RESULTS.md so we have a
// running history of harness scores across iterations.
//
// Rubric judging (B5) lives in judge.ts and is wired in optionally via
// --judge. Without it, we only report hard-assertion pass rates.
//
// Usage:
//   npx tsx tests/harness/runner.ts                     # 1 rep, no judge
//   npx tsx tests/harness/runner.ts --reps 3            # 3 reps per scenario
//   npx tsx tests/harness/runner.ts --scenario reply-to-existing-thread
//   npx tsx tests/harness/runner.ts --reps 3 --judge    # full run

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { runScenario } from "./driver.js";
import { judgeTranscript, type JudgeResult } from "./judge.js";
import { SCENARIOS, getScenarioByName } from "./scenarios/index.js";
import type {
  Scenario,
  CapturedTranscript,
  ScenarioContext,
  AssertionResult,
} from "./scenarios/types.js";

interface SeededOutput {
  run_id: string;
  api_base: string;
  team_id: string;
  user_ids: { tamer: string; van: string };
  ref_to_id: Record<string, string>;
}

interface CliArgs {
  reps: number;
  scenario?: string;
  judge: boolean;
  out: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { reps: 1, judge: false, out: "tests/harness/runs" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reps") {
      args.reps = parseInt(argv[++i], 10);
    } else if (a === "--scenario") {
      args.scenario = argv[++i];
    } else if (a === "--judge") {
      args.judge = true;
    } else if (a === "--out") {
      args.out = argv[++i];
    }
  }
  return args;
}

interface RepResult {
  scenario: string;
  rep: number;
  hard_pass: boolean;
  assertions: AssertionResult[];
  duration_ms: number;
  steps: number;
  tool_calls: number;
  stop_reason: string | null;
  transcript_path: string;
  judge?: JudgeResult;
}

interface ScenarioAggregate {
  scenario: string;
  reps: number;
  hard_pass_rate: number;
  pass_per_assertion: Record<string, number>;
  mean_duration_ms: number;
  mean_steps: number;
  mean_tool_calls: number;
  /** Mean composite 0-10 across reps if rubric judging was enabled. */
  mean_rubric_0_10?: number;
}

async function runOne(
  scenario: Scenario,
  rep: number,
  ctx: ScenarioContext,
  outDir: string,
  enableJudge: boolean,
): Promise<RepResult> {
  const transcript: CapturedTranscript = await runScenario(scenario, { rep });

  const assertions: AssertionResult[] = scenario.assertions.map((fn) => {
    try {
      return fn(transcript, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { name: fn.name || "(anonymous)", pass: false, detail: `THREW: ${msg}` };
    }
  });
  const hardPass = assertions.every((a) => a.pass);

  let judge: JudgeResult | undefined;
  if (enableJudge && scenario.rubric && scenario.rubric.length > 0) {
    try {
      judge = await judgeTranscript(transcript, scenario);
    } catch (err) {
      console.error(
        `[runner] judge failed for ${scenario.name} rep ${rep}: ${(err as Error).message}`,
      );
    }
  }

  const transcriptPath = `${outDir}/${scenario.name}-rep${rep}.json`;
  writeFileSync(
    transcriptPath,
    JSON.stringify(
      {
        ...transcript,
        assertions,
        hard_pass: hardPass,
        judge,
      },
      null,
      2,
    ),
  );

  return {
    scenario: scenario.name,
    rep,
    hard_pass: hardPass,
    assertions,
    duration_ms: transcript.durationMs,
    steps: transcript.steps,
    tool_calls: transcript.toolUses.length,
    stop_reason: transcript.stopReason,
    transcript_path: transcriptPath,
    judge,
  };
}

function aggregate(results: RepResult[]): ScenarioAggregate {
  const reps = results.length;
  const hardPasses = results.filter((r) => r.hard_pass).length;
  const passPerAssertion: Record<string, number> = {};
  for (const r of results) {
    for (const a of r.assertions) {
      passPerAssertion[a.name] = (passPerAssertion[a.name] ?? 0) + (a.pass ? 1 : 0);
    }
  }
  for (const k of Object.keys(passPerAssertion)) {
    passPerAssertion[k] = passPerAssertion[k] / reps;
  }
  const judgeScores = results
    .map((r) => r.judge?.composite_0_10)
    .filter((v): v is number => typeof v === "number");
  const meanRubric =
    judgeScores.length > 0
      ? Number(
          (judgeScores.reduce((s, v) => s + v, 0) / judgeScores.length).toFixed(2),
        )
      : undefined;
  return {
    scenario: results[0].scenario,
    reps,
    hard_pass_rate: hardPasses / reps,
    pass_per_assertion: passPerAssertion,
    mean_duration_ms: Math.round(results.reduce((s, r) => s + r.duration_ms, 0) / reps),
    mean_steps: results.reduce((s, r) => s + r.steps, 0) / reps,
    mean_tool_calls: results.reduce((s, r) => s + r.tool_calls, 0) / reps,
    mean_rubric_0_10: meanRubric,
  };
}

function printScoreboard(aggs: ScenarioAggregate[]): void {
  const hasJudge = aggs.some((a) => typeof a.mean_rubric_0_10 === "number");
  console.log("");
  console.log("=== HARNESS SCOREBOARD ===");
  const headerCols = "  hard%   reps  steps  tools  ms" + (hasJudge ? "    rubric" : "");
  console.log("scenario".padEnd(35) + headerCols);
  console.log("-".repeat(headerCols.length + 35));
  for (const a of aggs) {
    const rubricCol = hasJudge
      ? `  ${typeof a.mean_rubric_0_10 === "number" ? a.mean_rubric_0_10.toFixed(1).padStart(5) : "  --"}`
      : "";
    console.log(
      a.scenario.padEnd(35) +
        `  ${(a.hard_pass_rate * 100).toFixed(0).padStart(4)}%  ${String(a.reps).padStart(4)}  ${a.mean_steps.toFixed(1).padStart(5)}  ${a.mean_tool_calls.toFixed(1).padStart(5)}  ${String(a.mean_duration_ms).padStart(5)}${rubricCol}`,
    );
  }
  const overallHard = aggs.reduce((s, a) => s + a.hard_pass_rate, 0) / aggs.length;
  console.log("-".repeat(headerCols.length + 35));
  console.log(`overall hard pass rate: ${(overallHard * 100).toFixed(1)}%`);
  if (hasJudge) {
    const rubricVals = aggs
      .map((a) => a.mean_rubric_0_10)
      .filter((v): v is number => typeof v === "number");
    if (rubricVals.length > 0) {
      const meanR = rubricVals.reduce((s, v) => s + v, 0) / rubricVals.length;
      console.log(`overall rubric (0-10): ${meanR.toFixed(2)}`);
    }
  }
  console.log("");

  // Per-assertion drilldown for any failures.
  const drilldown: string[] = [];
  for (const a of aggs) {
    const failed = Object.entries(a.pass_per_assertion).filter(([, rate]) => rate < 1);
    if (failed.length === 0) continue;
    drilldown.push(`${a.scenario}:`);
    for (const [name, rate] of failed) {
      drilldown.push(`  ${(rate * 100).toFixed(0).padStart(4)}%  ${name}`);
    }
  }
  if (drilldown.length > 0) {
    console.log("=== FAILED ASSERTIONS ===");
    console.log(drilldown.join("\n"));
  }
}

function appendResultsLog(args: CliArgs, aggs: ScenarioAggregate[]): void {
  const date = new Date().toISOString();
  let sha = "(unknown)";
  try {
    sha = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    /* not a git repo or git unavailable */
  }
  const overallHard = (
    (aggs.reduce((s, a) => s + a.hard_pass_rate, 0) / aggs.length) *
    100
  ).toFixed(1);
  const rubricVals = aggs
    .map((a) => a.mean_rubric_0_10)
    .filter((v): v is number => typeof v === "number");
  const overallRubric =
    rubricVals.length > 0
      ? (rubricVals.reduce((s, v) => s + v, 0) / rubricVals.length).toFixed(2)
      : null;

  const lines: string[] = [];
  lines.push(
    `## ${date} · sha ${sha} · reps ${args.reps}${args.scenario ? ` · scenario ${args.scenario}` : ""}${args.judge ? " · judge" : ""}`,
  );
  lines.push("");
  lines.push(
    `Overall hard-pass: **${overallHard}%**${overallRubric ? ` · rubric: **${overallRubric}/10**` : ""}`,
  );
  lines.push("");
  const hasRubric = aggs.some((a) => typeof a.mean_rubric_0_10 === "number");
  if (hasRubric) {
    lines.push("| scenario | hard% | rubric/10 | tools | steps | ms |");
    lines.push("|---|---|---|---|---|---|");
    for (const a of aggs) {
      lines.push(
        `| \`${a.scenario}\` | ${(a.hard_pass_rate * 100).toFixed(0)}% | ${typeof a.mean_rubric_0_10 === "number" ? a.mean_rubric_0_10.toFixed(1) : "—"} | ${a.mean_tool_calls.toFixed(1)} | ${a.mean_steps.toFixed(1)} | ${a.mean_duration_ms} |`,
      );
    }
  } else {
    lines.push("| scenario | hard% | tools | steps | ms |");
    lines.push("|---|---|---|---|---|");
    for (const a of aggs) {
      lines.push(
        `| \`${a.scenario}\` | ${(a.hard_pass_rate * 100).toFixed(0)}% | ${a.mean_tool_calls.toFixed(1)} | ${a.mean_steps.toFixed(1)} | ${a.mean_duration_ms} |`,
      );
    }
  }
  lines.push("");

  const path = "tests/harness/RESULTS.md";
  const header = existsSync(path)
    ? ""
    : "# Harness results log\n\nAppend-only log of every harness run for tracking score deltas across iterations.\n\n";
  appendFileSync(path, header + lines.join("\n") + "\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const seeded = JSON.parse(readFileSync("tests/harness/.seeded.json", "utf-8")) as SeededOutput;
  const ctx: ScenarioContext = {
    refToId: seeded.ref_to_id,
    userIds: seeded.user_ids,
    teamId: seeded.team_id,
  };

  // Each runner invocation gets a fresh timestamp-suffixed subdir under
  // the seeded run_id so re-runs against the same corpus don't overwrite
  // each other's transcripts.
  const invocationId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const outDir = `${args.out}/${seeded.run_id}/${invocationId}`;
  mkdirSync(outDir, { recursive: true });

  const targets: Scenario[] = args.scenario
    ? [getScenarioByName(args.scenario)!].filter(Boolean)
    : SCENARIOS;
  if (targets.length === 0) {
    console.error(`[runner] no scenarios match --scenario=${args.scenario}`);
    process.exit(2);
  }

  console.log(`[runner] run_id=${seeded.run_id}`);
  console.log(`[runner] running ${targets.length} scenario(s) × ${args.reps} rep(s)`);
  console.log(`[runner] transcripts → ${outDir}`);
  console.log("");

  const aggs: ScenarioAggregate[] = [];
  for (const scenario of targets) {
    const reps: RepResult[] = [];
    for (let r = 0; r < args.reps; r++) {
      process.stdout.write(`[run] ${scenario.name} rep ${r}... `);
      const res = await runOne(scenario, r, ctx, outDir, args.judge);
      reps.push(res);
      const rubricCol = res.judge
        ? ` · rubric ${res.judge.composite_0_10.toFixed(1)}/10`
        : "";
      console.log(
        `${res.hard_pass ? "PASS" : "FAIL"} (${res.tool_calls} tools · ${res.steps} steps · ${res.duration_ms}ms${rubricCol})`,
      );
    }
    aggs.push(aggregate(reps));
  }

  printScoreboard(aggs);
  appendResultsLog(args, aggs);
  console.log(`[runner] results appended to tests/harness/RESULTS.md`);
}

main().catch((err) => {
  console.error("[runner] FATAL:", err);
  process.exit(1);
});
