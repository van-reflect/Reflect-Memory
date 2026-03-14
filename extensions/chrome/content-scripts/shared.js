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
        limit: 20,
      });
      const all = fallback?.memories || [];
      memories = all.filter((m) => {
        const t = (m.title || "").toLowerCase();
        const tags = (m.tags || []).join(" ").toLowerCase();
        if (t.startsWith("ci ") || t.includes("ci-") || t.includes("integration test")) return false;
        if (tags.includes("ci_") || tags.includes("integration_test")) return false;
        if (m.content && m.content.length < 50) return false;
        return true;
      }).slice(0, 5);
      log("Fallback: fetched", all.length, "-> filtered to", memories.length, "real memories");
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
    await new Promise((r) => setTimeout(r, 300));
    log("Sending priming message...");
    await retrySend(adapter, 6000);

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

const AFFIRMATION_PATTERNS = [
  /\b(let'?s go with|going with|go with|down to|i'?m down|let'?s do)\b/i,
  /\b(i like th(at|is)|love it|love that|sounds good|sounds great|sounds right)\b/i,
  /\b(agreed|i agree|exactly|perfect|yes let'?s|yep let'?s|yeah let'?s)\b/i,
  /\b(makes sense|that'?s the move|that'?s it|locked in|let'?s lock)\b/i,
  /\b(go for it|do it|ship it|build it|run with)\b/i,
  /\b(decision made|decided|settling on|committed to|final call)\b/i,
  /\b(this is the way|moving forward with|proceeding with)\b/i,
];

function isAffirmation(text) {
  return AFFIRMATION_PATTERNS.some((p) => p.test(text));
}

const NOISE_PATTERNS = [
  /^(new chat|search|customize|projects|artifacts|recents|reply\.{0,3})$/i,
  /^(sonnet|opus|haiku|claude|gpt|gemini)\s*[\d.]*\s*$/i,
  /claude is ai and can make mistakes/i,
  /free plan/i,
  /^share$/i,
  /^show more$/i,
  /^skip$/i,
  /^\d+ of \d+$/,
  /^something else$/i,
  /^(saas|mobile app|physical product|marketplace|service|agency)/i,
  /^\+ to navigate/i,
  /^enter to select/i,
  /^esc to /i,
  /^(starred|connected tools|admin|api keys|usage|billing|trash|memories)$/i,
  /^(myaispeed|ai speed index)$/i,
  /^reflect memory$/i,
  /^sign out$/i,
  /^(copy|edit|delete|retry|more)$/i,
];

function isNoiseLine(line) {
  if (line.length < 10) return true;
  return NOISE_PATTERNS.some((p) => p.test(line.trim()));
}

function isPrimingContent(text) {
  const lower = text.toLowerCase();
  return (lower.includes("returning user") && lower.includes("shared memory")) ||
    (lower.includes("pulled memories from reflect") && text.length < 200);
}

function extractCleanConversation() {
  const main = document.querySelector("main") || document.body;
  const text = main.innerText || "";

  const lines = text.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !isNoiseLine(l))
    .filter((l) => !isPrimingContent(l));

  return lines.join("\n");
}

function isAiStillStreaming() {
  return !!document.querySelector("[data-is-streaming='true']") ||
    !!document.querySelector(".result-streaming") ||
    !!document.querySelector("[class*='streaming']");
}

let writeInProgress = false;

async function writeConversationToMemory(vendor) {
  if (!isWriteEnabled() || hasAlreadyWritten() || writeInProgress) return;
  writeInProgress = true;

  if (isAiStillStreaming()) {
    log("writeBack: AI still streaming. Waiting...");
    await new Promise((r) => setTimeout(r, 5000));
    if (isAiStillStreaming()) {
      log("writeBack: still streaming after 5s. Aborting.");
      writeInProgress = false;
      return;
    }
  }

  const conversation = extractCleanConversation();
  log("writeBack: extracted", conversation.length, "chars of conversation");

  if (conversation.length < 300) {
    log("writeBack: conversation too short:", conversation.length);
    writeInProgress = false;
    return;
  }

  const fullText = conversation.toLowerCase();
  const matchCount = SIGNAL_WORDS.filter((w) => fullText.includes(w)).length;
  if (matchCount === 0 && conversation.length < 1000) {
    log("writeBack: no substance signals and too short. Skipping.");
    writeInProgress = false;
    return;
  }

  log("writeBack: sending to AI for summarization...");
  const result = await sendToBackground({
    type: "SUMMARIZE_AND_WRITE",
    conversation,
    vendor,
  });

  if (result?.id) {
    markAsWritten();
    log("writeBack: SUCCESS. Memory ID:", result.id);
  } else {
    writeInProgress = false;
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

    const userMessage = adapter.getInputValue()?.trim();
    if (!userMessage) return;

    if (isAlreadyPrimed()) {
      if (isWriteEnabled() && !hasAlreadyWritten() && isAffirmation(userMessage)) {
        log("Affirmation detected:", userMessage.slice(0, 60));
        setTimeout(() => {
          log("writeBack: affirmation triggered immediate write");
          writeConversationToMemory(vendorName);
        }, 5000);
      }
      return;
    }

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

  // Write-back: poll every 10s. When text stabilizes for 2 consecutive
  // checks (20s of no meaningful change) and write is enabled, attempt write.
  let stableCount = 0;
  let prevSnapshot = "";
  setInterval(() => {
    if (isPriming || !isWriteEnabled() || hasAlreadyWritten()) {
      stableCount = 0;
      return;
    }

    const main = document.querySelector("main") || document.body;
    const snapshot = main.innerText?.slice(0, 3000) || "";
    if (Math.abs(snapshot.length - prevSnapshot.length) < 30) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    prevSnapshot = snapshot;

    if (stableCount >= 2) {
      log("writeBack: conversation stable for 20s. Checking substance...");
      stableCount = 0;
      writeConversationToMemory(vendorName);
    }
  }, 10000);
}
