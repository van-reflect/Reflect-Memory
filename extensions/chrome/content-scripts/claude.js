/**
 * Claude content script adapter.
 *
 * Broadened selectors to handle Claude's evolving DOM structure.
 */

(() => {
  const VENDOR = "Claude";

  const adapter = {
    getInputElement() {
      return (
        document.querySelector("[contenteditable='true'].ProseMirror") ||
        document.querySelector("div[contenteditable='true'][data-placeholder]") ||
        document.querySelector("div[contenteditable='true'][role='textbox']") ||
        document.querySelector("div.ProseMirror[contenteditable]") ||
        document.querySelector("[contenteditable='true'][aria-label*='message' i]") ||
        document.querySelector("[contenteditable='true'][aria-label*='chat' i]") ||
        document.querySelector("[contenteditable='true'][aria-label*='Reply' i]") ||
        document.querySelector("fieldset [contenteditable='true']") ||
        document.querySelector("form [contenteditable='true']") ||
        document.querySelector("div[contenteditable='true']")
      );
    },

    getInputValue() {
      const el = this.getInputElement();
      if (!el) return "";
      return el.innerText || el.textContent || "";
    },

    setInputValue(text) {
      const el = this.getInputElement();
      if (!el) return;
      el.focus();

      // Clear existing content
      el.innerHTML = "";
      // Insert text as a paragraph (ProseMirror expects block elements)
      const p = document.createElement("p");
      p.textContent = text;
      el.appendChild(p);

      // Fire all events ProseMirror/React might listen for
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },

    getMessages() {
      const messages = [];

      // Try multiple selector strategies
      const strategies = [
        // Strategy 1: data-testid attributes
        () => {
          const humans = document.querySelectorAll("[data-testid='human-turn']");
          const ais = document.querySelectorAll("[data-testid='ai-turn']");
          humans.forEach((el) => messages.push({ role: "user", text: el.innerText?.trim() }));
          ais.forEach((el) => messages.push({ role: "assistant", text: el.innerText?.trim() }));
        },
        // Strategy 2: font-* classes
        () => {
          document.querySelectorAll(".font-user-message, .font-claude-message").forEach((el) => {
            const role = el.classList.contains("font-user-message") ? "user" : "assistant";
            messages.push({ role, text: el.innerText?.trim() });
          });
        },
        // Strategy 3: role-based or generic conversation containers
        () => {
          document.querySelectorAll("[data-is-streaming], [class*='human'], [class*='assistant']").forEach((el) => {
            const cls = el.className || "";
            const role = cls.includes("human") || cls.includes("user") ? "user" : "assistant";
            messages.push({ role, text: el.innerText?.trim() });
          });
        },
      ];

      for (const strategy of strategies) {
        strategy();
        if (messages.length > 0) break;
      }

      return messages.filter((m) => m.text);
    },

    isNewConversation() {
      return this.getMessages().length === 0;
    },

    triggerSend() {
      // Try multiple button selectors
      const btn =
        document.querySelector("button[aria-label='Send Message']") ||
        document.querySelector("button[aria-label='Send message']") ||
        document.querySelector("button[aria-label*='Send' i]") ||
        document.querySelector("button[data-testid='send-message']") ||
        document.querySelector("button[data-testid*='send' i]") ||
        document.querySelector("form button[type='submit']") ||
        // Last resort: find a button near the input that looks like send
        (() => {
          const input = this.getInputElement();
          if (!input) return null;
          const form = input.closest("form, fieldset, [role='form'], div[class*='composer'], div[class*='input']");
          if (!form) return null;
          const buttons = form.querySelectorAll("button");
          return [...buttons].find((b) =>
            b.querySelector("svg") && !b.disabled
          );
        })();

      if (btn) {
        log("Clicking send button:", btn.getAttribute("aria-label") || btn.className?.slice(0, 40));
        btn.click();
        return;
      }

      log("No send button found. Trying Enter keypress on input.");
      const el = this.getInputElement();
      if (el) {
        el.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13,
          bubbles: true, cancelable: true,
        }));
        el.dispatchEvent(new KeyboardEvent("keypress", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13,
          bubbles: true, cancelable: true,
        }));
        el.dispatchEvent(new KeyboardEvent("keyup", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13,
          bubbles: true, cancelable: true,
        }));
      }
    },

    hideLastExchange() {
      const allMessages = this.getMessages();
      if (allMessages.length < 2) return;

      // Find all turn containers and hide the last two
      const turnSelectors = [
        "[data-testid='human-turn'], [data-testid='ai-turn']",
        ".font-user-message, .font-claude-message",
        "[class*='human'], [class*='assistant']",
      ];

      for (const selector of turnSelectors) {
        const turns = document.querySelectorAll(selector);
        if (turns.length >= 2) {
          const toHide = [...turns].slice(-2);
          toHide.forEach((el) => {
            const container = el.closest("[class*='turn']") ||
              el.closest("[class*='row']") ||
              el.parentElement;
            if (container) container.style.display = "none";
          });
          break;
        }
      }
    },

    onNewMessage(callback) {
      const container =
        document.querySelector("[data-testid='conversation']") ||
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
