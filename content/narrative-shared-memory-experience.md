# I Gave All My AI Tools Shared Memory. Here's What Happened.

I was debugging a race condition in Cursor. I had a theory about the async flow, so I switched to Claude for a second opinion. Claude gave me a different angle. I went back to Cursor, tried a fix, and thought: let me ask ChatGPT to summarize what we decided so I can document it.

I pasted the code. The error. The context. Again.

Each tool started from zero. I repeated myself three times in ten minutes. Not because the tools were bad. Because none of them knew what the others knew.

That was the moment. Not a dramatic one. Just the usual friction of switching between AI tools and losing context every single time.

I'm Van. I spent years as a designer at Google, Apple, Sony, and TikTok. Then I shifted to building AI infrastructure because something about the memory problem felt wrong in a way I couldn't ignore. I built Reflect Memory -- a vendor-neutral shared memory layer for AI agents. You write a memory from one tool. You read it from another. It supports ChatGPT, Claude, Cursor, Gemini, n8n, and more. MCP-native architecture, TypeScript backend, open API spec. Solo founder, building in public.

Here's what actually changed once I started using it.

## The debugging session that started it

I wrote a memory in Cursor during that race condition session: the bug, the two approaches we considered, the fix we chose, and why we chose it. Tagged it with the project name and "architecture-decision."

Then I switched to Claude. It already knew the context. I didn't explain the bug. I didn't paste code. I asked a follow-up question and it answered in context. Then I opened ChatGPT and asked it to reference the decision. It could. The thread continued where it left off, across three different tools.

That had never happened before.

## Coding preferences that actually stick

Here's a small thing that matters more than it sounds. I told Cursor I prefer functional patterns over classes for a particular project. I like explicit error handling. I want concise comments that explain "why," never "what."

That went into shared memory. When I opened Claude later to review a pull request, it already knew those preferences. I didn't have to write "by the way, I like functional style here." It was there. The same thing happened with Gemini when I used it for a quick code generation task. My preferences followed me.

Before shared memory, I had the same style guide pasted into three different system prompts. Now I have it in one place and every tool reads from it.

## Project context that carries over

I started a coding session in Cursor with high-level project context: what the feature is, what we're optimizing for, what we're deliberately not doing. Normal stuff you'd tell a new teammate.

I closed Cursor. Came back the next day. Opened a different tool entirely. The project context was still there. I didn't have to re-onboard the AI. The state carried over between sessions and between vendors.

This sounds basic. It should be basic. But right now, with vendor-siloed memory, every new session is a blank slate. Shared memory makes sessions feel continuous.

## Decision logs everyone can reference

When we chose an approach -- SQLite for local dev, Postgres for production, MCP as the transport layer -- I wrote it to memory with tags like "architecture" and "decision." Now any tool I use can reference that decision. No more "why did we do it this way?" No more re-explaining the same rationale to a different AI.

It's like having a team wiki that your AI tools can actually read.

## What doesn't work yet

I'd be lying if I said it's polished. It's early. The retrieval isn't always perfect. Sometimes memories don't surface when they should because the query doesn't match the tags well enough. The UX for writing and organizing memories is still evolving. Structured memory types (semantic, episodic, procedural) are new and I'm still figuring out how people want to use them.

If you expect a finished product with a slick onboarding, you'll be disappointed. If you're a developer who's comfortable with APIs and wants to solve a real problem that no one else is shipping, it might be worth your time.

## Try it

If you've ever repeated yourself across ChatGPT, Claude, and Cursor, or if you've lost context when switching tools, Reflect Memory is at reflectmemory.com. The SDK is `npm install reflect-memory-sdk`. Zero dependencies. The MCP server plugs into Cursor and Claude with one command.

I'm building this in public and I want to hear what works, what breaks, and what you'd use it for. The repo is at github.com/van-reflect/Reflect-Memory.
