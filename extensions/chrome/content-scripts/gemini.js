/**
 * Gemini content script adapter.
 *
 * Gemini uses a rich text input area and renders conversation
 * in message-content containers with model/user attribution.
 */

(() => {
  const VENDOR = "Gemini";

  const adapter = {
    getInputElement() {
      return document.querySelector(
        ".ql-editor[contenteditable='true'], " +
        "div[contenteditable='true'][aria-label*='prompt'], " +
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
        "message-content, .conversation-container .message"
      );

      turns.forEach((el) => {
        const isUser =
          el.closest("[data-message-author='user']") ||
          el.closest(".user-message") ||
          el.querySelector(".query-text");
        const text = el.innerText?.trim();
        if (text) {
          messages.push({
            role: isUser ? "user" : "assistant",
            text,
          });
        }
      });

      return messages;
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
