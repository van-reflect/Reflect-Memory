// Reflect Memory -- Chat Gateway
// Multi-provider chat with Reflect Memory tool calling.
// Supports OpenAI-compatible (GPT, Perplexity, Grok), Anthropic (Claude), Google (Gemini).
// Tools are injected server-side. Models read/write memories mid-conversation.

import type Database from "better-sqlite3";
import {
  createMemory,
  listMemories,
  type MemoryEntry,
  type CreateMemoryInput,
} from "./memory-service.js";

// =============================================================================
// Types
// =============================================================================

export type Provider = "openai" | "anthropic" | "google";

export interface ChatModel {
  id: string;
  label: string;
  provider: Provider;
  apiModel: string;
}

export interface ProviderConfig {
  openaiKey?: string;
  openaiBaseUrl?: string;
  anthropicKey?: string;
  googleKey?: string;
  perplexityKey?: string;
  xaiKey?: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ToolExecution {
  tool: string;
  input: Record<string, unknown>;
  result: unknown;
}

export interface ChatResponse {
  response: string;
  model: string;
  tool_executions: ToolExecution[];
}

// =============================================================================
// Available models
// =============================================================================

export const AVAILABLE_MODELS: ChatModel[] = [
  { id: "gpt-4o", label: "GPT-4o", provider: "openai", apiModel: "gpt-4o" },
  { id: "gpt-4o-mini", label: "GPT-4o Mini", provider: "openai", apiModel: "gpt-4o-mini" },
  { id: "claude-sonnet-4", label: "Claude Sonnet 4", provider: "anthropic", apiModel: "claude-sonnet-4-20250514" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", provider: "google", apiModel: "gemini-2.0-flash" },
  { id: "perplexity-sonar", label: "Perplexity Sonar", provider: "openai", apiModel: "sonar" },
  { id: "grok-3-mini", label: "Grok 3 Mini", provider: "openai", apiModel: "grok-3-mini" },
];

// =============================================================================
// Reflect Memory tool definitions (OpenAI format)
// =============================================================================

const OPENAI_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_memories",
      description:
        "Read the user's memories. Use filter 'all' for everything, 'tags' to filter by tags, or 'search' to search by keyword. Always check memories before answering questions about the user.",
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            enum: ["all", "tags", "search"],
            description: "How to filter memories",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags to filter by (when filter is 'tags')",
          },
          term: {
            type: "string",
            description: "Search term (when filter is 'search')",
          },
        },
        required: ["filter"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_memory",
      description:
        "Write a new memory for the user. Use this when the user shares something worth remembering: preferences, goals, project updates, decisions, or context they want persisted across conversations.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short descriptive title for the memory",
          },
          content: {
            type: "string",
            description: "Full content of the memory",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags for categorization",
          },
        },
        required: ["title", "content", "tags"],
      },
    },
  },
];

// =============================================================================
// Tool execution
// =============================================================================

