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
