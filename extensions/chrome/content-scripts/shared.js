/**
 * Shared core for Reflect Memory browser extension.
 *
 * Architecture: "Lazy Priming" with selective write-back.
 */

const PRIMING_MARKER = "[[REFLECT_MEMORY_PRIME]]";
const PRIMED_KEY = "reflect_memory_primed";
const WRITE_ENABLED_KEY = "reflect_memory_write_enabled";
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

    // Step 1: Send priming message
    log("Setting priming text...");
    adapter.setInputValue(primingText);
    await new Promise((r) => setTimeout(r, 300));
    log("Sending priming message...");
    adapter.triggerSend();

    // Step 2: Wait for Claude to respond with "Ready"
    log("Waiting 7s for AI to process context...");
    await new Promise((r) => setTimeout(r, 7000));

    // Step 3: Try to hide priming exchange
    log("Hiding priming exchange...");
    adapter.hideLastExchange();

    // Step 4: Send the user's actual message
    log("Setting user's real message:", userMessage.slice(0, 60));
    adapter.setInputValue(userMessage);
    await new Promise((r) => setTimeout(r, 500));
    log("Sending user's real message...");
    adapter.triggerSend();

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

// --- Write-back: capture conversation to Reflect Memory ---

let lastWrittenText = "";

async function writeConversationToMemory(vendor) {
  if (!isWriteEnabled()) return;

  const text = document.body.innerText || "";
  if (text.length < 200) {
    log("writeBack: page text too short:", text.length);
    return;
  }

  const lines = text.split("\n").filter((l) => l.trim().length > 5);
  const clean = lines.filter((l) => {
    const lower = l.toLowerCase();
    if (lower.includes("returning user") && lower.includes("shared memory")) return false;
    if (lower.includes("pulled memories from reflect") && l.length < 200) return false;
    if (lower.includes("claude is ai and can make mistakes")) return false;
    if (lower.includes("free plan") && l.length < 30) return false;
    if (lower.includes("sonnet") && l.length < 30) return false;
    if (l.trim() === "Reply..." || l.trim() === "Reply") return false;
    return true;
  });

  const content = clean.join("\n").trim();
  if (content.length < 200) {
    log("writeBack: cleaned text too short:", content.length);
    return;
  }

  if (content === lastWrittenText) return;

  const titleLine = clean.find((l) => l.length > 20 && l.length < 120) || clean[0] || "Conversation";
  const title = `${vendor} -- ${titleLine.slice(0, 80).replace(/\n/g, " ")}`;
  const snippet = content.slice(0, 1200);

  log("writeBack: writing memory. Title:", title.slice(0, 60), "Length:", snippet.length);
  const result = await sendToBackground({
    type: "WRITE_MEMORY",
    data: {
      title,
      content: snippet,
      tags: ["auto_captured", vendor.toLowerCase()],
    },
  });

  if (result?.id) {
    lastWrittenText = content;
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

  // Write-back observer: fires 8 seconds after the last DOM change
  let writeTimer = null;
  let lastLen = 0;
  const writeObserver = new MutationObserver(() => {
    if (isPriming || !isWriteEnabled()) return;

    const len = document.body.innerText?.length || 0;
    if (len === lastLen) return;
    lastLen = len;

    clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeConversationToMemory(vendorName);
    }, 8000);
  });
  writeObserver.observe(document.body, { childList: true, subtree: true });
}
