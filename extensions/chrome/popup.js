const statusEl = document.getElementById("status");
const setupEl = document.getElementById("setup");
const connectedEl = document.getElementById("connected");
const apiKeyInput = document.getElementById("apiKey");
const saveBtn = document.getElementById("saveBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const dashboardBtn = document.getElementById("dashboardBtn");
const memoryCountEl = document.getElementById("memoryCount");

async function checkStatus() {
  const { apiKey } = await chrome.storage.sync.get("apiKey");
  if (!apiKey) {
    showDisconnected();
    return;
  }

  apiKeyInput.value = apiKey;
  statusEl.textContent = "Verifying...";

  const response = await chrome.runtime.sendMessage({ type: "CHECK_AUTH" });
  if (response?.authenticated) {
    showConnected(response.vendor);
    loadMemoryCount();
  } else {
    showDisconnected("Invalid key");
  }
}

function showConnected(vendor) {
  statusEl.className = "status connected";
  statusEl.textContent = `Connected${vendor ? ` as ${vendor}` : ""}`;
  setupEl.style.display = "none";
  connectedEl.style.display = "block";
  chrome.action.setBadgeText({ text: "" });
}

function showDisconnected(reason) {
  statusEl.className = "status disconnected";
  statusEl.textContent = reason || "Not connected";
  setupEl.style.display = "block";
  connectedEl.style.display = "none";
}

async function loadMemoryCount() {
  const response = await chrome.runtime.sendMessage({
    type: "GET_MEMORIES",
    limit: 1,
  });
  if (response?.memories) {
    memoryCountEl.textContent = "Memory sync active";
  }
}

saveBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;

  saveBtn.textContent = "Connecting...";
  saveBtn.disabled = true;

  await chrome.storage.sync.set({ apiKey: key });

  const response = await chrome.runtime.sendMessage({ type: "CHECK_AUTH" });
  if (response?.authenticated) {
    showConnected(response.vendor);
    loadMemoryCount();
  } else {
    showDisconnected("Invalid key. Check your agent key.");
    await chrome.storage.sync.remove("apiKey");
  }

  saveBtn.textContent = "Connect";
  saveBtn.disabled = false;
});

disconnectBtn.addEventListener("click", async () => {
  await chrome.storage.sync.remove("apiKey");
  showDisconnected();
  apiKeyInput.value = "";
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
});

dashboardBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://reflectmemory.com/dashboard" });
});

checkStatus();
