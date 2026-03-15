# Reflect Memory — Grok Integration

Give Grok access to your shared memory across AI tools. Grok automatically gets your relevant context at the start of conversations and saves important decisions.

## Setup (1 minute)

### Chrome Extension (recommended)

1. Install the **Reflect Memory** Chrome Extension
2. Click the extension icon and paste your **agent key** (from [reflectmemory.com/dashboard](https://reflectmemory.com/dashboard))
3. Open **grok.com** and start a new conversation

That's it. The extension automatically:
- Injects your relevant memories into your first message
- Saves conversation context when you affirm decisions ("let's go with that", "lock it in", etc.)

### For developers: xAI API (native MCP)

If you're building with the xAI API/SDK, you can add Reflect Memory as a remote MCP tool:

```python
from xai_sdk.tools import mcp

tools = [
    mcp(
        server_url="https://api.reflectmemory.com/mcp",
        server_label="reflect-memory",
        authorization="Bearer YOUR_GROK_AGENT_KEY"
    )
]
```

See the [xAI Remote MCP docs](https://docs.x.ai/developers/tools/remote-mcp) for full details.

## What you can say to Grok

**Reading memories (automatic via extension):**
- "What should I focus on for [topic]?" — context injected automatically
- Your relevant memories appear as part of the conversation

**Saving memories (affirm a decision):**
- "Let's go with that plan"
- "Lock it in"
- "Sounds good, ship it"
- "That's the move"

## Where to get your agent key

1. Log in to [reflectmemory.com/dashboard](https://reflectmemory.com/dashboard)
2. Go to **API Keys**
3. Create a new agent key with vendor set to **grok**
4. Copy the key and paste it into the Chrome Extension

## How it works

The Chrome Extension runs on grok.com and:
1. Detects when you start a new conversation
2. Searches your Reflect Memory for context relevant to your first message
3. Prepends that context invisibly to your message
4. Grok responds with full awareness of your project, preferences, and decisions
5. When you affirm a direction, the extension summarizes and saves the conversation

Memories written from Grok have `origin: "grok"` and are visible to all your connected AI tools (ChatGPT, Claude, Cursor, Gemini, etc.).
