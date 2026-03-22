/**
 * Grok content script adapter.
 *
 * Grok (grok.com / x.com/i/grok) uses contenteditable for input and
 * .message-bubble elements inside div.relative.group.flex.flex-col containers
 * for conversation turns. Grok responses contain .response-content-markdown.
 *
 * React-controlled inputs require execCommand('insertText') for state sync.
 */

(() => {
  const VENDOR = "Grok";

  const adapter = {
    getInputElement() {
      return (
        document.querySelector("div.absolute.bottom-0 [contenteditable='true']") ||
        document.querySelector("div.absolute.bottom-0 textarea") ||
        document.querySelector("[contenteditable='true'][role='textbox']") ||
        document.querySelector("[contenteditable='true'][data-placeholder]") ||
        document.querySelector("textarea[placeholder]")
      );
    },

    getInputValue() {
      const el = this.getInputElement();
      if (!el) return "";
      return el.tagName === "TEXTAREA"
        ? el.value || ""
        : el.innerText || "";
    },

    setInputValue(text) {
      const el = this.getInputElement();
      if (!el) return;

      el.focus();

      if (el.tagName === "TEXTAREA") {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype, "value"
        )?.set;
        if (setter) setter.call(el, text);
        else el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }

      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("insertText", false, text);
    },

    getMessages() {
      const messages = [];

      // Strategy 1: structured message boxes (current Grok DOM)
      const boxes = document.querySelectorAll("div.relative.group.flex.flex-col");
      for (const box of boxes) {
        const bubble = box.querySelector(".message-bubble");
        if (!bubble) continue;

        const clone = bubble.cloneNode(true);
        clone.querySelectorAll("svg, button, nav, header, footer, script, style, [aria-hidden='true']")
          .forEach((el) => el.remove());
        const text = clone.textContent?.trim();
        if (!text || text.length < 10) continue;

        const isGrok = !!bubble.querySelector(".response-content-markdown") ||
          bubble.className?.includes("bg-surface-l1") ||
          !!bubble.querySelector("[class*='bg-surface-l1']");

        messages.push({
          role: isGrok ? "assistant" : "user",
          text,
        });
      }

      if (messages.length > 0) return messages;

      // Strategy 2: fallback to .message-bubble directly
      const bubbles = document.querySelectorAll(".message-bubble");
      for (const bubble of bubbles) {
        const clone = bubble.cloneNode(true);
        clone.querySelectorAll("svg, button, nav, header, footer, script, style, [aria-hidden='true']")
          .forEach((el) => el.remove());
        const text = clone.textContent?.trim();
        if (!text || text.length < 10) continue;

        const isGrok = !!bubble.querySelector(".response-content-markdown") ||
          bubble.className?.includes("bg-surface-l1") ||
          !!bubble.querySelector("[class*='bg-surface-l1']");

        messages.push({
          role: isGrok ? "assistant" : "user",
          text,
        });
      }

      if (messages.length > 0) return messages;

      // Strategy 3: broadest fallback — dir="ltr" divs with substantial text
      const ltrDivs = document.querySelectorAll("div[dir='ltr']");
      for (const div of ltrDivs) {
        const text = div.textContent?.trim();
        if (!text || text.length < 15 || text.length > 50000) continue;
        messages.push({
          role: text.length > 300 ? "assistant" : "user",
          text,
        });
      }

      return messages;
    },

    isNewConversation() {
      const path = window.location.pathname;
      if (path === "/" || path === "/chat" || path.endsWith("/new")) return true;
      if (window.location.hostname === "x.com") {
        if (path === "/i/grok" || path === "/i/grok/") return true;
      }
      return this.getMessages().length === 0;
    },

    triggerSend() {
      const btn = document.querySelector(
        "button[aria-label*='send' i], " +
        "button[aria-label*='Send' i], " +
        "button[aria-label*='Submit' i], " +
        "button[data-testid='send-button'], " +
        "button[data-testid*='send']"
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
      const boxes = document.querySelectorAll("div.relative.group.flex.flex-col");
      const withBubble = [...boxes].filter((b) => b.querySelector(".message-bubble"));
      const toHide = withBubble.slice(-2);
      toHide.forEach((el) => {
        el.style.display = "none";
      });
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
