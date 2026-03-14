/**
 * Shared core for Reflect Memory browser extension.
 *
 * Architecture: "Lazy Priming" with intent-based write-back.
 * - Primes on first message in a new conversation if relevant memories exist.
 * - Writes back only when the conversation contains substantive content
 *   (decisions, conclusions, plans) and has settled (no new AI output for 30s).
 * - Writes at most once per conversation to avoid dashboard clutter.
 */

const PRIMED_KEY = "reflect_memory_primed";
const WRITE_ENABLED_KEY = "reflect_memory_write_enabled";
const WRITTEN_KEY = "reflect_memory_written";
const DEBUG = true;

let isPriming = false;

function log(...args) {
  if (DEBUG) console.log("[Reflect Memory]", ...args);
}

async function sendToBackground(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, resolve);
  });
}

function formatMemoriesForPriming(memories) {
  if (!memories?.length) return null;

  const blocks = memories.map((m) => {
    const tags = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
    return `${m.title}${tags}\n${m.content}`;
  });

  return [
    "You are talking to a returning user. Below is context from their previous",
    "conversations across different AI tools (ChatGPT, Claude, Gemini, Grok,",
    "Perplexity, Cursor). This is their shared memory. Use it naturally to",
    "personalize your responses. Do not mention this context unless they ask",
    "about their memory. Do not say 'based on your previous conversations'",
    "or anything similar. Just know it and use it as if you already knew.",
    "",
    "After processing this context, respond with exactly:",
    "'Pulled memories from Reflect. Ready.'",
    "The user's actual message will follow immediately after.",
    "",
    "---",
    "",
    ...blocks,
  ].join("\n");
}

// --- Session state (survives SPA navigation) ---

function isAlreadyPrimed() {
  return sessionStorage.getItem(PRIMED_KEY) === "true";
}
function markAsPrimed() {
  sessionStorage.setItem(PRIMED_KEY, "true");
}
function isWriteEnabled() {
  return sessionStorage.getItem(WRITE_ENABLED_KEY) === "true";
}
function enableWrite() {
  sessionStorage.setItem(WRITE_ENABLED_KEY, "true");
  log("Write-back ENABLED for this session");
}
function hasAlreadyWritten() {
  return sessionStorage.getItem(WRITTEN_KEY) === "true";
}
function markAsWritten() {
  sessionStorage.setItem(WRITTEN_KEY, "true");
}

// --- Keyword extraction for search ---

function extractKeywords(text) {
  const stop = new Set([
    "what","should","i","the","a","an","is","are","was","were","be","been",
    "being","have","has","had","do","does","did","will","would","could","may",
    "might","must","shall","can","need","to","of","in","for","on","with","at",
    "by","from","up","about","into","over","after","how","when","where","why",
    "who","which","that","this","these","those","it","its","my","your","our",
    "their","his","her","me","him","them","us","and","or","but","not","no",
    "so","if","then","than","too","very","just","because","as","until","while",
    "each","any","all","both","few","more","most","other","some","such","only",
    "own","same","there","here","also","like","well","much","many","still",
    "already","now","even","really","right","going","want","know","think",
    "make","get","go","take","come","see","look","find","give","tell","say",
    "good","best","new","first","last","next","try","help","please","thanks",
  ]);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w));
}

function memoriesMatchKeywords(memories, keywords) {
  if (!keywords.length) return memories;
  return memories.filter((m) => {
    const haystack = `${m.title || ""} ${(m.tags || []).join(" ")} ${m.content || ""}`.toLowerCase();
    return keywords.some((kw) => haystack.includes(kw));
  });
}

// --- Priming flow ---

function waitForReadyResponse(timeoutMs = 12000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = setInterval(() => {
      const text = document.body.innerText || "";
      if (text.includes("Pulled memories from Reflect")) {
        clearInterval(check);
        log("AI acknowledged priming in", Date.now() - start, "ms");
        resolve(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        log("Timed out waiting for AI acknowledgment after", timeoutMs, "ms");
        resolve(false);
      }
    }, 400);
  });
}

