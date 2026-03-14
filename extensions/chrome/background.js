const API_BASE = "https://api.reflectmemory.com";

async function getApiKey() {
  const { apiKey } = await chrome.storage.sync.get("apiKey");
  return apiKey || null;
}

async function apiFetch(path, options = {}) {
  const key = await getApiKey();
  if (!key) return { error: "No API key configured" };

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.log("[Reflect BG] API error:", path, res.status, JSON.stringify(body));
      return { error: body.error || `HTTP ${res.status}` };
    }

    return res.json();
  } catch (err) {
    console.log("[Reflect BG] API fetch exception:", path, err.message);
    return { error: `Network error: ${err.message}` };
  }
}

async function getLatestMemories(limit = 5) {
  const result = await apiFetch("/agent/memories/browse", {
    method: "POST",
    body: JSON.stringify({
      filter: { by: "all" },
      limit,
    }),
  });
  console.log("[Reflect BG] getLatestMemories:", JSON.stringify({
    total: result?.total,
    count: result?.memories?.length,
    error: result?.error,
  }));
  return result;
}

async function getMemoryById(id) {
  return apiFetch(`/agent/memories/${id}`);
}

async function writeMemory({ title, content, tags, origin }) {
  return apiFetch("/agent/memories", {
    method: "POST",
    body: JSON.stringify({
      title,
      content,
      tags: tags || ["auto_captured"],
      allowed_vendors: ["*"],
      memory_type: "semantic",
      origin: origin || "user",
    }),
  });
}

async function searchMemories(term) {
  const result = await apiFetch("/agent/memories/browse", {
    method: "POST",
    body: JSON.stringify({
      filter: { by: "search", term },
      limit: 10,
    }),
  });
  console.log("[Reflect BG] Search for:", term, "=> total:", result?.total, "found:", result?.memories?.length);
  return result;
}

async function getFullMemories(ids) {
  const results = await Promise.all(ids.map((id) => getMemoryById(id)));
  return results.filter((r) => !r.error);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = async () => {
    switch (message.type) {
      case "GET_MEMORIES": {
        const browse = await getLatestMemories(message.limit || 5);
        console.log("[Reflect BG] GET_MEMORIES raw:", JSON.stringify(browse)?.slice(0, 300));
        if (browse.error || !browse.memories?.length) return browse;
        const full = await getFullMemories(
          browse.memories.map((m) => m.id)
        );
        console.log("[Reflect BG] GET_MEMORIES full:", full.length, "memories fetched");
        return { memories: full };
      }

      case "SEARCH_MEMORIES": {
        const browse = await searchMemories(message.term);
        console.log("[Reflect BG] SEARCH_MEMORIES raw:", JSON.stringify(browse)?.slice(0, 300));
        if (browse.error || !browse.memories?.length) return browse;
        const full = await getFullMemories(
          browse.memories.map((m) => m.id)
        );
        return { memories: full };
      }

      case "WRITE_MEMORY":
        return writeMemory(message.data);

      case "SUMMARIZE_AND_WRITE": {
        const { conversation, vendor } = message;
        const summaryPrompt = [
          "You are a memory extraction system. Read this conversation between a user and an AI assistant.",
          "Extract ONLY the important context that would help another AI understand this user in future conversations.",
          "",
          "Write a concise memory entry covering:",
          "- Decisions the user made or directions they chose",
          "- User preferences, opinions, or working style revealed",
          "- Key facts about their project, product, or situation",
          "- Action items or next steps they committed to",
          "",
          "Do NOT include:",
          "- Greetings, small talk, or filler",
          "- The AI's general advice (only capture if the user agreed with it)",
          "- Raw conversation back-and-forth",
          "",
          "Format: Start with a one-line title summarizing the core topic.",
          "Then write 2-6 bullet points of key context. Be specific and factual.",
          "Write as if noting what matters about this user for future reference.",
          "",
          "--- CONVERSATION ---",
          conversation.slice(0, 6000),
        ].join("\n");

        try {
          const chatResult = await apiFetch("/chat", {
            method: "POST",
            body: JSON.stringify({
              model: "gpt-4o-mini",
              messages: [{ role: "user", content: summaryPrompt }],
            }),
          });

          const summary = chatResult?.response;

          if (!summary || summary.length < 30) {
            console.log("[Reflect BG] Summary too short or missing:", JSON.stringify(chatResult)?.slice(0, 300));
            return { error: "Summary generation failed" };
          }

          const lines = summary.split("\n").filter((l) => l.trim());
          const title = `${vendor} -- ${(lines[0] || "Conversation").replace(/^#+\s*/, "").slice(0, 100)}`;
          const content = summary;

          console.log("[Reflect BG] Writing summarized memory:", title.slice(0, 60));
          return writeMemory({
            title,
            content,
            tags: ["auto_captured", vendor.toLowerCase()],
            origin: vendor.toLowerCase(),
          });
        } catch (err) {
          console.log("[Reflect BG] Summarize failed:", err.message);
          return { error: err.message };
        }
      }

      case "CHECK_AUTH": {
        const key = await getApiKey();
        if (!key) return { authenticated: false };
        const whoami = await apiFetch("/whoami");
        return { authenticated: !whoami.error, vendor: whoami.vendor };
      }

      default:
        return { error: "Unknown message type" };
    }
  };

  handler().then(sendResponse);
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get("apiKey", ({ apiKey }) => {
    if (!apiKey) {
      chrome.action.setBadgeText({ text: "!" });
      chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    }
  });
});
