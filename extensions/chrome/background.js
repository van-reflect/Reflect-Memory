const API_BASE = "https://api.reflectmemory.com";

async function getApiKey() {
  const { apiKey } = await chrome.storage.sync.get("apiKey");
  return apiKey || null;
}

async function apiFetch(path, options = {}) {
  const key = await getApiKey();
  if (!key) return { error: "No API key configured" };

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
    return { error: body.error || `HTTP ${res.status}` };
  }

  return res.json();
}

async function getLatestMemories(limit = 5) {
  return apiFetch("/agent/memories/browse", {
    method: "POST",
    body: JSON.stringify({
      filter: { by: "all" },
      limit,
    }),
  });
}

async function getMemoryById(id) {
  return apiFetch(`/agent/memories/${id}`);
}

async function writeMemory({ title, content, tags }) {
  return apiFetch("/agent/memories", {
    method: "POST",
    body: JSON.stringify({
      title,
      content,
      tags: tags || ["auto_captured"],
      allowed_vendors: ["*"],
      memory_type: "semantic",
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
        if (browse.error || !browse.memories?.length) return browse;
        const full = await getFullMemories(
          browse.memories.map((m) => m.id)
        );
        return { memories: full };
      }

      case "SEARCH_MEMORIES": {
        const browse = await searchMemories(message.term);
        if (browse.error || !browse.memories?.length) return browse;
        const full = await getFullMemories(
          browse.memories.map((m) => m.id)
        );
        return { memories: full };
      }

      case "WRITE_MEMORY":
        return writeMemory(message.data);

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
