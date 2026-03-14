/**
 * Shared utilities for all vendor content scripts.
 *
 * Each vendor script implements a VendorAdapter with:
 *   getInputElement()   - returns the chat textarea/contenteditable
 *   getInputValue()     - reads current user input text
 *   setInputValue(text) - sets the input text
 *   getMessages()       - returns array of { role: "user"|"assistant", text }
 *   onNewMessage(cb)    - calls cb(message) when a new message appears
 *   triggerSend()       - programmatically clicks the send button (optional)
 */

const REFLECT_ATTR = "data-reflect-memory";
const CONTEXT_PREFIX =
  "[The following context is from your Reflect Memory -- the user's shared memory across AI tools. Use it naturally without mentioning it unless asked.]\n\n";

let isInjecting = false;
let lastMessageCount = 0;

async function sendToBackground(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, resolve);
  });
}

function formatMemoriesAsContext(memories) {
  if (!memories?.length) return "";

  const blocks = memories.map((m) => {
    const tags = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
    return `- ${m.title}${tags}: ${m.content}`;
  });

  return CONTEXT_PREFIX + blocks.join("\n\n");
}

async function injectMemoryContext(adapter) {
  if (isInjecting) return;
  isInjecting = true;

  try {
    const currentInput = adapter.getInputValue();
    if (!currentInput?.trim()) {
      isInjecting = false;
      return;
    }

    const el = adapter.getInputElement();
    if (!el || el.getAttribute(REFLECT_ATTR) === "injected") {
      isInjecting = false;
      return;
    }

    const response = await sendToBackground({
      type: "SEARCH_MEMORIES",
      term: currentInput.slice(0, 200),
    });

    if (!response?.memories?.length) {
      isInjecting = false;
      return;
    }

    const context = formatMemoriesAsContext(response.memories);
    const enrichedInput = context + "\n\n" + currentInput;
    adapter.setInputValue(enrichedInput);
    el.setAttribute(REFLECT_ATTR, "injected");
  } catch {
    // Silently fail -- never interrupt the user
  }

  isInjecting = false;
}

async function captureAsMemory(messages, vendor) {
  if (!messages?.length) return;

  const recent = messages.slice(-4);
  const userMessages = recent.filter((m) => m.role === "user");
  const assistantMessages = recent.filter((m) => m.role === "assistant");

  if (!userMessages.length || !assistantMessages.length) return;

  const lastUser = userMessages[userMessages.length - 1].text;
  const lastAssistant = assistantMessages[assistantMessages.length - 1].text;

  if (
    lastUser.includes(CONTEXT_PREFIX.slice(0, 40)) ||
    lastUser.length < 20 ||
    lastAssistant.length < 50
  ) {
    return;
  }

  const title = lastUser.slice(0, 80).replace(/\n/g, " ");
  const content = [
    `User asked: ${lastUser.slice(0, 300)}`,
    `AI responded: ${lastAssistant.slice(0, 500)}`,
  ].join("\n\n");

  await sendToBackground({
    type: "WRITE_MEMORY",
    data: {
      title: `${vendor} conversation -- ${title}`,
      content,
      tags: ["auto_captured", vendor.toLowerCase()],
    },
  });
}

function initVendor(adapter, vendorName) {
  let debounceTimer = null;

  adapter.onNewMessage((messages) => {
    if (messages.length <= lastMessageCount) return;
    lastMessageCount = messages.length;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      captureAsMemory(messages, vendorName);
    }, 2000);
  });

  const input = adapter.getInputElement();
  if (input) {
    const observer = new MutationObserver(() => {
      input.removeAttribute(REFLECT_ATTR);
    });
    observer.observe(input, { childList: true, characterData: true, subtree: true });
  }

  const interceptSend = () => {
    const el = adapter.getInputElement();
    if (!el) return;

    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        if (el.getAttribute(REFLECT_ATTR) !== "injected") {
          e.preventDefault();
          e.stopPropagation();
          injectMemoryContext(adapter).then(() => {
            el.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Enter",
                code: "Enter",
                bubbles: true,
              })
            );
          });
        }
      }
    }, { capture: true, once: false });
  };

  const waitForInput = setInterval(() => {
    if (adapter.getInputElement()) {
      clearInterval(waitForInput);
      interceptSend();
    }
  }, 1000);

  setTimeout(() => clearInterval(waitForInput), 30000);
}
