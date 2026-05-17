// YLCT popup: main tab (channel whitelist) + debug tab (native host probes).

const { MSG, KEY, SETTINGS_DEFAULTS } = globalThis.YLCT_CONST;
const WHITELIST_KEY = KEY.WHITELIST;
const SETTINGS_KEY = KEY.SETTINGS;

// ---------- tabs ----------

const tabMain = document.getElementById("tab-main");
const tabDebug = document.getElementById("tab-debug");
const paneMain = document.getElementById("pane-main");
const paneDebug = document.getElementById("pane-debug");

function activateTab(which) {
  const isMain = which === "main";
  tabMain.classList.toggle("active", isMain);
  tabDebug.classList.toggle("active", !isMain);
  paneMain.classList.toggle("active", isMain);
  paneDebug.classList.toggle("active", !isMain);
}
tabMain.addEventListener("click", () => activateTab("main"));
tabDebug.addEventListener("click", () => activateTab("debug"));

// ---------- main tab ----------

const currentChannelName = document.getElementById("current-channel-name");
const currentChannelId = document.getElementById("current-channel-id");
const addChannelBtn = document.getElementById("add-channel-btn");
const whitelistList = document.getElementById("whitelist-list");

let detectedChannel = null;

function loadWhitelist() {
  return new Promise((resolve) => {
    chrome.storage.local.get(WHITELIST_KEY, (data) => {
      const list = data && data[WHITELIST_KEY];
      resolve(Array.isArray(list) ? list : []);
    });
  });
}

function saveWhitelist(list) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [WHITELIST_KEY]: list }, () => resolve());
  });
}

async function addCurrent() {
  if (!detectedChannel || !detectedChannel.handle) return;
  const list = await loadWhitelist();
  if (list.some((e) => e.handle === detectedChannel.handle)) return;
  const updated = [
    ...list,
    {
      handle: detectedChannel.handle,
      channelName: detectedChannel.channelName || detectedChannel.handle,
      addedAt: new Date().toISOString(),
    },
  ];
  await saveWhitelist(updated);
  await renderWhitelist();
  await refreshAddButton();
}

async function removeChannel(handle) {
  const list = await loadWhitelist();
  const filtered = list.filter((e) => e.handle !== handle);
  await saveWhitelist(filtered);
  await renderWhitelist();
  await refreshAddButton();
}

async function renderWhitelist() {
  const list = await loadWhitelist();
  whitelistList.innerHTML = "";
  if (list.length === 0) {
    const li = document.createElement("li");
    li.className = "whitelist-empty";
    li.textContent = "(비어있음)";
    whitelistList.appendChild(li);
    return;
  }
  for (const entry of list) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.channelName || entry.handle;
    name.title = entry.handle;
    const btn = document.createElement("button");
    btn.textContent = "제거";
    btn.addEventListener("click", () => removeChannel(entry.handle));
    li.appendChild(name);
    li.appendChild(btn);
    whitelistList.appendChild(li);
  }
}

async function refreshAddButton() {
  if (!detectedChannel || !detectedChannel.handle) {
    addChannelBtn.disabled = true;
    addChannelBtn.textContent = "현재 채널을 감지할 수 없음";
    return;
  }
  const list = await loadWhitelist();
  const already = list.some((e) => e.handle === detectedChannel.handle);
  addChannelBtn.disabled = already;
  addChannelBtn.textContent = already
    ? "이미 화이트리스트에 있음"
    : "이 채널을 화이트리스트에 추가";
}

addChannelBtn.addEventListener("click", addCurrent);

function sendChannelInfoMessage(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: MSG.GET_CHANNEL_INFO }, (reply) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(reply || null);
    });
  });
}

