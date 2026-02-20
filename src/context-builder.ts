// Reflect Memory — Context Builder
// Pure function. No I/O. No database. No network. No side effects.
// Takes data in, returns a string out. Nothing else.

import type { MemoryEntry } from "./memory-service.js";

// =============================================================================
// buildPrompt
// =============================================================================
// Assembles a complete prompt string from a system prompt, memory entries,
// and a user query.
//
// Guarantees (Invariant 3 — Pure Function):
// - The function signature accepts only data. No Database handle, no config
//   object, no logger, no request context.
// - Given the same inputs, it always produces the same output.
// - It does not fetch data — memories are passed in by the caller.
// - It does not decide which memories to include — that decision was made
//   upstream based on the user's explicit intent (Invariant 1).
// - It does not transform or summarize memory content. What the user wrote
//   is what the model sees.
// - The output is a single string suitable for inspection in a QueryReceipt
//   (Invariant 5). No structured message format — one string, fully readable.
// =============================================================================

export function buildPrompt(
  memories: MemoryEntry[],
  userQuery: string,
  systemPrompt: string,
): string {
  const sections: string[] = [];

  // --- System instructions ---
  if (systemPrompt.length > 0) {
    sections.push(`[System]\n${systemPrompt}`);
  }

  // --- Memory entries ---
  // Each memory is rendered with its title, tags, and full content.
  // No truncation, no summarization, no reordering.
  if (memories.length > 0) {
    const memoryBlocks: string[] = [];

    for (const memory of memories) {
      const lines: string[] = [];
      lines.push(`--- ${memory.title} ---`);
      if (memory.tags.length > 0) {
        lines.push(`Tags: ${memory.tags.join(", ")}`);
      }
      lines.push(`${memory.content}`);
      memoryBlocks.push(lines.join("\n"));
    }

    sections.push(`[Memories]\n\n${memoryBlocks.join("\n\n")}`);
  }

  // --- User query ---
  sections.push(`[User Query]\n${userQuery}`);

  return sections.join("\n\n");
}
