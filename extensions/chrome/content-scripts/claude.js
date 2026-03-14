/**
 * Claude content script adapter for Reflect Memory.
 *
 * Tested against Claude's DOM as of March 2026.
 * Input: ProseMirror contenteditable div
 * Send: button[aria-label*='Send']
 * Hide: skip for now (priming visible but functional)
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
      return [];
    },

    isNewConversation() {
      const url = window.location.pathname;
      return url === "/new" || url === "/" || url.endsWith("/new");
    },

    triggerSend() {
      const sendBtn = document.querySelector("button[aria-label*='Send' i]");
      if (sendBtn && !sendBtn.disabled) {
        log("triggerSend: clicking send button");
        sendBtn.click();
        return;
      }

      log("triggerSend: send button not found or disabled, retrying in 500ms...");
      setTimeout(() => {
        const retry = document.querySelector("button[aria-label*='Send' i]");
        if (retry && !retry.disabled) {
          log("triggerSend: retry found send button");
          retry.click();
        } else {
          log("triggerSend: still no send button. User must press Enter.");
        }
      }, 500);
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
