/**
 * Perplexity content script adapter.
 *
 * Perplexity uses a textarea for input and renders answers
 * in structured response containers with source citations.
 */

(() => {
  const VENDOR = "Perplexity";

  const adapter = {
    useInlinePriming: true,

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
      const queryEls = document.querySelectorAll(
        "[class*='query'], .prose h2, [data-testid*='query']"
      );
      const answerEls = document.querySelectorAll(
        "[class*='answer'], .prose > div, [data-testid*='answer']"
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

    isNewConversation() {
      const path = window.location.pathname;
      if (path === "/" || path === "/search" || path.endsWith("/new")) return true;
      return this.getMessages().length === 0;
    },

    triggerSend() {
      const btn = document.querySelector(
        "button[aria-label='Submit'], " +
        "button[aria-label='Ask'], " +
        "button[data-testid='ask-button']"
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
      const allEls = document.querySelectorAll(
        "[class*='query'], [class*='answer'], .prose h2, .prose > div"
      );
      const toHide = [...allEls].slice(-2);
      toHide.forEach((el) => {
        const container = el.closest("[class*='result']") || el.parentElement;
        if (container) container.style.display = "none";
      });
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
