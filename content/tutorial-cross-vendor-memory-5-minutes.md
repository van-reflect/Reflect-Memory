# Build a Cross-Vendor AI Memory in 5 Minutes

What if your AI assistants could remember the same things? No more repeating your preferences to ChatGPT, Claude, and Cursor. In this tutorial, you'll build a shared memory that works across all three in about five minutes.

Reflect Memory is an API that gives your AI tools a persistent, shared brain. Write once from any client, read from any other. Whether you're in a Cursor chat, a ChatGPT session, or a Claude conversation, the same memories are available.

## What You'll Build

A single memory store that:

- Stores your preferences, context, and notes once
- Is readable and writable from ChatGPT (Custom GPT), Claude (via API or MCP), and Cursor (via MCP)
- Uses the Reflect Memory API and SDK

You'll use curl, the TypeScript SDK, and the MCP server. No database setup, no backend code. Just API calls.

---

## Step 1: Get an API Key

1. Go to [reflectmemory.com](https://reflectmemory.com)
2. Sign up for a free account
3. Copy your API key from the dashboard

Keep this key handy. You'll use it in the next steps.

---

## Step 2: Write Your First Memory with curl

Open a terminal and run:

```bash
curl -X POST https://api.reflectmemory.com/memories \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"My coding preferences","content":"I prefer TypeScript, functional style, no classes","tags":["preferences","coding"]}'
```

Replace `YOUR_KEY` with your actual API key. You should get a JSON response confirming the memory was created. This proves the API works and that you can write from the command line.

---

## Step 3: Install the SDK and Write from a Script

Create a new Node.js project (or use an existing one):

```bash
npm init -y
npm install reflect-memory-sdk
```

Create `write-memory.js`:

```javascript
const { ReflectMemoryClient } = require("reflect-memory-sdk");

const client = new ReflectMemoryClient({
  apiKey: process.env.REFLECT_API_KEY,
  baseUrl: "https://api.reflectmemory.com",
});

async function main() {
  await client.write({
    title: "Project context",
    content: "Working on a React app with Vite. Use Tailwind for styling.",
    tags: ["project", "react"],
  });
  console.log("Memory written.");
}

main();
```

Run it:

```bash
export REFLECT_API_KEY=your-key-here
node write-memory.js
```

The SDK has zero dependencies and works on Node 18+. You can also use it from TypeScript. The `write` method accepts `title`, `content`, and `tags`. Tags are optional but useful for filtering later.

---

## Step 4: Connect Cursor via MCP

To let Cursor read and write your memory, add the Reflect Memory MCP server. In Cursor, open **Settings > MCP** and add:

```json
{
  "reflect-memory": {
    "command": "npx",
    "args": ["reflect-memory-mcp"],
    "env": {
      "REFLECT_API_KEY": "your-key-here",
      "REFLECT_BASE_URL": "https://api.reflectmemory.com"
    }
  }
}
```

Restart Cursor. The AI can now access your memories during chats. When you ask Cursor about your preferences or project context, it can pull from Reflect Memory instead of relying only on the current conversation.

---

## Step 5: Verify Cross-Vendor Access

Read the memory from a different tool to confirm it's shared.

**Option A: Read with the SDK**

```javascript
const memories = await client.getLatest({ limit: 5 });
console.log(memories);
```

**Option B: Search by tag**

```javascript
const memories = await client.getByTag({ tags: ["preferences"] });
```

**Option C: Use the ChatGPT Custom GPT**

Go to [reflectmemory.com](https://reflectmemory.com) and add the Reflect Memory Custom GPT. Ask it to list your recent memories. You should see the same entries you wrote from curl and your script. That's cross-vendor memory in action: one write, many readers.

---

## What's Next

- **Browse all memories:** Use `client.browse()` to paginate through your full memory store
- **Tag everything:** Tags like `preferences`, `project`, and `context` make retrieval easier
- **Claude + MCP:** If you use Claude Desktop, add the same MCP config so Claude can read and write memories too
- **Automate:** Call the API from scripts, CI, or other tools to keep your memory up to date

Your AI memory is now shared across ChatGPT, Claude, and Cursor. One source of truth, everywhere.
