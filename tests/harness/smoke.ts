// Smoke test for the self-rolled MCP harness driver.
//
// Goal: prove end-to-end that we can drive an Anthropic model against the
// real dev MCP server using only the official @modelcontextprotocol/sdk and
// the Anthropic SDK — no Claude Code CLI shell in the way.
//
// What this script does:
//   1. Loads tests/harness/.env for ANTHROPIC_API_KEY + REFLECT_MCP_URL/KEY.
//   2. Connects to the dev MCP via Streamable HTTP transport with bearer
//      auth.
//   3. Runs `initialize` (captures the briefing in `instructions`) and
//      `tools/list` (the actual tool definitions a real client sees).
//   4. Sends one scenario prompt to Anthropic Messages API with the briefing
//      as system prompt and the MCP tools translated to Anthropic tool
//      format.
//   5. Loops on `tool_use`: executes the tool against MCP, returns the
//      result, lets the model continue until `end_turn` (or a hard step
//      cap).
//   6. Dumps a structured transcript to stdout (JSON) plus a human-readable
//      summary to stderr.
//
// Exits 0 on success (model finished its turn cleanly with at least one
// tool call) or non-zero on any failure. Used as the pre-build gate before
// we invest in the full harness.

import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// -------------------------------------------------------------- env loading

function loadEnv(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return;
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
}

loadEnv("tests/harness/.env");

const ANTHROPIC_API_KEY = required("ANTHROPIC_API_KEY");
const MCP_URL = process.env.REFLECT_MCP_URL ?? "https://api-dev.reflectmemory.com/mcp";
const MCP_BEARER = required("REFLECT_MCP_BEARER");
const MODEL = process.env.HARNESS_MODEL ?? "claude-sonnet-4-5-20250929";
const PROMPT =
  process.argv.slice(2).join(" ") ||
  "Use the get_memory_briefing tool to fetch a fresh briefing, then summarise " +
    "what topics this user has memories about in one short paragraph.";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[smoke] missing required env ${name}`);
    process.exit(2);
  }
  return v;
}

// ------------------------------------------------------- transcript shapes

interface TranscriptEntry {
  step: number;
  kind: "system" | "user" | "assistant" | "tool_use" | "tool_result";
  payload: unknown;
}

const transcript: TranscriptEntry[] = [];
let stepCount = 0;
function record(kind: TranscriptEntry["kind"], payload: unknown): void {
  transcript.push({ step: ++stepCount, kind, payload });
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  console.error(`[smoke] connecting to ${MCP_URL}`);
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${MCP_BEARER}` },
    },
  });
  const mcp = new Client(
    { name: "reflect-harness-smoke", version: "0.1.0" },
    { capabilities: {} },
  );
  await mcp.connect(transport);

  // initialize() is implicit in connect(); the SDK exposes the server's
  // initialize result via mcp.getServerVersion / .getServerCapabilities and
  // the instructions via .getInstructions().
  const instructions = mcp.getInstructions() ?? "";
  console.error(
    `[smoke] connected. server=${mcp.getServerVersion()?.name} ` +
      `briefing=${instructions.length} chars`,
  );
  record("system", { instructions_preview: instructions.slice(0, 500) });

  // List tools — these are exactly what an LLM client would see.
  const toolList = await mcp.listTools();
  console.error(`[smoke] mcp tools: ${toolList.tools.length}`);
  for (const t of toolList.tools) {
    console.error(`         - ${t.name}`);
  }

  // Translate MCP tool defs to Anthropic tool format.
  const anthropicTools = toolList.tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: (t.inputSchema ?? { type: "object", properties: {} }) as {
      type: "object";
      properties?: Record<string, unknown>;
      required?: string[];
    },
  }));

  // Compose the system prompt: briefing first, then a small frame so the
  // model knows it's allowed to call tools.
  const systemPrompt = [
    instructions,
    "",
    "---",
    "You have MCP tools available for navigating and writing memories. " +
      "Use them as needed to answer the user's request.",
  ].join("\n");

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  // Conversation state — we'll mutate this as the loop runs.
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: PROMPT },
  ];
  record("user", { content: PROMPT });

  const MAX_STEPS = 8;
  let stopReason: string | null = null;
  for (let step = 0; step < MAX_STEPS; step++) {
    console.error(`[smoke] step ${step + 1} → anthropic`);
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      tools: anthropicTools,
      messages,
    });

    record("assistant", {
      stop_reason: resp.stop_reason,
      content: resp.content,
    });

    // Append assistant turn to messages.
    messages.push({ role: "assistant", content: resp.content });
    stopReason = resp.stop_reason;

    if (resp.stop_reason !== "tool_use") {
      // No more tools to run — terminal turn.
      break;
    }

    // Collect every tool_use block and run them all before next turn.
    const toolUses = resp.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const use of toolUses) {
      record("tool_use", {
        id: use.id,
        name: use.name,
        input: use.input,
      });
      console.error(`[smoke]   tool ${use.name}(${JSON.stringify(use.input)})`);

      try {
        const result = await mcp.callTool({
          name: use.name,
          arguments: use.input as Record<string, unknown>,
        });

        // MCP returns content blocks; flatten to a string for Anthropic.
        const content = (result.content as Array<{ type: string; text?: string }>)
          .map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`))
          .join("\n");

        record("tool_result", {
          tool_use_id: use.id,
          is_error: result.isError ?? false,
          content_preview: content.slice(0, 300),
          content_full_length: content.length,
        });

        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content,
          is_error: result.isError === true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        record("tool_result", {
          tool_use_id: use.id,
          is_error: true,
          error: msg,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: `Error: ${msg}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  await mcp.close();

  // Summary on stderr (humans), full transcript on stdout (machines).
  const toolCalls = transcript.filter((e) => e.kind === "tool_use").length;
  console.error("");
  console.error(`[smoke] DONE. stop_reason=${stopReason} steps=${stepCount} tool_calls=${toolCalls}`);
  if (toolCalls === 0) {
    console.error("[smoke] WARNING: model did not call any MCP tools.");
  }

  process.stdout.write(JSON.stringify(transcript, null, 2));
  process.stdout.write("\n");

  // Smoke success criteria: at least one tool call AND a clean stop.
  if (toolCalls === 0 || (stopReason !== "end_turn" && stopReason !== "stop_sequence")) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke] FATAL:", err);
  process.exit(3);
});
