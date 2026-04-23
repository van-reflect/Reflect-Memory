// Rubric judge: an LLM-as-judge that scores a captured transcript against
// a scenario's rubric questions.
//
// Why a separate model for judging:
//   - Different prompt context (the judge gets the transcript + rubric, NOT
//     the briefing or the MCP tools — it's evaluating, not navigating).
//   - We can use a stronger model (Opus) to grade Sonnet's runs without
//     either model evaluating itself.
//   - Strict JSON output via the response model's `tool_use` / structured
//     prompt — the judge's freeform commentary becomes deterministic data.
//
// The judge does NOT look at hard assertions (those are deterministic and
// already in the transcript JSON). It evaluates the rubric questions
// only — typically things like "did the LLM follow team conventions?"
// or "score 0-10 on naturalness".

import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { CapturedTranscript, RubricQuestion, Scenario } from "./scenarios/types.js";

export interface RubricAnswer {
  id: string;
  question: string;
  type: "yes_no" | "score_0_10";
  /** boolean for yes_no, 0-10 integer for score_0_10. */
  value: boolean | number;
  reasoning: string;
}

export interface JudgeResult {
  scenario: string;
  rep: number;
  answers: RubricAnswer[];
  /** Mean of: each yes-no as 1.0/0.0, each 0-10 score divided by 10, then ×10 to land 0-10. */
  composite_0_10: number;
  judge_model: string;
  judge_duration_ms: number;
}

// Default judge: Opus 4.7 (latest, strongest reasoning). Override via
// HARNESS_JUDGE_MODEL. Sonnet under test runs as the harness driver model.
const DEFAULT_JUDGE_MODEL =
  process.env.HARNESS_JUDGE_MODEL ?? "claude-opus-4-7";

