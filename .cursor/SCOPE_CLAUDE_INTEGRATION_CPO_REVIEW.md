# Scope: Claude Skills + Gemini Gems Integration — CPO Review (Onyx)

**Context:** CEO flagged two platform features from social media as potential integration paths for Reflect Memory MVP.

---

## What was shared (screenshots / social)

- **Claude Skills** (from ai_herway): Claude’s new SKILL.md system for teaching Claude workflows, plus MCP (Model Context Protocol) for tool connectivity.
- **Gemini Gems** (from theaipage): Google’s custom AI assistants / personas.

---

## CTO research summary

### Claude Skills — actionable
- Claude now has a Skills system (SKILL.md) across Claude.ai, Claude Desktop (Cowork), and Claude Code.
- Claude can connect to external tools via MCP — an open standard for AI-to-tool connectivity.
- MCP is supported by Anthropic, OpenAI, Google, AWS, Microsoft, and Cloudflare.
- Strong integration path for Reflect Memory.

### Gemini Gems — not yet actionable
- Custom personas with instructions.
- Gems do **not** support external API calls from the chat UI.
- Gemini API supports function calling for app builders, but not for end-users in gemini.google.com.
- Worth monitoring; not in current MVP scope.

---

## CTO scope — two paths (recommend both)

### Path B (ship first, ~1 day)
- Publish a Claude Skill (SKILL.md) that teaches Claude how to call the Reflect Memory REST API.
- Bundle OpenAPI spec and auth setup guide.
- Distribute via skills.pub or as a `.claude/skills/` folder.
- Works in Claude Code and API immediately.

### Path A (ship second, ~2–3 days)
- Build a remote MCP server in TypeScript — thin adapter over the existing API.
- Expose tools: `read_memories`, `write_memory`, `browse_memories`, `get_memory_by_id`, `query_with_context`.
- Deploy as a Streamable HTTP endpoint.
- Users connect via `claude mcp add`.
- Works across every Claude surface.
- Open standard → same server can work with any MCP host (OpenAI, Google, etc.).

---

## Impact

Claude integration makes Reflect Memory a native tool inside every Claude surface. Combined with existing ChatGPT Custom GPT and Cursor integration, this covers the three main AI tools developers use.

---

## CPO input requested (Onyx)

1. **Priority level** — How important is Claude integration vs current UX / landing-page focus?
2. **Sequencing** — Path B first, then Path A, or different?
3. **Alignment** — Does this align with UX/Landing Page work, or run in parallel?

---

*Saved for CPO review after fixing Onyx’s “latest memory” retrieval issue. Revisit when API is stable.*
