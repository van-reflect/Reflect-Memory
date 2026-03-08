# Week 1: Why I'm building shared memory for AI agents

I'm Van. I've spent years in design and product at Google, Apple, Sony, and TikTok. Now I'm building Reflect Memory, a vendor-neutral memory layer for AI agents. This is the first issue of a building-in-public series. No hype, no fluff. Just what I'm doing and why.

## What is Reflect Memory?

AI agents are stateless. ChatGPT doesn't remember your preferences. Claude doesn't recall your project context. Cursor starts every session from zero. That's fine for one-off tasks, but it breaks down when you want continuity across tools and time.

Reflect Memory is a memory substrate. One API. ChatGPT, Claude, Cursor, Gemini, n8n, and more can all read and write to the same store. You control what goes in, what gets shared, and what gets deleted. The model is stateless. The memory is yours.

## Why it exists

I got tired of repeating myself. Tell ChatGPT I prefer bullet points. Tell Claude the same thing. Tell Cursor my coding conventions. Three conversations, three times. And none of it persists. I wanted one place to put context and preferences, and have every agent I use pull from it.

I also wanted it to be vendor-neutral. I don't want to lock into OpenAI's memory API or Anthropic's extensions. I want a substrate that works regardless of which model or client I'm using. MCP (Model Context Protocol) made that possible. One integration, many clients.

## What's shipped

- TypeScript SDK: `npm install reflect-memory-sdk` (zero deps, Node 18+)
- MCP server: `npx reflect-memory-mcp` for Cursor, Claude Desktop, and any MCP client
- REST API at api.reflectmemory.com
- n8n community node: n8n-nodes-reflect-memory
- ChatGPT Custom GPT
- Structured memory types (semantic, episodic, procedural)
- Deterministic persistence, MCP-native, hard deletion (no soft deletes)

## What's next

Dashboard improvements, more integrations, and better onboarding. I'm early. Solo founder. Figuring it out as I go. The hardest part right now is distribution. Building the product is one thing. Getting it in front of people who actually need it is another. I'm trying Dev.to, community posts, and Product Hunt. We'll see what sticks.

I had a conversation with someone at a16z recently. I won't name names or share specifics, but it reinforced something: the problem is real. People want memory that works across vendors. The question is whether I can ship fast enough and find the right distribution. That conversation gave me a bit of confidence that I'm not building in a vacuum. The market might be early, but the need is there.

If you're using multiple AI tools and want continuity, try Reflect Memory. If you have feedback, I'd love to hear it. Building in public means being honest about what works and what doesn't. So far, the technical foundation feels solid. The rest is an experiment. I'll share what I learn as I go. Wins, failures, and everything in between. The goal is to build something useful and document the journey honestly.

Thanks for reading. More next week.

Van

[reflectmemory.com](https://reflectmemory.com) | [github.com/van-reflect/Reflect-Memory](https://github.com/van-reflect/Reflect-Memory)