// YouTube SPA navigation doesn't re-inject content scripts, so push our
// detector into the tab on demand. Both files run in the standard isolated
// world; channel-detector.js guards itself against double-loading.
async function injectChannelDetector(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["src/shared/constants.js", "src/content/channel-detector.js"],
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function detectCurrentChannel() {
  const [tab] = await new Promise((res) =>
    chrome.tabs.query({ active: true, currentWindow: true }, res)
  );
  if (!tab || !tab.id || !tab.url) return null;
  if (!/^https:\/\/www\.youtube\.com\/watch/.test(tab.url)) return null;

  let viaMessage = await sendChannelInfoMessage(tab.id);
  if (viaMessage && viaMessage.handle) return viaMessage;

  if (!(await injectChannelDetector(tab.id))) return null;

  // Retries cover late DOM hydration after a fresh injection.
  for (const ms of [0, 400, 800, 1200]) {
    if (ms) await new Promise((r) => setTimeout(r, ms));
    viaMessage = await sendChannelInfoMessage(tab.id);
    if (viaMessage && viaMessage.handle) return viaMessage;
  }
  return null;
}

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(SETTINGS_KEY, (data) => {
      resolve((data && data[SETTINGS_KEY]) || {});
    });
  });
}

async function patchSettings(patch) {
  const cur = await loadSettings();
  const next = { ...cur, ...patch };
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SETTINGS_KEY]: next }, () => resolve());
  });
}

const batchWindowSelect = document.getElementById("batch-window");
const maxTurnsSelect = document.getElementById("max-turns");
const resetSessionBtn = document.getElementById("reset-session-btn");

async function initSettings() {
  const s = await loadSettings();
  batchWindowSelect.value = String(typeof s.batchWindowMs === "number" ? s.batchWindowMs : SETTINGS_DEFAULTS.batchWindowMs);
  maxTurnsSelect.value = String(typeof s.maxTurns === "number" ? s.maxTurns : SETTINGS_DEFAULTS.maxTurns);
}

batchWindowSelect.addEventListener("change", () => {
  const v = parseInt(batchWindowSelect.value, 10);
  if (Number.isFinite(v)) patchSettings({ batchWindowMs: v });
});

maxTurnsSelect.addEventListener("change", () => {
  const v = parseInt(maxTurnsSelect.value, 10);
  if (Number.isFinite(v)) patchSettings({ maxTurns: v });
});

resetSessionBtn.addEventListener("click", async () => {
  const orig = resetSessionBtn.textContent;
  resetSessionBtn.disabled = true;
  resetSessionBtn.textContent = "재시작 중...";
  try {
    const reply = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: MSG.RESET_SESSION }, (r) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(r);
      });
    });
    resetSessionBtn.textContent = (reply && reply.ok) ? "재시작됨 ✓" : "실패";
  } catch (err) {
    resetSessionBtn.textContent = "오류";
  }
  setTimeout(() => {
    resetSessionBtn.textContent = orig;
    resetSessionBtn.disabled = false;
  }, 1500);
});

async function initMainTab() {
  detectedChannel = await detectCurrentChannel();
  if (detectedChannel && detectedChannel.handle) {
    currentChannelName.textContent = detectedChannel.channelName || "(이름 없음)";
    currentChannelId.textContent = detectedChannel.handle;
  } else {
    currentChannelName.textContent = "YouTube 라이브 페이지가 아니거나 감지 실패";
    currentChannelId.textContent = "";
  }
  await renderWhitelist();
  await refreshAddButton();
  await initSettings();
}

// ---------- debug tab ----------

const pingBtn = document.getElementById("ping-btn");
const claudeBtn = document.getElementById("claude-btn");
const promptInput = document.getElementById("prompt-input");
const output = document.getElementById("output");

function setOutput(label, payload) {
  output.textContent = `[${label}] ${new Date().toISOString()}\n` + JSON.stringify(payload, null, 2);
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });
}

async function withButton(btn, label, fn) {
  btn.disabled = true;
  output.textContent = `[${label}] running...`;
  const t0 = performance.now();
  try {
    const result = await fn();
    const elapsed = Math.round(performance.now() - t0);
    setOutput(`${label} done in ${elapsed}ms`, result);
  } catch (err) {
    setOutput(`${label} threw`, { error: String(err && err.message || err) });
  } finally {
    btn.disabled = false;
  }
}

pingBtn.addEventListener("click", () => {
  withButton(pingBtn, "PING", () => send({ type: MSG.PING_HOST }));
});

claudeBtn.addEventListener("click", () => {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    setOutput("CALL_CLAUDE", { error: "empty prompt" });
    return;
  }
  withButton(claudeBtn, "CALL_CLAUDE", () => send({ type: MSG.CALL_CLAUDE, prompt }));
});

initMainTab();
