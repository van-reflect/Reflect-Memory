# Reflect Memory Reddit Distribution Campaign

---

## 1. r/ChatGPT

**Title:** I made ChatGPT remember things across sessions using a Custom GPT + external memory API

**Body:**

ChatGPT's built-in memory is great, but it only works inside ChatGPT. I kept running into the same issue: I'd tell ChatGPT something important, switch to Claude or Cursor for a different task, and when I came back, I had to explain everything again. The context lived in one silo.

I built a Custom GPT that connects to an external memory API. Now when I tell ChatGPT something, it gets written to a shared store. When I open Claude or Cursor later, they can read it. Same memory, different tools. The Custom GPT instructions are simple: before answering, check memory for relevant context. After important exchanges, offer to save key facts.

It's not perfect. The Custom GPT has to be prompted to use memory. But it changed how I work. I no longer paste the same project context into every new chat. The setup is at reflectmemory.com with instructions for the Custom GPT. If you've been frustrated by ChatGPT forgetting things or by having to repeat yourself across tools, this might help. I'd love to hear what use cases you'd want it for.

---

## 2. r/ClaudeAI

**Title:** I connected Claude to persistent memory via MCP -- it now remembers my coding preferences across projects

**Body:**

I use Claude for code review and Cursor for implementation. The problem: Claude had no idea what I'd already told Cursor. Every session started from zero. I'd say "I prefer functional patterns here" in Cursor, then repeat it in Claude. Same with error handling preferences, comment style, and project constraints.

I set up Reflect Memory with the MCP server. Claude connects via MCP, reads and writes memories with tools like `read`, `write`, and `search`. Now when I tell Cursor my preferences, they go into shared memory. When I open Claude for a review, it fetches them automatically. No more re-explaining. The context carries over.

The MCP integration is straightforward. You add the server to your Claude config, and it gets access to your memories. You control which vendors can see what via `allowed_vendors`, so you can keep some memories private to certain tools. Architecture and setup are at github.com/van-reflect/Reflect-Memory. If you're using Claude alongside other AI tools, this might save you a lot of repetition. Curious what workflows you'd use it for.

---

## 3. r/cursor

**Title:** I added persistent memory to Cursor -- here's how it changed my workflow

**Body:**

I've been using Cursor for a few months. The biggest friction wasn't the editor. It was losing context every time I switched tools or started a new session. I'd debug something in Cursor, get a theory, switch to Claude for a second opinion, then come back. Cursor had no idea what we'd discussed. I'd paste the same code and error message again.

I plugged Reflect Memory into Cursor via MCP. Now when I'm debugging, I write key decisions to memory: the bug, the approaches we tried, the fix we chose. When I switch to Claude or ChatGPT, they can read it. When I come back to Cursor the next day, the context is still there. No more re-onboarding the AI.

The setup is a few lines in the MCP config. The SDK is `npm install reflect-memory-sdk` if you want to build something custom. I'm a solo founder who built this after getting tired of repeating myself. Details at reflectmemory.com. If you've hit the same context-loss problem, I'd be interested in how you'd want memory to work in your workflow.

---

## 4. r/LocalLLaMA

**Title:** Open-source memory layer that works with any model -- no vendor lock-in

**Body:**

Most AI memory systems are tied to a single vendor. ChatGPT Memory, Claude Projects, Cursor's context. None of them interoperate. If you're running local models or mixing vendors, you're stuck with siloed, non-portable memory.

Reflect Memory is a vendor-neutral memory substrate. It's a REST API plus MCP server. You write memories from one tool, retrieve them from another. The write path has no AI: deterministic persistence, structured types (semantic, episodic, procedural), versioning with an audit trail. The retrieval path uses an OpenAI-compatible API, so you can point it at local models via ollama or any compatible endpoint.

The schema is open. ARCHITECTURE.md and the OpenAPI spec are in the repo. You control visibility with `allowed_vendors`: decide which tools can see which memories. TypeScript backend, SQLite or Postgres. Integrations exist for ChatGPT (Custom GPT), Claude (MCP), Cursor (MCP), Gemini, n8n. Repo: github.com/van-reflect/Reflect-Memory. If you're building agents that need persistent memory without vendor lock-in, this might be useful. Feedback welcome.

---

## 5. r/artificial

**Title:** The AI memory problem nobody is solving: why every tool forgets everything

**Body:**

We're building more capable AI tools, but they all share the same flaw: they forget. ChatGPT doesn't know what you told Claude yesterday. Cursor doesn't know what you discussed in a different session. Every conversation starts from zero. Users repeat context constantly: preferences, project details, decisions, constraints. It's not a model problem. It's an infrastructure problem.

The vendor responses are walled gardens. ChatGPT Memory stays in OpenAI. Claude Projects stay in Anthropic. None of these systems talk to each other. Your accumulated context is fragmented across silos you don't control.

I built Reflect Memory as a vendor-neutral layer. One API, every vendor. Write a memory from one tool, retrieve it from another. You control which vendors can see what. No AI in the write path, just deterministic persistence. It supports ChatGPT, Claude, Cursor, Gemini, n8n, and more. I'm a solo founder, ex-Google/Apple/Sony/TikTok designer, building in public. reflectmemory.com and github.com/van-reflect/Reflect-Memory. I'd like to hear what you think the memory layer should look like.

---

## 6. r/SideProject

**Title:** I'm building the memory layer for AI -- here's the architecture

**Body:**

I kept switching between ChatGPT, Claude, and Cursor and losing context every time. Each tool started from zero. I repeated myself in ten minutes more than I'd like to admit. So I started building a shared memory layer for AI agents.

Reflect Memory is a vendor-neutral substrate. It sits underneath the tools. You write a memory from Cursor, retrieve it from Claude or ChatGPT. One API, every vendor. The architecture is simple: a REST API, MCP transport for Cursor and Claude, and a memory service that does pure data access. No AI in the write path. Structured memory types, versioning, and `allowed_vendors` so you control who sees what.

I'm a solo founder. Designer background (Google, Apple, Sony, TikTok), pivoted to AI infrastructure. Building in public. The repo has ARCHITECTURE.md, an OpenAPI spec, and integrations for ChatGPT (Custom GPT), Claude (MCP), Cursor (MCP), Gemini, and n8n. reflectmemory.com and github.com/van-reflect/Reflect-Memory. Would love feedback on the architecture or what you'd want from a memory layer.
