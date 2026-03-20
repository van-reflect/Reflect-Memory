# Reflect Memory

### Shared memory for AI tools so your team's context never resets.

---

## The Problem

Every AI conversation starts from zero. Your developers explain the same codebase, the same architecture decisions, the same project context, every session, every tool. Context doesn't carry between ChatGPT and Claude. Cursor doesn't know what your team discussed in Gemini. Institutional knowledge lives in people's heads, not in the tools.

## What Reflect Memory Does

Reflect Memory is a memory layer that sits between your team and the AI tools they already use. When one tool learns something, every other tool knows it too.

- A developer explains your API architecture to ChatGPT. Claude already knows it next time.
- Cursor remembers codebase decisions from last week's session without re-prompting.
- Coding standards, compliance rules, and architecture decisions persist across every AI interaction.

One memory store. Every AI tool reads from it. Your team writes to it naturally, no workflow changes.

---

## Use Cases for Engineering Teams

**Compliance and regulatory context that persists**
State-by-state rules, consent requirements, legal restrictions. Instead of re-explaining your compliance framework every AI session, it's always there. Your AI tools know your rules before the conversation starts.

**Cross-service debugging with memory**
When an incident hits, the context from last week's outage carries forward. Your AI assistant remembers the root cause, the fix, and which services were affected. Engineers stop re-discovering the same problems.

**Integration knowledge retention**
API quirks, vendor-specific workarounds, auth patterns for third-party systems. The tribal knowledge that usually lives in one engineer's head stays in memory across every tool the whole team uses.

**Persistent codebase context**
Developers stop re-explaining project structure, tech stack, and conventions to AI assistants. Cursor, ChatGPT, and Claude all share the same understanding of your codebase.

**Cross-tool continuity**
Start a design discussion in Claude, continue implementation in Cursor, debug in ChatGPT. Context follows the work, not the tool.

**Faster ramp-up for new engineers**
An admin can seed a new developer's memory store with your team's architecture docs, coding standards, and system context. From their first AI session, they have the same foundational context as your senior engineers, without anyone having to sit with them and explain it.

**AI-powered automation with context**
n8n workflows, internal scripts, and CI/CD pipelines can read and write memories. Your automation layer has the same context your developers do.

---

## Works With Your AI Setup

Reflect Memory is the memory layer, not the AI itself. It works regardless of how your team runs their models.

**Using cloud AI tools (ChatGPT, Claude, Cursor, etc.)**
Your developers keep using the tools they already use. The AI conversations happen in the cloud as usual, but the persistent memory lives on your infrastructure. Context accumulates locally; nothing leaves your network.

**Running local/self-hosted models (Ollama, vLLM, etc.)**
The memory API runs on your network alongside your models. Your LLMs call the same REST API. No external connections required, model egress is disabled by default in private deployments.

**Hybrid (mix of both)**
Some teams use Cursor and ChatGPT for day-to-day work but run internal models for sensitive tasks. Reflect Memory serves both. The memory store is the same regardless of which model reads from it.

---

## How It Works

**For developers:** REST API + MCP protocol. Write a memory, read it from any connected tool. Standard Bearer token auth. Five-minute integration.

**Supported tools:** ChatGPT, Claude, Cursor, Gemini, Grok, Perplexity, n8n, and any tool that speaks REST or MCP. Chrome extension for browser-based AI tools. Native MCP connectors for Cursor and Claude.

**For your infrastructure team:** Runs as a single container. Docker or Helm. Connects to your existing identity provider via OIDC/SSO.

---

## Deployment Options

| | Hosted | Private Deploy |
|---|---|---|
| **Where it runs** | Reflect Memory cloud | Your VPC / on-prem |
| **Data residency** | Our infrastructure | Your infrastructure |
| **Network boundary** | Public API | Private, no data leaves your network |
| **AI model egress** | Enabled | Disabled by default, use your own models |
| **Auth** | API keys | API keys + SSO via your IdP |
| **Audit trail** | Yes | Yes, queryable and exportable |

Private deploy is a single Docker container with env-based configuration. No external dependencies. Your data, your network, your control.

---

## Security at a Glance

- All data stays within your deployment boundary, no telemetry or phone-home
- SSO integration with Okta, Azure AD, Google Workspace, Auth0, Keycloak
- Full audit trail on every read, write, and auth event, exportable for compliance
- Timing-safe authentication, PKCE-based OAuth for connectors
- Tenant isolation by design, dedicated process and storage per deployment
- Per-user memory isolation, each developer's memory store is private to them

---

## Getting Started

A pilot looks like this:

1. We deploy a private instance in your environment (30 minutes)
2. Your developers connect their AI tools via API key or MCP (5 minutes per tool)
3. They use their tools normally, memories accumulate and sync automatically
4. After 1-2 weeks, your team has persistent, shared AI context across every tool

---

Van Mendoza, Founder
vm@reflectmemory.com
reflectmemory.com