function executeToolCall(
  db: Database.Database,
  userId: string,
  toolName: string,
  args: Record<string, unknown>,
  modelId: string,
): unknown {
  switch (toolName) {
    case "read_memories": {
      const filterType = args.filter as string;
      const filter =
        filterType === "tags" && Array.isArray(args.tags)
          ? { by: "tags" as const, tags: args.tags as string[] }
          : filterType === "search" && typeof args.term === "string"
            ? { by: "search" as const, term: args.term }
            : { by: "all" as const };
      const memories = listMemories(db, userId, filter, null, { limit: 10 });
      return memories.map((m) => ({
        id: m.id,
        title: m.title,
        content: m.content,
        tags: m.tags,
        origin: m.origin,
        created_at: m.created_at,
      }));
    }

    case "write_memory": {
      const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
      const origin = model?.id.startsWith("gpt")
        ? "chatgpt"
        : model?.id.startsWith("claude")
          ? "claude"
          : model?.id.startsWith("gemini")
            ? "gemini"
            : model?.id.startsWith("perplexity") || model?.id.startsWith("sonar")
              ? "perplexity"
              : model?.id.startsWith("grok")
                ? "grok"
                : "dashboard";

      const input: CreateMemoryInput = {
        title: args.title as string,
        content: args.content as string,
        tags: (args.tags as string[]) ?? [],
        origin,
        allowed_vendors: ["*"],
      };
      const memory = createMemory(db, userId, input);
      return { id: memory.id, title: memory.title, created_at: memory.created_at };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// =============================================================================
// Provider: OpenAI-compatible (GPT, Perplexity, Grok)
// =============================================================================

function getOpenAIBaseUrl(modelId: string, config: ProviderConfig): string {
  if (modelId.startsWith("sonar") || modelId.startsWith("perplexity"))
    return "https://api.perplexity.ai";
  if (modelId.startsWith("grok"))
    return "https://api.x.ai/v1";
  return config.openaiBaseUrl ?? "https://api.openai.com/v1";
}

function getOpenAIKey(modelId: string, config: ProviderConfig): string {
  if (modelId.startsWith("sonar") || modelId.startsWith("perplexity"))
    return config.perplexityKey ?? "";
  if (modelId.startsWith("grok"))
    return config.xaiKey ?? "";
  return config.openaiKey ?? "";
}

async function chatOpenAI(
  model: ChatModel,
  messages: ChatMessage[],
  db: Database.Database,
  userId: string,
  config: ProviderConfig,
  systemPrompt: string,
): Promise<ChatResponse> {
  const baseUrl = getOpenAIBaseUrl(model.apiModel, config).replace(/\/+$/, "");
  const apiKey = getOpenAIKey(model.apiModel, config);
  if (!apiKey) throw new Error(`No API key configured for ${model.label}`);

  const apiMessages: Array<{ role: string; content?: string; tool_call_id?: string }> = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const toolExecutions: ToolExecution[] = [];
  const MAX_TOOL_ROUNDS = 5;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model.apiModel,
        messages: apiMessages,
        tools: OPENAI_TOOLS,
        temperature: 0.7,
        max_tokens: 2048,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[openai] ${model.label} API error ${res.status}: ${body}`);
      throw new Error(`${model.label} API error ${res.status}`);
    }

    const data = (await res.json()) as {
      choices: Array<{
        message: {
          role: string;
          content?: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
    };

    const choice = data.choices[0];
    if (!choice) throw new Error("No response from model");

    if (!choice.message.tool_calls?.length) {
      return {
        response: choice.message.content ?? "",
        model: model.id,
        tool_executions: toolExecutions,
      };
    }

    apiMessages.push({
      role: "assistant",
      content: choice.message.content ?? undefined,
      ...({ tool_calls: choice.message.tool_calls } as Record<string, unknown>),
    });

    for (const tc of choice.message.tool_calls) {
      let args: Record<string, unknown>;
      try {
        const parsed = JSON.parse(tc.function.arguments);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("Expected object");
        }
        args = parsed as Record<string, unknown>;
      } catch {
        args = {};
      }
      const result = executeToolCall(db, userId, tc.function.name, args, model.id);
      toolExecutions.push({ tool: tc.function.name, input: args, result });

      apiMessages.push({
        role: "tool",
        content: JSON.stringify(result),
        tool_call_id: tc.id,
      } as typeof apiMessages[number]);
    }
  }

  return {
    response: "I used too many tool calls. Please try a more specific question.",
    model: model.id,
    tool_executions: toolExecutions,
  };
}

// =============================================================================
// Provider: Anthropic (Claude)
// =============================================================================

const ANTHROPIC_TOOLS = OPENAI_TOOLS.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters,
}));

async function chatAnthropic(
  model: ChatModel,
  messages: ChatMessage[],
  db: Database.Database,
  userId: string,
  config: ProviderConfig,
  systemPrompt: string,
): Promise<ChatResponse> {
  const apiKey = config.anthropicKey ?? "";
  if (!apiKey) throw new Error("No Anthropic API key configured");

  const apiMessages = messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const toolExecutions: ToolExecution[] = [];
  const MAX_TOOL_ROUNDS = 5;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model.apiModel,
        max_tokens: 2048,
        system: systemPrompt,
        messages: apiMessages,
        tools: ANTHROPIC_TOOLS,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[anthropic] Claude API error ${res.status}: ${body}`);
      throw new Error(`Claude API error ${res.status}`);
    }

    const data = (await res.json()) as {
      content: Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      >;
      stop_reason: string;
    };

    const textBlocks = data.content.filter((b) => b.type === "text") as Array<{ type: "text"; text: string }>;
    const toolBlocks = data.content.filter((b) => b.type === "tool_use") as Array<{
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }>;

    if (toolBlocks.length === 0) {
      return {
        response: textBlocks.map((b) => b.text).join("\n"),
        model: model.id,
        tool_executions: toolExecutions,
      };
    }

    apiMessages.push({
      role: "assistant",
      content: data.content as unknown as string,
    });

    const toolResults: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string;
    }> = [];

    for (const tb of toolBlocks) {
      const result = executeToolCall(db, userId, tb.name, tb.input, model.id);
      toolExecutions.push({ tool: tb.name, input: tb.input, result });
      toolResults.push({
        type: "tool_result",
        tool_use_id: tb.id,
        content: JSON.stringify(result),
      });
    }

    apiMessages.push({
      role: "user",
      content: toolResults as unknown as string,
    });
  }

  return {
    response: "I used too many tool calls. Please try a more specific question.",
    model: model.id,
    tool_executions: toolExecutions,
  };
}