function loadAnthropicKey(): string {
  // Same .env loader as the driver — keeps modules independent.
  let text = "";
  try {
    text = readFileSync("tests/harness/.env", "utf-8");
  } catch {
    /* env may already be set in process */
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  return key;
}

/**
 * Render a transcript into a compact human-readable form for the judge.
 * Skipping the system block (briefing) keeps token cost down — the judge
 * doesn't need the briefing to evaluate the rubric, just the user prompt
 * + assistant turns + tool calls.
 */
function renderTranscript(t: CapturedTranscript): string {
  const lines: string[] = [];
  lines.push(`# Scenario: ${t.scenario} (rep ${t.rep})`);
  lines.push(`Author (which user ran the prompt): ${t.author}`);
  lines.push("");
  lines.push("## User prompt");
  lines.push(t.prompt);
  lines.push("");

  for (const ev of t.events) {
    if (ev.kind === "system") continue;
    if (ev.kind === "user") {
      // Skip the initial user message (already shown above) but render
      // tool_result blocks (those come back as user-role messages).
      if (typeof ev.payload === "object" && ev.payload && "content" in ev.payload) {
        // skip — that's the original prompt
      }
      continue;
    }
    if (ev.kind === "assistant") {
      const p = ev.payload as { stop_reason: string | null; content: Array<{ type: string; text?: string }> };
      const textBlocks = (p.content || [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      const toolBlocks = (p.content || []).filter((c) => c.type === "tool_use");
      if (textBlocks.trim()) {
        lines.push(`## Assistant turn ${ev.step} (stop: ${p.stop_reason})`);
        lines.push(textBlocks);
        lines.push("");
      }
      if (toolBlocks.length > 0 && !textBlocks.trim()) {
        lines.push(`## Assistant turn ${ev.step} (stop: ${p.stop_reason}) — tool use only`);
        lines.push("");
      }
    }
    if (ev.kind === "tool_use") {
      const p = ev.payload as { name: string; input: Record<string, unknown> };
      lines.push(`### Tool call: ${p.name}`);
      lines.push("```json");
      lines.push(JSON.stringify(p.input, null, 2).slice(0, 1500));
      lines.push("```");
    }
    if (ev.kind === "tool_result") {
      const p = ev.payload as { is_error: boolean; content_preview: string; content_full_length: number };
      lines.push(
        `### Tool result${p.is_error ? " (ERROR)" : ""} (${p.content_full_length} chars)`,
      );
      lines.push("```");
      lines.push(p.content_preview);
      if (p.content_full_length > p.content_preview.length) {
        lines.push("...(truncated)");
      }
      lines.push("```");
      lines.push("");
    }
  }
  return lines.join("\n");
}

function buildJudgePrompt(t: CapturedTranscript, rubric: RubricQuestion[]): string {
  const transcript = renderTranscript(t);
  const rubricLines = rubric.map(
    (q) => `- ${q.id} (${q.type}): ${q.question}`,
  );

  return [
    "You are evaluating an LLM's behavior against a rubric. You will be given:",
    "1. A transcript of the LLM's run (its tool calls + assistant turns).",
    "2. A list of rubric questions to answer about the run.",
    "",
    "Answer each question with:",
    "- A `value`:",
    "  - For `yes_no` questions: a boolean (true/false).",
    "  - For `score_0_10` questions: an integer 0-10.",
    "- A short `reasoning` (1-2 sentences) explaining why you scored that way, citing specific tool calls or assistant text where useful.",
    "",
    "Output STRICT JSON only — no markdown, no preamble, no code fences. The shape:",
    "```",
    "{",
    "  \"answers\": [",
    "    {\"id\": \"<rubric_id>\", \"value\": <bool or int>, \"reasoning\": \"<short string>\"}",
    "  ]",
    "}",
    "```",
    "",
    "## Rubric questions",
    rubricLines.join("\n"),
    "",
    "## Transcript",
    transcript,
  ].join("\n");
}

export async function judgeTranscript(
  transcript: CapturedTranscript,
  scenario: Scenario,
): Promise<JudgeResult> {
  if (!scenario.rubric || scenario.rubric.length === 0) {
    return {
      scenario: scenario.name,
      rep: transcript.rep,
      answers: [],
      composite_0_10: 0,
      judge_model: "(none)",
      judge_duration_ms: 0,
    };
  }
  const apiKey = loadAnthropicKey();
  const anthropic = new Anthropic({ apiKey });
  const prompt = buildJudgePrompt(transcript, scenario.rubric);
  const t0 = Date.now();
  // Opus 4.7+ has temperature deprecated; we omit it. Earlier Anthropic
  // models default to 1.0 if omitted, which is fine for a JSON-output task
  // with strict schema instructions.
  const resp = await anthropic.messages.create({
    model: DEFAULT_JUDGE_MODEL,
    max_tokens: 1500,
    system:
      "You are a strict, consistent rubric judge. Output only valid JSON " +
      "matching the requested schema. No markdown fences, no commentary.",
    messages: [{ role: "user", content: prompt }],
  });
  const durationMs = Date.now() - t0;

  const text = resp.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  // Best-effort JSON extraction — strip code fences if the model added them
  // despite instructions.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed: { answers: Array<{ id: string; value: boolean | number; reasoning: string }> };
  try {
    parsed = JSON.parse(cleaned);
  } catch (firstErr) {
    // Common Opus malformation: writes `{"key","value"...}` instead of
    // `{"id":"key","value":...}` — a missing `"id":` prefix on the rubric
    // id. Repair with a regex that detects the pattern and re-injects the
    // key. Then try again.
    const repaired = cleaned.replace(
      /\{"([a-z_][a-z0-9_]*)","value":/gi,
      '{"id":"$1","value":',
    );
    try {
      parsed = JSON.parse(repaired);
    } catch (secondErr) {
      throw new Error(
        `judge returned non-JSON output (model ${DEFAULT_JUDGE_MODEL}): ${(firstErr as Error).message}\n--- raw ---\n${text}\n--- after repair attempt ---\n${(secondErr as Error).message}`,
      );
    }
  }

  const rubricById = new Map(scenario.rubric.map((q) => [q.id, q]));
  const answers: RubricAnswer[] = parsed.answers.map((a) => {
    const q = rubricById.get(a.id);
    if (!q) {
      // Unknown id — keep it but flag with type "yes_no" + value false to
      // not break aggregation. (We don't fail the run for a stray answer.)
      return {
        id: a.id,
        question: "(unknown rubric id)",
        type: "yes_no" as const,
        value: false,
        reasoning: a.reasoning ?? "",
      };
    }
    return {
      id: a.id,
      question: q.question,
      type: q.type,
      value: q.type === "yes_no" ? Boolean(a.value) : Number(a.value),
      reasoning: a.reasoning ?? "",
    };
  });

  // Composite: each answer normalised to 0-10. yes_no: true=10, false=0.
  // score_0_10: as-is.
  let total = 0;
  let count = 0;
  for (const a of answers) {
    if (a.type === "yes_no") {
      total += a.value ? 10 : 0;
    } else {
      total += Math.max(0, Math.min(10, a.value as number));
    }
    count++;
  }
  const composite = count > 0 ? total / count : 0;

  return {
    scenario: scenario.name,
    rep: transcript.rep,
    answers,
    composite_0_10: Number(composite.toFixed(2)),
    judge_model: DEFAULT_JUDGE_MODEL,
    judge_duration_ms: durationMs,
  };
}
