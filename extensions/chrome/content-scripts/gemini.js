/**
 * Gemini content script adapter.
 *
 * Gemini uses a rich text editor (Quill-based) for input and renders
 * conversation in message containers.
 */

(() => {
  const VENDOR = "Gemini";

  const adapter = {
    getInputElement() {
      return document.querySelector(
        ".ql-editor[contenteditable='true'], " +
        "div[contenteditable='true'][aria-label*='prompt' i], " +
        "div[contenteditable='true'][aria-label*='Enter' i], " +
        "div.input-area [contenteditable='true'], " +
        "rich-textarea [contenteditable='true'], " +
        "div[contenteditable='true'][data-placeholder]"
      );
    },

    getInputValue() {
      const el = this.getInputElement();
      if (!el) return "";
      return el.innerText || "";
    },

    setInputValue(text) {
      const el = this.getInputElement();
      if (!el) return;
      el.focus();
      el.innerText = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },

    getMessages() {
      const messages = [];
      const turns = document.querySelectorAll(
        "message-content, .conversation-container .message, " +
        "[data-message-author]"
      );
      turns.forEach((el) => {
        const isUser =
          el.closest("[data-message-author='user']") ||
          el.closest(".user-message") ||
          el.querySelector(".query-text");
        const text = el.innerText?.trim();
        if (text) {
          messages.push({ role: isUser ? "user" : "assistant", text });
        }
      });
      return messages;
    },

    isNewConversation() {
      const path = window.location.pathname;
      if (path === "/app" || path === "/" || path.endsWith("/new")) return true;
      return this.getMessages().length === 0;
    },

    triggerSend() {
      const btn = document.querySelector(
        "button[aria-label='Send message'], " +
        "button[aria-label*='Send' i], " +
        "button.send-button, " +
        "[data-test-id='send-button'], " +
        "button[mattooltip*='Send' i]"
      );
      if (btn && !btn.disabled) {
        btn.click();
        return;
      }
      const el = this.getInputElement();
      if (el) {
        el.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, bubbles: true,
        }));
      }
    },

    hideLastExchange() {
      const turns = document.querySelectorAll(
        "message-content, .conversation-container .message, " +
        "[data-message-author]"
      );
      const toHide = [...turns].slice(-2);
      toHide.forEach((el) => {
        const container = el.closest(".message-wrapper") || el.parentElement;
        if (container) container.style.display = "none";
      });
    },

    onNewMessage(callback) {
      const container =
        document.querySelector(".conversation-container") ||
        document.querySelector("main") ||
        document.body;
      const observer = new MutationObserver(() => {
        const messages = this.getMessages();
        if (messages.length > 0) callback(messages);
      });
      observer.observe(container, { childList: true, subtree: true });
    },
  };

  initVendor(adapter, VENDOR);
})();
