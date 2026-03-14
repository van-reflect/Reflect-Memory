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
let lastCapturedCount = 0;

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
    "",
    PRIMING_MARKER,
  ].join("\n");
}

function getSessionKey(suffix) {
  return `${suffix}_${window.location.pathname}`;
}

function isAlreadyPrimed() {
  return sessionStorage.getItem(getSessionKey(PRIMED_KEY)) === "true";
}

function markAsPrimed() {
  sessionStorage.setItem(getSessionKey(PRIMED_KEY), "true");
}

function isWriteEnabled() {
  return sessionStorage.getItem(getSessionKey(WRITE_ENABLED_KEY)) === "true";
}

function enableWrite() {
  sessionStorage.setItem(getSessionKey(WRITE_ENABLED_KEY), "true");
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

  try {
    const searchTerm = userMessage.slice(0, 200);
    log("Searching memories for:", searchTerm);
    const response = await sendToBackground({
      type: "SEARCH_MEMORIES",
      term: searchTerm,
    });

    log("Search result:", response?.memories?.length || 0, "memories found");

    if (!response?.memories?.length) {
      isPriming = false;
      markAsPrimed();
      return false;
    }

    const primingText = formatMemoriesForPriming(response.memories);
    if (!primingText) {
      isPriming = false;
      markAsPrimed();
      return false;
    }

    log("Setting priming text...");
    adapter.setInputValue(primingText);
    await new Promise((r) => setTimeout(r, 200));

    log("Sending priming message...");
    adapter.triggerSend();

    log("Waiting for AI response...");
    await waitForResponse(adapter);

    log("Hiding priming exchange...");
    adapter.hideLastExchange();
    markAsPrimed();
    enableWrite();

    log("Sending user's real message:", userMessage.slice(0, 50));
    adapter.setInputValue(userMessage);
    await new Promise((r) => setTimeout(r, 200));
    adapter.triggerSend();

    log("Priming complete.");
  } catch (err) {
    log("Error during priming:", err);
    adapter.setInputValue(userMessage);
    await new Promise((r) => setTimeout(r, 50));
    adapter.triggerSend();
    markAsPrimed();
  }

  isPriming = false;
  return true;
}

function waitForResponse(adapter) {
  return new Promise((resolve) => {
    const startCount = adapter.getMessages().length;
    let checks = 0;
    const maxChecks = 30;

    const interval = setInterval(() => {
      checks++;
      const current = adapter.getMessages();
      const hasResponse = current.length >= startCount + 2;

      if (hasResponse || checks >= maxChecks) {
        clearInterval(interval);
        log("Response wait done. Checks:", checks, "Messages:", current.length);
        setTimeout(resolve, 300);
      }
    }, 500);
  });
}

function isPrimingMessage(text) {
  return text?.includes(PRIMING_MARKER);
}

function isReadyResponse(text) {
  const lower = text?.trim().toLowerCase() || "";
  return lower === "ready" ||
    lower === "ready." ||
    lower.startsWith("pulled memories from reflect");
}

async function captureAsMemory(messages, vendor) {
  if (!isWriteEnabled()) return;
  if (!messages?.length) return;

  const filtered = messages.filter(
    (m) => !isPrimingMessage(m.text) && !isReadyResponse(m.text)
  );
  if (filtered.length <= lastCapturedCount) return;

  const recent = filtered.slice(-4);
  const userMsgs = recent.filter((m) => m.role === "user");
  const aiMsgs = recent.filter((m) => m.role === "assistant");

  if (!userMsgs.length || !aiMsgs.length) return;

  const lastUser = userMsgs[userMsgs.length - 1].text;
  const lastAI = aiMsgs[aiMsgs.length - 1].text;

  if (lastUser.length < 20 || lastAI.length < 50) return;

  lastCapturedCount = filtered.length;

  const title = lastUser.slice(0, 80).replace(/\n/g, " ");
  const content = [
    `User: ${lastUser.slice(0, 400)}`,
    `Response: ${lastAI.slice(0, 600)}`,
  ].join("\n\n");

  log("Writing memory:", title);
  await sendToBackground({
    type: "WRITE_MEMORY",
    data: {
      title: `${vendor} -- ${title}`,
      content,
      tags: ["auto_captured", vendor.toLowerCase()],
    },
  });
}

function initVendor(adapter, vendorName) {
  log(`Initializing ${vendorName} adapter...`);
  let debounceTimer = null;
  let sendIntercepted = false;

  function hookSendInterception() {
    const el = adapter.getInputElement();
    if (!el) {
      log("Input element NOT found. Selectors need updating.");
      log("Scanning page for contenteditable elements...");
      const allEditable = document.querySelectorAll("[contenteditable='true']");
      log(`Found ${allEditable.length} contenteditable elements:`);
      allEditable.forEach((e, i) => {
        log(`  [${i}] tag=${e.tagName} class="${e.className.slice(0, 80)}" role=${e.getAttribute("role")} placeholder=${e.getAttribute("data-placeholder") || e.getAttribute("aria-placeholder")}`);
      });
      const allTextareas = document.querySelectorAll("textarea");
      log(`Found ${allTextareas.length} textarea elements:`);
      allTextareas.forEach((e, i) => {
        log(`  [${i}] placeholder="${e.placeholder?.slice(0, 50)}" name=${e.name}`);
      });
      return;
    }
    if (sendIntercepted) return;
    sendIntercepted = true;

    log("Input element found:", el.tagName, el.className?.slice(0, 60));
    log("Keydown listener attached. Waiting for first Enter press.");

    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      if (isPriming) return;
      if (isAlreadyPrimed()) return;

      const userMessage = adapter.getInputValue()?.trim();
      if (!userMessage) return;

      log("Enter intercepted. Message:", userMessage.slice(0, 50));
      e.preventDefault();
      e.stopImmediatePropagation();

      interceptFirstMessage(adapter, userMessage).then((handled) => {
        if (!handled) {
          log("No priming needed. Sending original message.");
          adapter.setInputValue(userMessage);
          setTimeout(() => adapter.triggerSend(), 50);
        }
      });
    }, { capture: true });
  }

  const waitForInput = setInterval(() => {
    const el = adapter.getInputElement();
    if (el) {
      clearInterval(waitForInput);
      hookSendInterception();
    }
  }, 800);

  setTimeout(() => {
    clearInterval(waitForInput);
    if (!sendIntercepted) {
      log("TIMEOUT: Input element never found after 30s. Running diagnostic...");
      hookSendInterception();
    }
  }, 30000);

  const bodyObserver = new MutationObserver(() => {
    if (!sendIntercepted || !adapter.getInputElement()) {
      sendIntercepted = false;
      hookSendInterception();
    }
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });

  adapter.onNewMessage((messages) => {
    if (isPriming) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      captureAsMemory(messages, vendorName);
    }, 3000);
  });
}
