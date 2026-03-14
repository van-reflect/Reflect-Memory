/**
 * ChatGPT content script adapter.
 *
 * NOTE: ChatGPT already has full API integration via the Custom GPT
 * with the isConsequential fix. This content script provides the
 * invisible priming experience for users on regular chatgpt.com
 * who haven't set up the Custom GPT.
 */

(() => {
  const VENDOR = "ChatGPT";

  const adapter = {
    getInputElement() {
      return document.querySelector("#prompt-textarea, textarea[data-id]");
    },

    getInputValue() {
      const el = this.getInputElement();
      if (!el) return "";
      return el.innerText || el.value || "";
    },

    setInputValue(text) {
      const el = this.getInputElement();
      if (!el) return;
      if (el.tagName === "TEXTAREA") {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype, "value"
        )?.set;
        if (setter) setter.call(el, text);
        else el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        el.focus();
        el.innerText = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    },

    getMessages() {
      const messages = [];
      const els = document.querySelectorAll("[data-message-author-role]");
      els.forEach((el) => {
        const role = el.getAttribute("data-message-author-role");
        const text = el.innerText?.trim();
        if (text && (role === "user" || role === "assistant")) {
          messages.push({ role, text });
        }
      });
      return messages;
    },

    isNewConversation() {
      return this.getMessages().length === 0;
    },

    triggerSend() {
      const btn = document.querySelector(
        "[data-testid='send-button'], button[aria-label='Send prompt']"
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
      const allMsgs = document.querySelectorAll("[data-message-author-role]");
      const toHide = [...allMsgs].slice(-2);
      toHide.forEach((el) => {
        const container = el.closest("[data-testid^='conversation-turn']") || el.parentElement;
        if (container) container.style.display = "none";
      });
    },

    onNewMessage(callback) {
      const container = document.querySelector("main") || document.body;
      const observer = new MutationObserver(() => {
        const messages = this.getMessages();
        if (messages.length > 0) callback(messages);
      });
      observer.observe(container, { childList: true, subtree: true });
    },
  };

  initVendor(adapter, VENDOR);
})();