// =============================================================================
// Provider: Google (Gemini)
// =============================================================================

const GEMINI_TOOLS = [
  {
    functionDeclarations: OPENAI_TOOLS.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    })),
  },
];

async function chatGoogle(
  model: ChatModel,
  messages: ChatMessage[],
  db: Database.Database,
  userId: string,
  config: ProviderConfig,
  systemPrompt: string,
): Promise<ChatResponse> {
  const apiKey = config.googleKey ?? "";
  if (!apiKey) throw new Error("No Google AI API key configured");

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const toolExecutions: ToolExecution[] = [];
  const MAX_TOOL_ROUNDS = 5;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model.apiModel}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
          tools: GEMINI_TOOLS,
        }),
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[gemini] API error ${res.status}: ${body}`);
      throw new Error(`Gemini API error ${res.status}`);
    }

    const data = (await res.json()) as {
      candidates: Array<{
        content: {
          parts: Array<
            | { text: string }
            | { functionCall: { name: string; args: Record<string, unknown> } }
          >;
        };
      }>;
    };

    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error("No response from Gemini");

    const parts = candidate.content.parts;
    const textParts = parts.filter((p) => "text" in p) as Array<{ text: string }>;
    const fnParts = parts.filter((p) => "functionCall" in p) as Array<{
      functionCall: { name: string; args: Record<string, unknown> };
    }>;

    if (fnParts.length === 0) {
      return {
        response: textParts.map((p) => p.text).join("\n"),
        model: model.id,
        tool_executions: toolExecutions,
      };
    }

    contents.push({ role: "model", parts: candidate.content.parts as Array<{ text: string }> });

    const fnResponses: Array<{ functionResponse: { name: string; response: unknown } }> = [];
    for (const fp of fnParts) {
      const result = executeToolCall(db, userId, fp.functionCall.name, fp.functionCall.args, model.id);
      toolExecutions.push({ tool: fp.functionCall.name, input: fp.functionCall.args, result });
      fnResponses.push({
        functionResponse: { name: fp.functionCall.name, response: result },
      });
    }

    contents.push({ role: "user", parts: fnResponses as unknown as Array<{ text: string }> });
  }

  return {
    response: "I used too many tool calls. Please try a more specific question.",
    model: model.id,
    tool_executions: toolExecutions,
  };
}

// =============================================================================
// Main chat function
// =============================================================================

const CHAT_SYSTEM_PROMPT = `You are a helpful assistant with access to the user's Reflect Memory -- a cross-model memory system that persists context across AI tools.

When the user asks a question, check their memories first using read_memories to provide context-aware answers.
When the user shares something worth remembering (preferences, goals, project updates, decisions), use write_memory to save it.
Always be transparent about what you read from or wrote to memory.
Keep memory titles concise and content detailed.`;

export async function chat(
  modelId: string,
  messages: ChatMessage[],
  db: Database.Database,
  userId: string,
  config: ProviderConfig,
): Promise<ChatResponse> {
  const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
  if (!model) throw new Error(`Unknown model: ${modelId}. Available: ${AVAILABLE_MODELS.map((m) => m.id).join(", ")}`);

  switch (model.provider) {
    case "openai":
      return chatOpenAI(model, messages, db, userId, config, CHAT_SYSTEM_PROMPT);
    case "anthropic":
      return chatAnthropic(model, messages, db, userId, config, CHAT_SYSTEM_PROMPT);
    case "google":
      return chatGoogle(model, messages, db, userId, config, CHAT_SYSTEM_PROMPT);
    default: {
      const _: never = model.provider;
      throw new Error(`Unsupported provider: ${_}`);
    }
  }
}
