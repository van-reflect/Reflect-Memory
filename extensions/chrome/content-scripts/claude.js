/**
 * Claude content script adapter for Reflect Memory.
 *
 * Tested against Claude's DOM as of March 2026.
 * Input: ProseMirror contenteditable div
 * Send: button[aria-label*='Send']
 */

(() => {
  const VENDOR = "Claude";

  const adapter = {
    getInputElement() {
      return (
        document.querySelector("[contenteditable='true'].ProseMirror") ||
        document.querySelector("div.ProseMirror[contenteditable]") ||
        document.querySelector("div[contenteditable='true'][data-placeholder]") ||
        document.querySelector("div[contenteditable='true'][role='textbox']") ||
        document.querySelector("fieldset [contenteditable='true']") ||
        document.querySelector("form [contenteditable='true']") ||
        document.querySelector("textarea[placeholder*='Reply' i]") ||
        document.querySelector("textarea[placeholder*='help' i]") ||
        document.querySelector("textarea[placeholder*='message' i]") ||
        document.querySelector("fieldset textarea") ||
        document.querySelector("form textarea")
      );
    },

    getInputValue() {
      const el = this.getInputElement();
      if (!el) return "";
      if (el.tagName === "TEXTAREA") return el.value || "";
      return el.innerText || el.textContent || "";
    },

    setInputValue(text) {
      const el = this.getInputElement();
      if (!el) return;
      el.focus();

      if (el.tagName === "TEXTAREA") {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype, "value"
        )?.set;
        if (nativeSetter) nativeSetter.call(el, text);
        else el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }

      el.innerHTML = "";
      const p = document.createElement("p");
      p.textContent = text;
      el.appendChild(p);

      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },

    getMessages() {
      const turns = [];
      const container = document.querySelector("main") || document.body;

      const humanBlocks = container.querySelectorAll(
        "[data-testid='user-message'], [class*='human-turn'], [class*='user-turn']"
      );
      const aiBlocks = container.querySelectorAll(
        "[data-testid='ai-message'], [class*='assistant-turn'], [class*='ai-turn']"
      );

      if (humanBlocks.length === 0 && aiBlocks.length === 0) {
        const groups = container.querySelectorAll("[class*='group']");
        for (const g of groups) {
          const text = g.innerText?.trim();
          if (!text || text.length < 15) continue;
          const isHuman = g.querySelector("[class*='human']") ||
            g.querySelector("[data-testid*='user']") ||
            g.querySelector("[class*='user-message']");
          turns.push({ role: isHuman ? "user" : "assistant", text });
        }
        return turns;
      }

      const all = [
        ...[...humanBlocks].map((el) => ({ el, role: "user" })),
        ...[...aiBlocks].map((el) => ({ el, role: "assistant" })),
      ].sort((a, b) => {
        const pos = a.el.compareDocumentPosition(b.el);
        return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });

      for (const { el, role } of all) {
        const text = el.innerText?.trim();
        if (text && text.length >= 15) {
          turns.push({ role, text });
        }
      }

      return turns;
    },

    isNewConversation() {
      const url = window.location.pathname;
      return url === "/new" || url === "/" || url.endsWith("/new");
    },

    triggerSend() {
      const sendBtn = document.querySelector("button[aria-label*='Send' i]");
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
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
      log("hideLastExchange: skipping (priming content remains visible)");
    },

    onNewMessage(callback) {
      const observer = new MutationObserver(() => {
        callback([]);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    },
  };

  initVendor(adapter, VENDOR);
})();
