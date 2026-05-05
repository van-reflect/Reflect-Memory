// Scenario types for the harness.
//
// Each Scenario is a structured task: who's running it, what prompt they're
// given, and what we expect the LLM to do. Hard assertions are TypeScript
// predicates over the captured transcript so they can express things YAML
// couldn't (e.g. "the second tool call's `parent_memory_id` arg must equal
// the seeded id of fixture `auth-bug-root`").
//
// Rubric questions are plain text — the judge LLM (B5) answers them
// against the transcript with strict JSON output.

import type { FixtureAuthor } from "../fixtures/types.js";

export type ToolName = string;

export interface ToolUseRecord {
  step: number;
  name: ToolName;
  input: Record<string, unknown>;
  result?: {
    is_error: boolean;
    content_preview: string;
    content_full_length: number;
  };
}

export interface ScenarioContext {
  /** ref→id from .seeded.json, exposed to assertions. */
  refToId: Record<string, string>;
  /** harness-tamer + harness-van user IDs, in case an assertion needs them. */
  userIds: { tamer: string; van: string };
  /** harness team id. */
  orgId: string;
}

export interface CapturedTranscript {
  scenario: string;
  rep: number;
  author: FixtureAuthor;
  prompt: string;
  toolUses: ToolUseRecord[];
  finalAssistantText: string;
  stopReason: string | null;
  steps: number;
  durationMs: number;
  /** Full structured log for the judge LLM and offline inspection. */
  events: Array<{
    step: number;
    kind: "system" | "user" | "assistant" | "tool_use" | "tool_result";
    payload: unknown;
  }>;
}

export interface AssertionResult {
  name: string;
  pass: boolean;
  detail?: string;
}

export type Assertion = (
  transcript: CapturedTranscript,
  ctx: ScenarioContext,
) => AssertionResult;

export interface RubricQuestion {
  /** Short id used to key answers in the result. */
  id: string;
  /** Plain-English question for the judge LLM. */
  question: string;
  /** "yes_no" → judge returns boolean; "score_0_10" → judge returns 0-10 int. */
  type: "yes_no" | "score_0_10";
}

export interface Scenario {
  name: string;
  description: string;
  /** Which harness user runs this scenario. */
  author: FixtureAuthor;
  /** The user prompt sent to the LLM. */
  prompt: string;
  /** Hard assertions over the captured transcript. */
  assertions: Assertion[];
  /** Rubric questions for the judge LLM. */
  rubric?: RubricQuestion[];
  /** Cap on agentic tool-use steps. Default 8. */
  maxSteps?: number;
}

// ---------------------------------------------------------- assertion helpers

/** First tool_use whose name matches. */
export function firstToolCall(
  t: CapturedTranscript,
  name: string,
): ToolUseRecord | undefined {
  return t.toolUses.find((u) => u.name === name);
}

/** Has any tool_use with this name? */
export function calledTool(t: CapturedTranscript, name: string): boolean {
  return t.toolUses.some((u) => u.name === name);
}

/** Names of all tool calls in order. */
export function toolNames(t: CapturedTranscript): string[] {
  return t.toolUses.map((u) => u.name);
}
