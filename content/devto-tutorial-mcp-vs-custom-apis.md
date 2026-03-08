---
title: Why I Chose MCP Over Custom APIs for AI Tool Integration
published: false
description: The Model Context Protocol (MCP) enables one integration that works across ChatGPT, Claude, Cursor, and more. Here's why that beats building custom APIs per vendor.
tags:
  - mcp
  - ai
  - api
  - integration
---

# Why I Chose MCP Over Custom APIs for AI Tool Integration

When I built Reflect Memory, a shared memory layer for AI agents, I had a choice: build a custom integration for each vendor (ChatGPT Actions, Claude Extensions, Cursor rules, Gemini Functions) or bet on a single protocol. I chose MCP, the Model Context Protocol. Here's why.

## What is MCP?

The Model Context Protocol is an open standard for how AI applications discover and invoke tools. Think of it like USB for AI: one plug, many devices. An MCP server exposes tools (functions with schemas). An MCP client (Cursor, Claude Desktop, etc.) discovers those tools and lets the model call them during a conversation.

The key insight: the client handles the transport. I don't have to implement OAuth for ChatGPT, a different auth flow for Claude, or Cursor's custom config format. I implement one server. The clients already know how to talk to it.

## The Alternative: Custom Integrations Per Vendor

Without MCP, you build N integrations. ChatGPT has Actions (OpenAPI spec, OAuth or API key). Claude has Extensions (different schema, different auth). Cursor has MCP support, but also custom rules and workflows. Gemini has Function Calling. n8n has its own node format.

Each integration means: a new auth story, a new schema format, a new deployment path, and a new surface for bugs. When you add a feature (e.g., a new memory type), you ship it N times. When a vendor changes their API, you fix N integrations.

## One Server, Many Clients

With MCP, I built one server that exposes five tools: `read_memories`, `get_memory_by_id`, `browse_memories`, `write_memory`, and `query`. Cursor users add it via `npx reflect-memory-mcp` in their MCP config. Claude Desktop users do the same. Any client that speaks MCP gets the full tool set.

The server runs as a standalone process. It uses Streamable HTTP transport, so it works over the network. No stdio hacks, no localhost-only limits. Auth is a Bearer token validated against our API. Same token works for the REST API and the MCP server.

## Interop Without Lock-In

MCP is vendor-neutral. Anthropic, Google, and others have adopted it. New clients will support it. If I had built a ChatGPT-only integration, I'd be locked into their release cycle and their design choices. With MCP, the protocol is the contract. I can add tools, deprecate old ones, and evolve the schema without rewriting per-vendor glue code.

## The Tradeoff

MCP is still evolving. Not every AI product supports it yet. Some vendors have their own extension systems and may never add MCP. For those, we still have the REST API and SDK. But for the clients that do support MCP (Cursor, Claude Desktop, and growing), one integration covers them all.

The protocol is maintained by Anthropic and adopted by others. Tool schemas use JSON Schema. Zod works well for validation on the server side. The Streamable HTTP transport means you can run the server remotely, not just as a local subprocess. That matters for multi-user or hosted setups.

## Recommendation

If you're building AI tooling, consider MCP first. One protocol, many clients, less code to maintain. You can always add vendor-specific integrations later for clients that don't support MCP. But starting with a single protocol reduces complexity and keeps your options open.

Reflect Memory: [reflectmemory.com](https://reflectmemory.com) | [github.com/van-reflect/Reflect-Memory](https://github.com/van-reflect/Reflect-Memory)
