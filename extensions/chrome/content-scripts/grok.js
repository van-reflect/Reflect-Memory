/**
 * Grok content script adapter.
 *
 * Grok (grok.com) uses a textarea or contenteditable for input
 * and renders messages in a conversation thread.
 */

(() => {
  const VENDOR = "Grok";

  const adapter = {
    getInputElement() {
      return document.querySelector(
        "textarea[placeholder], " +
        "div[contenteditable='true'][role='textbox'], " +
        "div[contenteditable='true'][data-placeholder]"
      );
    },

    getInputValue() {
      const el = this.getInputElement();
      if (!el) return "";
      return el.value || el.innerText || "";
    },

    setInputValue(text) {
      const el = this.getInputElement();
      if (!el) return;
      if (el.tagName === "TEXTAREA") {
        el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        el.focus();
        el.innerText = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    },

    getMessages() {
      const messages = [];

      const turns = document.querySelectorAll(
        "[class*='message'], [class*='turn'], [data-role]"
      );

      turns.forEach((el) => {
        const role = el.getAttribute("data-role");
        const isUser =
          role === "user" ||
          el.classList.toString().includes("user") ||
          el.querySelector("[class*='user']");
        const text = el.innerText?.trim();
        if (text && text.length > 2) {
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
        document.querySelector("[class*='conversation']") ||
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