function waitForInputReady(adapter, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = setInterval(() => {
      const el = adapter.getInputElement();
      if (el) {
        const editable = el.contentEditable === "true" || el.tagName === "TEXTAREA";
        const notDisabled = !el.disabled && !el.getAttribute("aria-disabled");
        if (editable && notDisabled) {
          clearInterval(check);
          log("Input ready after", Date.now() - start, "ms");
          resolve(true);
          return;
        }
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        log("Input ready timeout after", timeoutMs, "ms");
        resolve(false);
      }
    }, 200);
  });
}

function retrySend(adapter, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const start = Date.now();

    function attempt() {
      const sendBtn = document.querySelector("button[aria-label*='Send' i]");
      if (sendBtn && !sendBtn.disabled) {
        log("retrySend: clicking send button after", Date.now() - start, "ms");
        sendBtn.click();
        resolve(true);
        return;
      }

      if (Date.now() - start > timeoutMs) {
        log("retrySend: timed out. Dispatching Enter key as fallback.");
        const el = adapter.getInputElement();
        if (el) {
          el.focus();
          el.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Enter", code: "Enter", keyCode: 13, which: 13,
            bubbles: true, cancelable: true,
          }));
        }
        resolve(false);
        return;
      }

      setTimeout(attempt, 300);
    }

    attempt();
  });
}

async function interceptFirstMessage(adapter, userMessage) {
  if (isPriming || isAlreadyPrimed()) {
    log("Skipping: already primed or priming in progress");
    return false;
  }
  if (!adapter.isNewConversation()) {
    log("Skipping: not a new conversation");
    markAsPrimed();
    return false;
  }

  const authCheck = await sendToBackground({ type: "CHECK_AUTH" });
  log("Auth check:", authCheck);
  if (!authCheck?.authenticated) {
    log("Not authenticated. Check your agent key.");
    markAsPrimed();
    return false;
  }

  isPriming = true;
  markAsPrimed();
  enableWrite();

  try {
    const keywords = extractKeywords(userMessage);
    log("Extracted keywords:", keywords.join(", "));

    let memories = [];

    if (keywords.length > 0) {
      const searchTerm = keywords.slice(0, 4).join(" ");
      log("Searching memories for:", searchTerm);
      const response = await sendToBackground({
        type: "SEARCH_MEMORIES",
        term: searchTerm,
      });
      memories = response?.memories || [];
      log("Keyword search result:", memories.length, "memories found");
    }

    if (memories.length === 0) {
      log("Keyword search empty. Falling back to latest memories...");
      const fallback = await sendToBackground({
        type: "GET_MEMORIES",
        limit: 8,
      });
      const allRecent = fallback?.memories || [];
      log("Fetched", allRecent.length, "recent memories. Filtering by relevance...");
      memories = memoriesMatchKeywords(allRecent, keywords);
      log("After relevance filter:", memories.length, "memories match");
    }

    if (!memories.length) {
      log("No relevant memories found. Sending original message normally.");
      isPriming = false;
      return false;
    }

    const primingText = formatMemoriesForPriming(memories);
    if (!primingText) {
      isPriming = false;
      return false;
    }

    log("Setting priming text...");
    adapter.setInputValue(primingText);
    await new Promise((r) => setTimeout(r, 200));
    log("Sending priming message...");
    adapter.triggerSend();

    log("Waiting for AI to acknowledge...");
    await waitForReadyResponse(12000);

    log("Hiding priming exchange...");
    adapter.hideLastExchange();

    log("Waiting for input to become ready...");
    await waitForInputReady(adapter, 5000);

    log("Setting user's real message:", userMessage.slice(0, 60));
    adapter.setInputValue(userMessage);
    await new Promise((r) => setTimeout(r, 300));

    log("Sending user's real message...");
    await retrySend(adapter, 6000);

    log("Priming complete.");
  } catch (err) {
    log("Error during priming:", err);
    adapter.setInputValue(userMessage);
    await new Promise((r) => setTimeout(r, 100));
    adapter.triggerSend();
  }

  isPriming = false;
  return true;
}

// --- Write-back: structured conversation extraction ---

const SIGNAL_WORDS = [
  "decide", "decided", "decision", "conclusion", "direction",
  "priority", "prioritize", "focus", "strategy", "plan",
  "launch", "ship", "build", "implement", "architecture",
  "approach", "recommend", "suggestion", "action item",
  "next step", "takeaway", "key insight", "bottom line",
  "going with", "settled on", "committed to", "moving forward",
  "the play is", "let's go with", "final answer",
  "milestone", "deadline", "timeline", "roadmap",
  "trade-off", "tradeoff", "pros and cons", "versus",
  "pivot", "shift", "change direction", "reframe",
];

