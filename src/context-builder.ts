// Reflect Memory -- Context Builder
// Pure function. No I/O. No database. No network. No side effects.
// Takes data in, returns data out. Nothing else.

import type { MemoryEntry } from "./memory-service.js";

// =============================================================================
// Types
// =============================================================================

export interface PromptResult {
  prompt: string;
  memoriesIncluded: number;
  memoriesTotal: number;
  truncated: boolean;
  estimatedTokens: number;
}

// =============================================================================
// buildPrompt
// =============================================================================
// Assembles a complete prompt string from a system prompt, memory entries,
// and a user query.
//
// Guarantees (Invariant 3 -- Pure Function):
// - The function signature accepts only data. No Database handle, no config
//   object, no logger, no request context.
// - Given the same inputs, it always produces the same output.
// - It does not fetch data -- memories are passed in by the caller.
// - It does not decide which memories to include -- that decision was made
//   upstream based on the user's explicit intent (Invariant 1).
// - It does not transform or summarize memory content. What the user wrote
//   is what the model sees -- within the character budget.
// - The output is suitable for inspection in a QueryReceipt (Invariant 5).
//
// Character budget:
// - When charBudget is provided, memories are included in order until the
//   budget would be exceeded. At least one memory is always included if any
//   exist (the first memory is never skipped due to budget).
// - A truncation note is appended when memories are omitted.
// - When charBudget is undefined, all memories are included (legacy behavior).
// =============================================================================

export function buildPrompt(
  memories: MemoryEntry[],
  userQuery: string,
  systemPrompt: string,
  charBudget?: number,
): PromptResult {
  const systemSection = systemPrompt.length > 0 ? `[System]\n${systemPrompt}` : "";
  const querySection = `[User Query]\n${userQuery}`;

  // Fixed overhead: system + query + separators
  const fixedChars =
    (systemSection.length > 0 ? systemSection.length + 2 : 0) +
    querySection.length +
    2; // "\n\n" between sections

  let memoriesIncluded = 0;
  let truncated = false;
  const memoryBlocks: string[] = [];
  let memoryChars = 0;

  if (memories.length > 0) {
    // "[Memories]\n\n" header
    const headerLen = "[Memories]\n\n".length;

    for (const memory of memories) {
      const lines: string[] = [];
      lines.push(`--- ${memory.title} ---`);
      if (memory.tags.length > 0) {
        lines.push(`Tags: ${memory.tags.join(", ")}`);
      }
      lines.push(`${memory.content}`);
      const block = lines.join("\n");

      const separatorLen = memoryBlocks.length > 0 ? 2 : 0; // "\n\n" between blocks
      const projectedTotal = fixedChars + headerLen + memoryChars + separatorLen + block.length + 2;

      if (charBudget != null && projectedTotal > charBudget && memoriesIncluded > 0) {
        truncated = true;
        break;
      }

      memoryBlocks.push(block);
      memoryChars += separatorLen + block.length;
      memoriesIncluded++;
    }
  }

  // Assemble final prompt
  const sections: string[] = [];
  if (systemSection.length > 0) {
    sections.push(systemSection);
  }

  if (memoryBlocks.length > 0) {
    let memoriesSection = `[Memories]\n\n${memoryBlocks.join("\n\n")}`;
    if (truncated) {
      const omitted = memories.length - memoriesIncluded;
      memoriesSection += `\n\n[Note: ${omitted} additional memor${omitted === 1 ? "y was" : "ies were"} omitted due to context size limits. Use more specific tags or filters to narrow results.]`;
    }
    sections.push(memoriesSection);
  }

  sections.push(querySection);

  const prompt = sections.join("\n\n");
  return {
    prompt,
    memoriesIncluded,
    memoriesTotal: memories.length,
    truncated,
    estimatedTokens: Math.ceil(prompt.length / 4),
  };
}
