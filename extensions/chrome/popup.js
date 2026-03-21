const statusEl = document.getElementById("status");
const authView = document.getElementById("authView");
const connectedView = document.getElementById("connectedView");
const signupBtn = document.getElementById("signupBtn");
const loginBtn = document.getElementById("loginBtn");
const manualToggle = document.getElementById("manualToggle");
const manualSection = document.getElementById("manualSection");
const apiKeyInput = document.getElementById("apiKey");
const saveBtn = document.getElementById("saveBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const dashboardBtn = document.getElementById("dashboardBtn");
const memoryCountEl = document.getElementById("memoryCount");
const planInfoEl = document.getElementById("planInfo");
const upgradeBtn = document.getElementById("upgradeBtn");

async function checkStatus() {
  const { apiKey, verified, vendor: cachedVendor } = await chrome.storage.sync.get([
    "apiKey",
    "verified",
    "vendor",
  ]);

  if (apiKey && verified) {
    showConnected(cachedVendor);
    loadMemoryCount();
    return;
  }

  if (apiKey) {
    setStatus("connecting", "Verifying...");
    const response = await chrome.runtime.sendMessage({ type: "CHECK_AUTH" });
    if (response?.authenticated) {
      await chrome.storage.sync.set({ verified: true, vendor: response.vendor || "" });
      showConnected(response.vendor);
      loadMemoryCount();
      return;
    }
    await chrome.storage.sync.remove(["apiKey", "verified", "vendor"]);
  }

  showAuthView();
}

function setStatus(state, text) {
  statusEl.className = `status ${state}`;
  statusEl.textContent = text;
}

function showConnected(vendor) {
  setStatus("connected", `Connected${vendor ? ` as ${vendor}` : ""}`);
  authView.classList.add("hidden");
  connectedView.classList.remove("hidden");
  chrome.action.setBadgeText({ text: "" });
}

function showAuthView() {
  setStatus("disconnected", "Not connected");
  authView.classList.remove("hidden");
  connectedView.classList.add("hidden");
}

async function loadMemoryCount() {
  const quota = await chrome.runtime.sendMessage({ type: "CHECK_QUOTA" });
  if (quota?.plan) {
    const planLabel = quota.plan === "free" ? "Free" : quota.plan === "pro" ? "Pro" : quota.plan.charAt(0).toUpperCase() + quota.plan.slice(1);
    planInfoEl.textContent = `Plan: ${planLabel}`;

    if (quota.limits) {
      const memLimit = quota.limits.maxMemories === Infinity ? "unlimited" : quota.limits.maxMemories.toLocaleString();
      const readLimit = quota.limits.maxReadsPerMonth === Infinity ? "unlimited" : quota.limits.maxReadsPerMonth.toLocaleString();
      memoryCountEl.textContent = `${memLimit} memories \u00B7 ${readLimit} reads/mo`;
    }

    if (quota.plan === "free") {
      upgradeBtn.classList.remove("hidden");
    }
  } else {
    memoryCountEl.textContent = "Memory sync active";
  }
}

signupBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://reflectmemory.com/signup" });
});

loginBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://reflectmemory.com/login" });
});

manualToggle.addEventListener("click", () => {
  manualSection.classList.toggle("open");
  manualToggle.textContent = manualSection.classList.contains("open")
    ? "Hide manual entry"
    : "Enter key manually";
});

saveBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;

  saveBtn.textContent = "Connecting...";
  saveBtn.disabled = true;

  await chrome.storage.sync.set({ apiKey: key });

  const response = await chrome.runtime.sendMessage({ type: "CHECK_AUTH" });
  if (response?.authenticated) {
    await chrome.storage.sync.set({ verified: true, vendor: response.vendor || "" });
    showConnected(response.vendor);
    loadMemoryCount();
  } else {
    showAuthView();
    setStatus("disconnected", "Invalid key");
    await chrome.storage.sync.remove(["apiKey", "verified", "vendor"]);
  }

  saveBtn.textContent = "Connect";
  saveBtn.disabled = false;
});

disconnectBtn.addEventListener("click", async () => {
  await chrome.storage.sync.remove(["apiKey", "verified", "vendor"]);
  await chrome.storage.local.remove("autoConnectAttempt");
  showAuthView();
  apiKeyInput.value = "";
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
});

upgradeBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://reflectmemory.com/dashboard/settings" });
});

dashboardBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://reflectmemory.com/dashboard" });
});

checkStatus();