function conversationHasSubstance(turns) {
  if (turns.length < 2) return false;

  const fullText = turns.map((t) => t.text).join(" ").toLowerCase();
  const matchCount = SIGNAL_WORDS.filter((w) => fullText.includes(w)).length;

  if (matchCount >= 2) {
    log("writeBack: substance check passed with", matchCount, "signal words");
    return true;
  }

  const totalChars = turns.reduce((sum, t) => sum + t.text.length, 0);
  if (turns.length >= 4 && totalChars > 1500) {
    log("writeBack: substance check passed on length:", turns.length, "turns,", totalChars, "chars");
    return true;
  }

  log("writeBack: substance check failed. Signals:", matchCount, "Turns:", turns.length, "Chars:", totalChars);
  return false;
}

function extractConversationTurns(adapter) {
  const turns = [];

  const messages = adapter.getMessages();
  if (messages.length > 0) {
    for (const msg of messages) {
      if (!msg.text || msg.text.length < 10) continue;
      const lower = msg.text.toLowerCase();
      if (lower.includes("returning user") && lower.includes("shared memory")) continue;
      if (lower.includes("pulled memories from reflect") && msg.text.length < 200) continue;
      turns.push({ role: msg.role || "unknown", text: msg.text.trim() });
    }
    return turns;
  }

  const container =
    document.querySelector("main") ||
    document.querySelector("[role='main']") ||
    document.querySelector("[class*='conversation']") ||
    document.body;

  const humanEls = container.querySelectorAll("[data-is-streaming='false'][class*='human'], [class*='user-message'], [data-testid*='human'], [data-testid*='user']");
  const assistantEls = container.querySelectorAll("[data-is-streaming='false'][class*='assistant'], [class*='ai-message'], [data-testid*='assistant'], [data-testid*='ai']");

  const allEls = [...humanEls, ...assistantEls].sort((a, b) => {
    const posA = a.compareDocumentPosition(b);
    return posA & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  for (const el of allEls) {
    const text = el.innerText?.trim();
    if (!text || text.length < 10) continue;
    const lower = text.toLowerCase();
    if (lower.includes("returning user") && lower.includes("shared memory")) continue;
    if (lower.includes("pulled memories from reflect") && text.length < 200) continue;

    const isHuman = el.className?.includes("human") ||
      el.className?.includes("user") ||
      el.dataset?.testid?.includes("human") ||
      el.dataset?.testid?.includes("user");

    turns.push({ role: isHuman ? "user" : "assistant", text });
  }

  if (turns.length === 0) {
    const text = container.innerText || "";
    const lines = text.split("\n").filter((l) => l.trim().length > 20);
    const clean = lines.filter((l) => {
      const lower = l.toLowerCase();
      if (lower.includes("returning user") && lower.includes("shared memory")) return false;
      if (lower.includes("pulled memories from reflect") && l.length < 200) return false;
      if (lower.includes("claude is ai and can make mistakes")) return false;
      if (lower.includes("free plan") && l.length < 30) return false;
      if (lower.includes("new chat") && l.length < 20) return false;
      if (lower.includes("search") && l.length < 15) return false;
      if (lower.includes("customize") && l.length < 20) return false;
      if (lower.includes("projects") && l.length < 15) return false;
      if (lower.includes("artifacts") && l.length < 15) return false;
      if (lower.includes("recents") && l.length < 15) return false;
      if (l.trim() === "Reply..." || l.trim() === "Reply") return false;
      if (/^(Sonnet|Opus|Haiku)\s/i.test(l.trim()) && l.length < 30) return false;
      return true;
    });
    if (clean.length > 0) {
      turns.push({ role: "mixed", text: clean.join("\n") });
    }
  }

  return turns;
}

function buildMemoryFromTurns(turns, vendor) {
  const userTurns = turns.filter((t) => t.role === "user" || t.role === "mixed");
  const assistantTurns = turns.filter((t) => t.role === "assistant" || t.role === "mixed");

  const firstUserMsg = userTurns[0]?.text || "";
  const titleSource = firstUserMsg.split("\n")[0] || "Conversation";
  const title = `${vendor} -- ${titleSource.slice(0, 80)}`;

  const parts = [];
  for (const turn of turns) {
    const prefix = turn.role === "user" ? "User:" : turn.role === "assistant" ? "AI:" : "";
    const snippet = turn.text.length > 400 ? turn.text.slice(0, 400) + "..." : turn.text;
    parts.push(prefix ? `${prefix} ${snippet}` : snippet);
  }

  const content = parts.join("\n\n").slice(0, 2000);
  return { title, content };
}

async function writeConversationToMemory(adapter, vendor) {
  if (!isWriteEnabled() || hasAlreadyWritten()) return;

  const turns = extractConversationTurns(adapter);
  log("writeBack: extracted", turns.length, "turns");

  if (!conversationHasSubstance(turns)) return;

  const { title, content } = buildMemoryFromTurns(turns, vendor);
  if (content.length < 100) {
    log("writeBack: content too short after formatting:", content.length);
    return;
  }

  log("writeBack: writing memory. Title:", title.slice(0, 60));
  const result = await sendToBackground({
    type: "WRITE_MEMORY",
    data: {
      title,
      content,
      tags: ["auto_captured", vendor.toLowerCase()],
      origin: vendor.toLowerCase(),
    },
  });

  if (result?.id) {
    markAsWritten();
    log("writeBack: SUCCESS. Memory ID:", result.id);
  } else {
    log("writeBack: FAILED.", JSON.stringify(result));
  }
}

// --- Init ---

function initVendor(adapter, vendorName) {
  log(`Initializing ${vendorName} adapter...`);

  let documentListenerAttached = false;
  let inputReady = false;

  function onDocumentKeydown(e) {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (!e.isTrusted) return;

    const inputEl = adapter.getInputElement();
    if (!inputEl) return;

    const target = e.target;
    const isInput = target === inputEl || inputEl.contains(target) ||
      target.closest?.("[contenteditable]") === inputEl;
    if (!isInput) return;

    if (isPriming) return;
    if (isAlreadyPrimed()) return;

    const userMessage = adapter.getInputValue()?.trim();
    if (!userMessage) return;

    log("Enter intercepted. Message:", userMessage.slice(0, 80));
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();

    interceptFirstMessage(adapter, userMessage).then((handled) => {
      if (!handled) {
        const currentVal = adapter.getInputValue()?.trim();
        if (!currentVal) {
          log("Message already sent. Skipping re-send.");
          return;
        }
        log("No priming needed. Sending original message.");
        adapter.setInputValue(userMessage);
        setTimeout(() => adapter.triggerSend(), 50);
      }
    });
  }

  function ensureDocumentListener() {
    if (!documentListenerAttached) {
      document.addEventListener("keydown", onDocumentKeydown, { capture: true });
      documentListenerAttached = true;
      log("Document-level keydown listener attached (capture phase).");
    }
  }

  function checkForInput() {
    const el = adapter.getInputElement();
    if (!el) return;
    if (!inputReady) {
      inputReady = true;
      log("Input element found:", el.tagName, el.className?.slice(0, 60));
      ensureDocumentListener();
      log("Ready. Waiting for first Enter press.");
    }
  }

  checkForInput();
  const poll = setInterval(() => {
    checkForInput();
    if (inputReady) clearInterval(poll);
  }, 800);
  setTimeout(() => clearInterval(poll), 30000);

  const bodyObserver = new MutationObserver(() => {
    if (!inputReady) checkForInput();
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });

  // Write-back: waits for conversation to settle (30s of no new AI output),
  // then checks for substance before writing. Fires at most once.
  let settleTimer = null;
  let lastTextLen = 0;
  const writeObserver = new MutationObserver(() => {
    if (isPriming || !isWriteEnabled() || hasAlreadyWritten()) return;

    const len = document.body.innerText?.length || 0;
    if (Math.abs(len - lastTextLen) < 50) return;
    lastTextLen = len;

    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      log("writeBack: conversation settled. Checking substance...");
      writeConversationToMemory(adapter, vendorName);
    }, 30000);
  });
  writeObserver.observe(document.body, { childList: true, subtree: true });
}
