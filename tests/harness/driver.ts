// Harness driver: runs one scenario one time, returns a CapturedTranscript.
//
// Connects to the dev MCP server using the harness user's API key, captures
// the briefing on initialize, drives Anthropic Messages API with the
// briefing as system prompt and MCP tools as Anthropic tools. Loops on
// tool_use until the model finishes its turn (or maxSteps is hit), records
// every assistant turn / tool_use / tool_result as a structured event.
//
// This module is the I/O layer. Assertions and rubric judging happen
// separately in judge.ts (B5). The runner (B6) orchestrates many
// (scenario, rep) pairs.

import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Scenario } from "./scenarios/types.js";
import type { CapturedTranscript, ToolUseRecord } from "./scenarios/types.js";
import type { FixtureAuthor } from "./fixtures/types.js";

interface HarnessConfig {
  run_id: string;
  team_id: string;
  mcp_url: string;
  users: {
    tamer: { id: string; api_key: string };
    van: { id: string; api_key: string };
  };
}

let CACHED_CONFIG: HarnessConfig | null = null;
function getConfig(): HarnessConfig {
  if (CACHED_CONFIG) return CACHED_CONFIG;
  CACHED_CONFIG = JSON.parse(
    readFileSync("tests/harness/.harness-config.json", "utf-8"),
  ) as HarnessConfig;
  return CACHED_CONFIG;
}

function loadAnthropicKey(): string {
  // .env loader (tiny — same shape as smoke.ts).
  const text = (() => {
    try {
      return readFileSync("tests/harness/.env", "utf-8");
    } catch {
      return "";
    }
  })();
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
  if (!key) throw new Error("ANTHROPIC_API_KEY not set (check tests/harness/.env)");
  return key;
}

const DEFAULT_MODEL =
  process.env.HARNESS_MODEL ?? "claude-sonnet-4-5-20250929";
const DEFAULT_MAX_TOKENS = 1500;
const SYSTEM_FRAME =
  "\n\n---\n" +
  "You have MCP tools available for navigating and writing memories. " +
  "Use them as needed to fulfill the user's request.";

export interface RunOptions {
  /** Override default Anthropic model. */
  model?: string;
  /** Inject a custom rep id into the transcript (defaults to 0). */
  rep?: number;
  /** Max steps cap (overrides the scenario's). */
  maxSteps?: number;
}

export async function runScenario(
  scenario: Scenario,
  opts: RunOptions = {},
): Promise<CapturedTranscript> {
  const config = getConfig();
  const apiKey = loadAnthropicKey();
  const author: FixtureAuthor = scenario.author;
  const userKey =
    author === "tamer" ? config.users.tamer.api_key : config.users.van.api_key;

  const transport = new StreamableHTTPClientTransport(new URL(config.mcp_url), {
    requestInit: {
      headers: { Authorization: `Bearer ${userKey}` },
    },
  });
  const mcp = new Client(
    { name: "reflect-harness-driver", version: "0.1.0" },
    { capabilities: {} },
  );
  await mcp.connect(transport);

  const instructions = mcp.getInstructions() ?? "";
  const toolList = await mcp.listTools();
  const anthropicTools = toolList.tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: (t.inputSchema ?? { type: "object", properties: {} }) as {
      type: "object";
      properties?: Record<string, unknown>;
      required?: string[];
    },
  }));

  const systemPrompt = instructions + SYSTEM_FRAME;
  const anthropic = new Anthropic({ apiKey });

  const events: CapturedTranscript["events"] = [];
  const toolUses: ToolUseRecord[] = [];
  let stepCount = 0;
  function record(
    kind: CapturedTranscript["events"][number]["kind"],
    payload: unknown,
  ): number {
    const step = ++stepCount;
    events.push({ step, kind, payload });
    return step;
  }

  record("system", { instructions_length: instructions.length });
  record("user", { content: scenario.prompt });

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: scenario.prompt },
  ];

  // Default 12 steps. With the v2 graph tools (get_graph_around,
  // get_topic_cluster, etc.) the model often does richer exploration,
  // and 8 steps wasn't always enough for it to converge on a final
  // assistant turn (saw this in cluster-recall scenario at iter 5).
  const maxSteps = opts.maxSteps ?? scenario.maxSteps ?? 12;
  let stopReason: string | null = null;
  let finalAssistantText = "";
  const t0 = Date.now();

  for (let i = 0; i < maxSteps; i++) {
    const resp = await anthropic.messages.create({
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: DEFAULT_MAX_TOKENS,
      system: systemPrompt,
      tools: anthropicTools,
      messages,
    });
    record("assistant", { stop_reason: resp.stop_reason, content: resp.content });
    messages.push({ role: "assistant", content: resp.content });
    stopReason = resp.stop_reason;

    // Capture any text blocks for finalAssistantText (last non-empty wins).
    const textBlocks = resp.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (textBlocks.trim().length > 0) finalAssistantText = textBlocks;

    if (resp.stop_reason !== "tool_use") break;

    const toolUseBlocks = resp.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );
    const toolResultBlocks: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const use of toolUseBlocks) {
      const callStep = record("tool_use", {
        id: use.id,
        name: use.name,
        input: use.input,
      });
      const trec: ToolUseRecord = {
        step: callStep,
        name: use.name,
        input: (use.input ?? {}) as Record<string, unknown>,
      };
      try {
        const result = await mcp.callTool({
          name: use.name,
          arguments: use.input as Record<string, unknown>,
        });
        const content = (result.content as Array<{ type: string; text?: string }>)
          .map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`))
          .join("\n");
        const isError = result.isError === true;
        record("tool_result", {
          tool_use_id: use.id,
          is_error: isError,
          content_preview: content.slice(0, 500),
          content_full_length: content.length,
        });
        trec.result = {
          is_error: isError,
          content_preview: content.slice(0, 500),
          content_full_length: content.length,
        };
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: use.id,
          content,
          is_error: isError,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        record("tool_result", {
          tool_use_id: use.id,
          is_error: true,
          content_preview: `Error: ${msg}`,
          content_full_length: msg.length,
        });
        trec.result = {
          is_error: true,
          content_preview: `Error: ${msg}`,
          content_full_length: msg.length,
        };
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: `Error: ${msg}`,
          is_error: true,
        });
      }
      toolUses.push(trec);
    }

    messages.push({ role: "user", content: toolResultBlocks });
  }

  await mcp.close();

  return {
    scenario: scenario.name,
    rep: opts.rep ?? 0,
    author,
    prompt: scenario.prompt,
    toolUses,
    finalAssistantText,
    stopReason,
    steps: stepCount,
    durationMs: Date.now() - t0,
    events,
  };
}
