/**
 * ChatGPT content script adapter.
 *
 * ChatGPT uses a contenteditable div (#prompt-textarea) for input
 * and renders messages in [data-message-author-role] elements.
 *
 * NOTE: ChatGPT already has full API integration via the Custom GPT
 * with the isConsequential fix. This content script is a fallback
 * for users who haven't set up the Custom GPT, providing passive
 * memory capture from regular ChatGPT conversations.
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
        el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
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

    onNewMessage(callback) {
      const container =
        document.querySelector("main") || document.body;

      const observer = new MutationObserver(() => {
        const messages = this.getMessages();
        if (messages.length > 0) callback(messages);
      });

      observer.observe(container, {
        childList: true,
        subtree: true,
      });
    },
  };

  initVendor(adapter, VENDOR);
})();
