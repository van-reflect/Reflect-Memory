/**
 * Claude content script adapter.
 *
 * Claude uses a ProseMirror contenteditable for input and renders
 * conversation turns in structured containers.
 */

(() => {
  const VENDOR = "Claude";

  const adapter = {
    getInputElement() {
      return document.querySelector(
        "[contenteditable='true'].ProseMirror, " +
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
        "[data-testid='human-turn'], [data-testid='ai-turn'], " +
        ".font-user-message, .font-claude-message"
      );
      turns.forEach((el) => {
        const isUser =
          el.matches("[data-testid='human-turn']") ||
          el.matches(".font-user-message");
        const text = el.innerText?.trim();
        if (text) {
          messages.push({ role: isUser ? "user" : "assistant", text });
        }
      });
      return messages;
    },

    isNewConversation() {
      return this.getMessages().length === 0;
    },

    triggerSend() {
      const btn = document.querySelector(
        "button[aria-label='Send Message'], " +
        "button[data-testid='send-message']"
      );
      if (btn) {
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
        "[data-testid='human-turn'], [data-testid='ai-turn'], " +
        ".font-user-message, .font-claude-message"
      );
      const toHide = [...turns].slice(-2);
      toHide.forEach((el) => {
        const container = el.closest("[class*='turn']") || el.parentElement;
        if (container) container.style.display = "none";
      });
    },

    onNewMessage(callback) {
      const container =
        document.querySelector("[data-testid='conversation']") ||
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
