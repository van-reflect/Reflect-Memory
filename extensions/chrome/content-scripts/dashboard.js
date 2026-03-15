(async function autoConnect() {
  const { apiKey } = await chrome.storage.sync.get("apiKey");
  if (apiKey) return;

  const { autoConnectAttempt } = await chrome.storage.local.get("autoConnectAttempt");
  const ONE_HOUR = 3_600_000;
  if (autoConnectAttempt && Date.now() - autoConnectAttempt < ONE_HOUR) return;

  await chrome.storage.local.set({ autoConnectAttempt: Date.now() });

  try {
    const res = await fetch("/api/extension-key", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });

    if (!res.ok) return;

    const { key } = await res.json();
    if (!key) return;

    await chrome.storage.sync.set({ apiKey: key, verified: true, vendor: "extension" });
    await chrome.storage.local.remove("autoConnectAttempt");
  } catch {
    // Silently fail -- user isn't logged in or network issue
  }
})();
