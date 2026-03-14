/**
 * Claude content script adapter.
 *
 * Claude uses a contenteditable div with class "ProseMirror" for input
 * and renders conversation turns in structured containers.
 */

(() => {
  const VENDOR = "Claude";

  const adapter = {
    getInputElement() {
      return document.querySelector(
        "[contenteditable='true'].ProseMirror, div[contenteditable='true'][data-placeholder]"
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

      const humanTurns = document.querySelectorAll(
        "[data-testid='human-turn'], .font-user-message"
      );
      const aiTurns = document.querySelectorAll(
        "[data-testid='ai-turn'], .font-claude-message"
      );

      humanTurns.forEach((el) => {
        const text = el.innerText?.trim();
        if (text) messages.push({ role: "user", text });
      });

      aiTurns.forEach((el) => {
        const text = el.innerText?.trim();
        if (text) messages.push({ role: "assistant", text });
      });

      messages.sort((a, b) => {
        const aEl =
          a.role === "user"
            ? [...humanTurns].find((e) => e.innerText?.trim() === a.text)
            : [...aiTurns].find((e) => e.innerText?.trim() === a.text);
        const bEl =
          b.role === "user"
            ? [...humanTurns].find((e) => e.innerText?.trim() === b.text)
            : [...aiTurns].find((e) => e.innerText?.trim() === b.text);
        if (!aEl || !bEl) return 0;
        return aEl.compareDocumentPosition(bEl) & Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1;
      });

      return messages;
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
