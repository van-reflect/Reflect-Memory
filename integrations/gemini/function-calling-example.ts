// Gemini API function-calling example for Reflect Memory.
// Demonstrates how to give a Gemini model native read/write access to memories
// via function declarations that map to the Reflect Memory agent API.
//
// Usage:
//   GOOGLE_AI_API_KEY=<key> RM_AGENT_KEY_GEMINI=<key> npx tsx function-calling-example.ts

import {
  GoogleGenerativeAI,
  FunctionDeclarationSchemaType,
  type FunctionDeclaration,
  type FunctionCall,
} from "@google/generative-ai";

const API_BASE =
  process.env.REFLECT_MEMORY_API_URL || "https://api.reflectmemory.com";
const AGENT_KEY = process.env.RM_AGENT_KEY_GEMINI;
const GOOGLE_KEY = process.env.GOOGLE_AI_API_KEY;

if (!AGENT_KEY) {
  console.error("Missing RM_AGENT_KEY_GEMINI");
  process.exit(1);
}
if (!GOOGLE_KEY) {
  console.error("Missing GOOGLE_AI_API_KEY");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Reflect Memory API helpers
// ---------------------------------------------------------------------------

async function fetchApi(path: string, options: RequestInit = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${AGENT_KEY}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Function declarations (Gemini function-calling schema)
// ---------------------------------------------------------------------------

const memoryFunctions: FunctionDeclaration[] = [
  {
    name: "get_latest_memory",
    description:
      "Get the single most recent memory from Reflect Memory. Optionally filter by tag.",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        tag: {
          type: FunctionDeclarationSchemaType.STRING,
          description: "Optional tag to filter by",
        },
      },
    },
  },
  {
    name: "get_memory_by_id",
    description: "Retrieve a single memory by its UUID.",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        id: {
          type: FunctionDeclarationSchemaType.STRING,
          description: "The memory UUID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "browse_memories",
    description:
      "Browse memory summaries (title, tags, dates -- no full content). Use to discover what exists before reading specific ones.",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        limit: {
          type: FunctionDeclarationSchemaType.NUMBER,
          description: "Max results (default 50, max 200)",
        },
        offset: {
          type: FunctionDeclarationSchemaType.NUMBER,
          description: "Skip this many results (default 0)",
        },
      },
    },
  },
  {
    name: "get_memories_by_tag",
    description:
      "Get full-body memories filtered by tags. Returns memories matching ANY of the given tags.",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        tags: {
          type: FunctionDeclarationSchemaType.ARRAY,
          items: { type: FunctionDeclarationSchemaType.STRING },
          description: "Tags to filter by",
        },
        limit: {
          type: FunctionDeclarationSchemaType.NUMBER,
          description: "Max results (default 20)",
        },
        offset: {
          type: FunctionDeclarationSchemaType.NUMBER,
          description: "Skip this many results (default 0)",
        },
      },
      required: ["tags"],
    },
  },
  {
    name: "write_memory",
    description: "Create a new memory entry in Reflect Memory.",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: {
        title: {
          type: FunctionDeclarationSchemaType.STRING,
          description: "Short title for the memory",
        },
        content: {
          type: FunctionDeclarationSchemaType.STRING,
          description: "The memory content",
        },
        tags: {
          type: FunctionDeclarationSchemaType.ARRAY,
          items: { type: FunctionDeclarationSchemaType.STRING },
          description: "Tags for categorization",
        },
        allowed_vendors: {
          type: FunctionDeclarationSchemaType.ARRAY,
          items: { type: FunctionDeclarationSchemaType.STRING },
          description:
            'Which vendors can see this memory. Use ["*"] for all.',
        },
      },
      required: ["title", "content"],
    },
  },
];

// ---------------------------------------------------------------------------
// Function execution -- routes Gemini function calls to the REST API
// ---------------------------------------------------------------------------

async function executeFunction(call: FunctionCall): Promise<unknown> {
  const { name, args } = call;

  switch (name) {
    case "get_latest_memory": {
      const params = new URLSearchParams();
      if (args.tag) params.set("tag", args.tag as string);
      const qs = params.toString();
      return fetchApi(`/agent/memories/latest${qs ? `?${qs}` : ""}`);
    }

    case "get_memory_by_id":
      return fetchApi(`/agent/memories/${encodeURIComponent(args.id as string)}`);

    case "browse_memories":
      return fetchApi("/agent/memories/browse", {
        method: "POST",
        body: JSON.stringify({
          limit: args.limit ?? 50,
          offset: args.offset ?? 0,
          filter: { by: "all" },
        }),
      });

    case "get_memories_by_tag":
      return fetchApi("/agent/memories/by-tag", {
        method: "POST",
        body: JSON.stringify({
          tags: args.tags,
          limit: args.limit ?? 20,
          offset: args.offset ?? 0,
        }),
      });

    case "write_memory":
      return fetchApi("/agent/memories", {
        method: "POST",
        body: JSON.stringify({
          title: args.title,
          content: args.content,
          tags: args.tags ?? [],
          allowed_vendors: args.allowed_vendors ?? ["*"],
        }),
      });

    default:
      throw new Error(`Unknown function: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Main -- interactive loop with Gemini + function calling
// ---------------------------------------------------------------------------

async function main() {
  const genAI = new GoogleGenerativeAI(GOOGLE_KEY!);

  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    tools: [{ functionDeclarations: memoryFunctions }],
    systemInstruction:
      "You are connected to Reflect Memory, a cross-model memory system. " +
      "Use the available functions to read and write memories. " +
      "When the user asks about memories, browse or search first, then read specific ones. " +
      "When asked to remember something, write it to memory with appropriate tags.",
  });

  const chat = model.startChat();

  const userPrompt =
    process.argv[2] ||
    "Browse my recent memories and give me a summary of what's there.";

  console.log(`\nUser: ${userPrompt}\n`);

  let response = await chat.sendMessage(userPrompt);
  let result = response.response;

  // Function-calling loop: keep going until the model stops requesting functions
  while (true) {
    const calls = result.functionCalls();
    if (!calls || calls.length === 0) break;

    const functionResponses = [];
    for (const call of calls) {
      console.log(`  [function] ${call.name}(${JSON.stringify(call.args)})`);
      try {
        const data = await executeFunction(call);
        functionResponses.push({
          functionResponse: { name: call.name, response: data },
        });
      } catch (err) {
        functionResponses.push({
          functionResponse: {
            name: call.name,
            response: { error: String(err) },
          },
        });
      }
    }

    response = await chat.sendMessage(functionResponses);
    result = response.response;
  }

  console.log(`Gemini: ${result.text()}\n`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
