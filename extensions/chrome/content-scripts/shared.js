/**
 * Shared core for Reflect Memory browser extension.
 *
 * Architecture: "Priming Message" approach.
 *
 * Instead of injecting context into the user's prompt (visible, hacky),
 * we send an invisible priming message at the start of each new
 * conversation. The AI receives the user's memory context as the first
 * exchange in the conversation history. By the time the user types
 * their first real message, the AI already knows their context.
 *
 * The priming message + AI response are visually hidden by the
 * extension so the user never sees them. The AI genuinely "already
 * knows" because the context lives in the conversation history.
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
    "Respond to this setup message with only: 'Ready'",
    "",
    "---",
    "",
    ...blocks,
    "",
    PRIMING_MARKER,
  ].join("\n");
}

function getSessionKey() {
  return `${PRIMED_KEY}_${window.location.pathname}`;
}

function isAlreadyPrimed() {
  return sessionStorage.getItem(getSessionKey()) === "true";
}

function markAsPrimed() {
  sessionStorage.setItem(getSessionKey(), "true");
}

async function primeConversation(adapter) {
  if (isPriming || isAlreadyPrimed()) return;
  if (!adapter.isNewConversation()) {
    markAsPrimed();
    return;
  }

  const authCheck = await sendToBackground({ type: "CHECK_AUTH" });
  if (!authCheck?.authenticated) return;

  isPriming = true;

  try {
    const response = await sendToBackground({
      type: "GET_MEMORIES",
      limit: 10,
    });

    if (!response?.memories?.length) {
      isPriming = false;
      markAsPrimed();
      return;
    }

    const primingText = formatMemoriesForPriming(response.memories);
    if (!primingText) {
      isPriming = false;
      markAsPrimed();
      return;
    }

    adapter.setInputValue(primingText);

    await new Promise((r) => setTimeout(r, 100));

    adapter.triggerSend();

    await waitForResponse(adapter);

    adapter.hideLastExchange();

    markAsPrimed();
  } catch {
    // Silently fail -- never disrupt the user
  }

  isPriming = false;
}

function waitForResponse(adapter) {
  return new Promise((resolve) => {
    const startCount = adapter.getMessages().length;
    let checks = 0;
    const maxChecks = 60;

    const interval = setInterval(() => {
      checks++;
      const current = adapter.getMessages();
      const hasResponse = current.length >= startCount + 2;

      if (hasResponse || checks >= maxChecks) {
        clearInterval(interval);
        setTimeout(resolve, 500);
      }
    }, 500);
  });
}

function isPrimingMessage(text) {
  return text?.includes(PRIMING_MARKER);
}

async function captureAsMemory(messages, vendor) {
  if (!messages?.length) return;

  const filtered = messages.filter((m) => !isPrimingMessage(m.text));
  if (filtered.length <= lastCapturedCount) return;

  const recent = filtered.slice(-4);
  const userMsgs = recent.filter((m) => m.role === "user");
  const aiMsgs = recent.filter((m) => m.role === "assistant");

  if (!userMsgs.length || !aiMsgs.length) return;

  const lastUser = userMsgs[userMsgs.length - 1].text;
  const lastAI = aiMsgs[aiMsgs.length - 1].text;

  if (lastUser.length < 20 || lastAI.length < 50) return;
  if (lastAI.trim().toLowerCase() === "ready") return;

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

  const waitAndPrime = setInterval(() => {
    if (adapter.getInputElement()) {
      clearInterval(waitAndPrime);
      primeConversation(adapter);
    }
  }, 800);

  setTimeout(() => clearInterval(waitAndPrime), 30000);

  adapter.onNewMessage((messages) => {
    if (isPriming) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      captureAsMemory(messages, vendorName);
    }, 3000);
  });
}
