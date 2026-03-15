/**
 * Perplexity content script adapter.
 *
 * Perplexity uses textarea#ask-input or div#ask-input[contenteditable] for input.
 * Submit button is button[aria-label="Submit"].
 * Selectors sourced from the perplexity-web-mcp-extension project.
 */

(() => {
  const VENDOR = "Perplexity";

  const adapter = {
    useInlinePriming: true,

    getInputElement() {
      return document.querySelector("textarea#ask-input") ||
        document.querySelector('div#ask-input[contenteditable="true"]') ||
        document.querySelector("textarea[placeholder*='ask' i], textarea[placeholder*='search' i], textarea[placeholder*='follow' i]");
    },

    getInputValue() {
      const el = this.getInputElement();
      if (!el) return "";
      if (el.tagName === "TEXTAREA") return el.value || "";
      return el.innerText || "";
    },

    setInputValue(text) {
      const el = this.getInputElement();
      if (!el) return;

      el.focus();

      if (el.tagName === "TEXTAREA") {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, "value"
        )?.set;
        if (nativeSetter) {
          nativeSetter.call(el, text);
        } else {
          el.value = text;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        el.innerText = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    },

    getMessages() {
      const messages = [];
      const queryEls = document.querySelectorAll(
        ".group\\/query, [class*='query'], [data-testid*='query']"
      );
      const answerEls = document.querySelectorAll(
        ".pb-md .prose, [class*='answer'], [data-testid*='answer']"
      );
      queryEls.forEach((el) => {
        const text = el.innerText?.trim();
        if (text && text.length > 5) messages.push({ role: "user", text });
      });
      answerEls.forEach((el) => {
        const text = el.innerText?.trim();
        if (text && text.length > 30) {
          messages.push({ role: "assistant", text });
        }
      });
      return messages;
    },

    isNewConversation() {
      const path = window.location.pathname;
      if (path === "/" || path === "/search" || path === "/home" || path.endsWith("/new")) return true;
      return this.getMessages().length === 0;
    },

    triggerSend() {
      const btn = document.querySelector('button[aria-label="Submit"]');
      if (btn && !btn.disabled) {
        btn.click();
        return;
      }
      const el = this.getInputElement();
      if (el) {
        el.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13,
          bubbles: true, cancelable: true,
        }));
      }
    },

    hideLastExchange() {
      const queryEls = document.querySelectorAll(".group\\/query, [class*='query']");
      const answerEls = document.querySelectorAll(".pb-md, [class*='answer']");
      const lastQuery = queryEls[queryEls.length - 1];
      const lastAnswer = answerEls[answerEls.length - 1];
      if (lastQuery) {
        const container = lastQuery.closest("[class*='result']") || lastQuery.parentElement;
        if (container) container.style.display = "none";
      }
      if (lastAnswer) {
        const container = lastAnswer.closest("[class*='result']") || lastAnswer.parentElement;
        if (container) container.style.display = "none";
      }
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
