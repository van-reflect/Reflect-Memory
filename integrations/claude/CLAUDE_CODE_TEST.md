# Claude Code - MCP Testing

Test Reflect Memory's MCP server in Claude Code.

## Setup

1. **Set your API key** (use `RM_AGENT_KEY_CLAUDE` from Railway):
   ```bash
   export REFLECT_MEMORY_API_KEY="your-claude-agent-key-here"
   ```

2. **Add the MCP server** via CLI:
   ```bash
   claude mcp add --transport http reflect-memory https://api.reflectmemory.com/mcp \
     --header "Authorization: Bearer $REFLECT_MEMORY_API_KEY"
   ```

   Or manually: copy the contents of `mcp-config.json` into your Claude Code MCP config. Config location:
   - **macOS**: `~/.claude/mcp.json` or `~/Library/Application Support/Claude/claude_desktop_config.json`
   - If your client supports env var expansion, `${REFLECT_MEMORY_API_KEY}` in the config will be substituted. Otherwise, replace it with the actual key (do not commit).

3. **Restart Claude Code** and verify the Reflect Memory tools appear.

## Test the tools

Once connected, try:
- "Pull the latest memory"
- "Browse my memories"
- "Write a memory: Test from Claude Code - just testing the MCP integration"
- "Search memories for council"

## Server logo

For the Anthropic form: the server logo is at `https://reflectmemory.com/logo.png`. Anthropic requires SVG format -- if they reject PNG, convert the logo using a tool like [CloudConvert](https://cloudconvert.com/png-to-svg) and upload the SVG.
