# Reflect Memory Plugin for Claude

Connect Claude to your Reflect Memory instance -- read, write, browse, and search your cross-agent memory system.

## Setup

### 1. Get your API key

You need a Reflect Memory agent key for Claude. This is the `RM_AGENT_KEY_CLAUDE` value from your Reflect Memory deployment.

### 2. Set the environment variable

```bash
export REFLECT_MEMORY_API_KEY="your-claude-agent-key-here"
```

Or add it to your shell profile (`~/.zshrc`, `~/.bashrc`).

### 3. Install the plugin

```bash
claude --plugin-dir /path/to/reflect-memory-plugin
```

Or install from a marketplace once published.

## Usage

### Slash commands

| Command | What it does |
|---------|-------------|
| `/reflect-memory:latest` | Pull the most recent memory |
| `/reflect-memory:browse` | List all memory summaries |
| `/reflect-memory:write` | Write a new memory |
| `/reflect-memory:search <term>` | Search memories by keyword |

### Natural language

Just ask Claude naturally:
- "What's my latest memory?"
- "Search memories about authentication"
- "Save this to memory: [your content]"
- "Show me all memories tagged with council"

The memory skill activates automatically when your request involves reading or writing memories.

## Architecture

This plugin connects to your Reflect Memory API via MCP (Model Context Protocol) over Streamable HTTP. All requests are authenticated with your agent key and scoped to your user account. Vendor-level access rules are enforced server-side.
