/**
 * Perplexity content script adapter.
 *
 * Perplexity uses a textarea for input and renders answers
 * in structured response containers with source citations.
 */

(() => {
  const VENDOR = "Perplexity";

  const adapter = {
    getInputElement() {
      return document.querySelector(
        "textarea[placeholder], " +
        "textarea[aria-label], " +
        "div[contenteditable='true'][role='textbox']"
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
        const nativeSet = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        )?.set;
        if (nativeSet) {
          nativeSet.call(el, text);
        } else {
          el.value = text;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        el.focus();
        el.innerText = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    },

    getMessages() {
      const messages = [];

      const queryEls = document.querySelectorAll(
        "[class*='query'], .prose.dark\\:prose-invert h2, [data-testid*='query']"
      );
      const answerEls = document.querySelectorAll(
        "[class*='answer'], .prose.dark\\:prose-invert > div, [data-testid*='answer']"
      );

      queryEls.forEach((el) => {
        const text = el.innerText?.trim();
        if (text) messages.push({ role: "user", text });
      });

      answerEls.forEach((el) => {
        const text = el.innerText?.trim();
        if (text && text.length > 20) {
          messages.push({ role: "assistant", text });
        }
      });

      return messages;
    },

    onNewMessage(callback) {
      const container =
        document.querySelector("[class*='thread']") ||
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
