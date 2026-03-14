/**
 * Shared core for Reflect Memory browser extension.
 *
 * Architecture: "Lazy Priming" with selective write-back.
 *
 * READ: The extension waits for the user to submit their first message,
 * searches for relevant memories, and only if matches exist, sends a
 * hidden priming message before the user's real message. If nothing
 * is relevant, zero interference.
 *
 * WRITE: Only conversations where priming fired (meaning the topic is
 * related to stored context) have their exchanges captured back to
 * Reflect Memory. Unrelated conversations are never written.
 *
 * Each vendor script implements a VendorAdapter:
 *   getInputElement()      - returns the chat textarea/contenteditable
 *   getInputValue()        - reads current user input text
 *   setInputValue(text)    - sets the input text
 *   getMessages()          - returns [{ role, text }] from the DOM
 *   onNewMessage(cb)       - calls cb(messages) on DOM changes
 *   triggerSend()          - clicks the send button programmatically
 *   isNewConversation()    - true if the chat has zero messages
 *   hideLastExchange()     - hides the priming message + response from view
 */

const PRIMING_MARKER = "[[REFLECT_MEMORY_PRIME]]";
const PRIMED_KEY = "reflect_memory_primed";
const WRITE_ENABLED_KEY = "reflect_memory_write_enabled";

let isPriming = false;
let lastCapturedCount = 0;

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

/**
 * Intercepts the user's first message in a new conversation.
 * Searches for relevant memories. If found, primes the AI first,
 * then sends the user's real message. If not found, sends normally
 * and write-back stays disabled for this conversation.
 */
async function interceptFirstMessage(adapter, userMessage) {
  if (isPriming || isAlreadyPrimed()) return false;
  if (!adapter.isNewConversation()) {
    markAsPrimed();
    return false;
  }

  const authCheck = await sendToBackground({ type: "CHECK_AUTH" });
  if (!authCheck?.authenticated) {
    markAsPrimed();
    return false;
  }

  isPriming = true;

  try {
    const searchTerm = userMessage.slice(0, 200);
    const response = await sendToBackground({
      type: "SEARCH_MEMORIES",
      term: searchTerm,
    });

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

    adapter.setInputValue(primingText);
    await new Promise((r) => setTimeout(r, 100));
    adapter.triggerSend();

    await waitForResponse(adapter);
    adapter.hideLastExchange();
    markAsPrimed();
    enableWrite();

    adapter.setInputValue(userMessage);
    await new Promise((r) => setTimeout(r, 100));
    adapter.triggerSend();

  } catch {
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
  let debounceTimer = null;
  let sendIntercepted = false;

  function hookSendInterception() {
    const el = adapter.getInputElement();
    if (!el || sendIntercepted) return;
    sendIntercepted = true;

    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      if (isPriming) return;
      if (isAlreadyPrimed()) return;

      const userMessage = adapter.getInputValue()?.trim();
      if (!userMessage) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      interceptFirstMessage(adapter, userMessage).then((handled) => {
        if (!handled) {
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

  setTimeout(() => clearInterval(waitForInput), 30000);

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
