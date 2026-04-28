/**
 * Anthropic agent loop for Slack messages.
 *
 * Pulled out of slack-events-handler.ts so it stays unit-testable in isolation
 * (no Slack-side concerns leak in here).
 *
 * Flow:
 *   1. Caller resolves the Reflect user, the conversation history, and the
 *      Anthropic API key for the workspace's scope.
 *   2. We build the system prompt + tool definitions, then iterate:
 *        Anthropic.messages.create -> if stop_reason === "tool_use", execute
 *        each tool, append results, loop. Cap at MAX_AGENT_STEPS.
 *   3. Return the assistant's final text + the new history slice the caller
 *      should persist (just user-text + assistant-text, no tool plumbing).
 */

import Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";

import { buildAgentTools } from "./slack-agent-tools.js";
import type { StoredMessage } from "./slack-conversation-service.js";

// Latest Sonnet alias as of 2026-04. Override via RM_SLACK_AGENT_MODEL.
// (There's no claude-sonnet-4-7 yet — only Opus jumped to 4-7. Verified
//  via Anthropic /v1/models on 2026-04-28.)
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 2048;
const MAX_AGENT_STEPS = 6;

export interface AgentRunOptions {
  apiKey: string;
  db: Database.Database;
  reflectUserId: string;
  isDirectMessage: boolean;
  email: string;
  realName: string | null;
  newUserMessage: string;
  history: StoredMessage[];
  /** Override the model (env: RM_SLACK_AGENT_MODEL). */
  model?: string;
  /** Inject a stub Anthropic client for tests. */
  anthropicClient?: Anthropic;
}

export interface AgentRunResult {
  replyText: string;
  updatedHistory: StoredMessage[];
  toolCallCount: number;
  steps: number;
  stopReason: string;
}

function buildSystemPrompt(args: {
  isDirectMessage: boolean;
  email: string;
  realName: string | null;
}): string {
  const today = new Date().toISOString().slice(0, 10);
  const speakerLine = args.realName
    ? `You are talking to: ${args.realName} (${args.email}).`
    : `You are talking to: ${args.email}.`;
  const modeLine = args.isDirectMessage
    ? "Mode: DM. Replies are private — only the requester sees them."
    : "Mode: channel. Replies are visible to everyone in the channel.";

  return [
    "You are Reflect Memory in Slack — an AI agent connected to the user's Reflect Memory account.",
    "",
    speakerLine,
    modeLine,
    "",
    "You have tools to read, search, and (carefully) write the user's personal memories AND memories shared with their team. You operate as that user — what they can see, you can see; you cannot read other users' personal memories.",
    "",
    "Reading guidelines:",
    "- Be concise. Slack messages should be short — usually under ~1500 characters. If a list is long, summarise and offer to dig into specifics on request.",
    "- When you need information, prefer a tool call over guessing. For open-ended questions (\"what's going on\", \"summarise X\", \"what did I work on this week\"), call get_memory_briefing first — it gives you the topic clusters, active tags, and open threads in one shot.",
    "- When citing a specific memory, include its title and (in parentheses) its short id (first 8 chars of the UUID).",
    "- If you can't find something, say so plainly. Don't invent.",
    "",
    "Writing guidelines:",
    "- write_memory creates a personal memory by default. Set share_with_team=true ONLY when the user explicitly asks (\"write a team note...\", \"share this with the team\"). When unsure, default to personal.",
    "- For follow-ups on an existing memory or thread, use write_child_memory — never use update_memory to add a status update on a teammate's memory (that destroys their text).",
    "- update_memory does a wholesale title/content/tags REPLACE — pass the COMPLETE new values, not a diff. Only use on memories the user authored.",
    "- Match the user's existing tagging conventions. Call get_memory_briefing if you don't already know them (it lists active tags + detected conventions).",
    "",
    "Destructive actions (delete_memory):",
    "- ALWAYS first call delete_memory with confirm=false to get the preview.",
    "- Show the preview (title + a snippet) in your reply and ask the user to reply 'yes' to confirm.",
    "- ONLY after they have explicitly typed 'yes' (or equivalent affirmative) in this conversation, call delete_memory again with confirm=true.",
    "- If they say no, say something else, or change topic — do not delete.",
    "",
    "Markdown: Slack supports *bold* (single asterisks), _italic_ (single underscores), `code`, and bullet lists. Don't use **double** asterisks for bold.",
    "",
    `Today's date: ${today}.`,
  ].join("\n");
}

/**
 * Strip "<@U0BOTID>" mentions from the user's message text so the model isn't
 * distracted by Slack's machine-readable mention syntax.
 */
function cleanSlackMessageText(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

/**
 * Runs one agent turn. Throws if the Anthropic API call fails (caller should
 * wrap in try/catch and post a fallback to Slack).
 */
export async function runSlackAgentTurn(
  options: AgentRunOptions,
): Promise<AgentRunResult> {
  const anthropic =
    options.anthropicClient ?? new Anthropic({ apiKey: options.apiKey });
  const model =
    options.model ?? process.env.RM_SLACK_AGENT_MODEL ?? DEFAULT_MODEL;
  const tools = buildAgentTools({
    db: options.db,
    reflectUserId: options.reflectUserId,
  });
  const cleanedUserText = cleanSlackMessageText(options.newUserMessage);

  const system = buildSystemPrompt({
    isDirectMessage: options.isDirectMessage,
    email: options.email,
    realName: options.realName,
  });

  // Working messages array — includes tool turns; the persisted history
  // (returned at the end) only carries text turns.
  const messages: Anthropic.MessageParam[] = [
    ...options.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: cleanedUserText },
  ];

  let toolCallCount = 0;
  let steps = 0;
  let resp: Anthropic.Message = await anthropic.messages.create({
    model,
    max_tokens: DEFAULT_MAX_TOKENS,
    system,
    tools: tools.definitions.map((d) => ({
      name: d.name,
      description: d.description,
      input_schema: d.input_schema,
    })),
    messages,
  });

  while (resp.stop_reason === "tool_use" && steps < MAX_AGENT_STEPS) {
    steps++;
    const toolUseBlocks = resp.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUseBlocks.map(async (block) => {
        toolCallCount++;
        const result = await tools.execute(
          block.name,
          (block.input as Record<string, unknown>) ?? {},
        );
        return {
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: result,
        };
      }),
    );

    messages.push({ role: "assistant", content: resp.content });
    messages.push({ role: "user", content: toolResults });

    resp = await anthropic.messages.create({
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      system,
      tools: tools.definitions.map((d) => ({
        name: d.name,
        description: d.description,
        input_schema: d.input_schema,
      })),
      messages,
    });
  }

  const replyText = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();

  const finalText =
    replyText.length > 0
      ? replyText
      : "I couldn't produce a reply this turn — try rephrasing?";

  const updatedHistory: StoredMessage[] = [
    ...options.history,
    { role: "user", content: cleanedUserText },
    { role: "assistant", content: finalText },
  ];

  return {
    replyText: finalText,
    updatedHistory,
    toolCallCount,
    steps,
    stopReason: resp.stop_reason ?? "unknown",
  };
}
