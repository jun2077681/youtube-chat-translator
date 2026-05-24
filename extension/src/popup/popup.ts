// YLCT popup: main tab (channel whitelist) + debug tab (native host probes).

import {
  KEY,
  MSG,
  SETTINGS_DEFAULTS,
  type ChannelInfo,
  type Settings,
  type WhitelistEntry,
} from "../shared/constants";

const WHITELIST_KEY = KEY.WHITELIST;
const SETTINGS_KEY = KEY.SETTINGS;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element: #${id}`);
  return el;
}

const tabMain = $("tab-main");
const tabDebug = $("tab-debug");
const paneMain = $("pane-main");
const paneDebug = $("pane-debug");

function activateTab(which: "main" | "debug"): void {
  const isMain = which === "main";
  tabMain.classList.toggle("active", isMain);
  tabDebug.classList.toggle("active", !isMain);
  paneMain.classList.toggle("active", isMain);
  paneDebug.classList.toggle("active", !isMain);
}
tabMain.addEventListener("click", () => activateTab("main"));
tabDebug.addEventListener("click", () => activateTab("debug"));

const currentChannelName = $("current-channel-name");
const currentChannelId = $("current-channel-id");
const addChannelBtn = $("add-channel-btn") as HTMLButtonElement;
const whitelistList = $("whitelist-list");

let detectedChannel: ChannelInfo | null = null;

function loadWhitelist(): Promise<WhitelistEntry[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get(WHITELIST_KEY, (data) => {
      const list = data && (data[WHITELIST_KEY] as WhitelistEntry[] | undefined);
      resolve(Array.isArray(list) ? list : []);
    });
  });
}

function saveWhitelist(list: WhitelistEntry[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [WHITELIST_KEY]: list }, () => resolve());
  });
}

async function refreshWhitelistUI(): Promise<void> {
  await renderWhitelist();
  await refreshAddButton();
}

async function addCurrent(): Promise<void> {
  if (!detectedChannel || !detectedChannel.handle) return;
  const list = await loadWhitelist();
  if (list.some((e) => e.handle === detectedChannel!.handle)) return;
  await saveWhitelist([
    ...list,
    {
      handle: detectedChannel.handle,
      channelName: detectedChannel.channelName || detectedChannel.handle,
      addedAt: new Date().toISOString(),
    },
  ]);
  await refreshWhitelistUI();
}

async function removeChannel(handle: string): Promise<void> {
  const list = await loadWhitelist();
  await saveWhitelist(list.filter((e) => e.handle !== handle));
  await refreshWhitelistUI();
}

async function renderWhitelist(): Promise<void> {
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

async function refreshAddButton(): Promise<void> {
  if (!detectedChannel || !detectedChannel.handle) {
    addChannelBtn.disabled = true;
    addChannelBtn.textContent = "현재 채널을 감지할 수 없음";
    return;
  }
  const list = await loadWhitelist();
  const already = list.some((e) => e.handle === detectedChannel!.handle);
  addChannelBtn.disabled = already;
  addChannelBtn.textContent = already
    ? "이미 화이트리스트에 있음"
    : "이 채널을 화이트리스트에 추가";
}

addChannelBtn.addEventListener("click", addCurrent);

function sendChannelInfoMessage(tabId: number): Promise<ChannelInfo | null> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: MSG.GET_CHANNEL_INFO }, (reply: ChannelInfo | undefined) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(reply || null);
    });
  });
}

async function injectChannelDetector(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["channel-detector.js"],
    });
    return true;
  } catch {
    return false;
  }
}

async function detectCurrentChannel(): Promise<ChannelInfo | null> {
  const [tab] = await new Promise<chrome.tabs.Tab[]>((res) =>
    chrome.tabs.query({ active: true, currentWindow: true }, res)
  );
  if (!tab || !tab.id || !tab.url) return null;
  if (!/^https:\/\/www\.youtube\.com\/watch/.test(tab.url)) return null;

  let viaMessage = await sendChannelInfoMessage(tab.id);
  if (viaMessage && viaMessage.handle) return viaMessage;

  if (!(await injectChannelDetector(tab.id))) return null;

  for (const ms of [0, 400, 800, 1200]) {
    if (ms) await new Promise((r) => setTimeout(r, ms));
    viaMessage = await sendChannelInfoMessage(tab.id);
    if (viaMessage && viaMessage.handle) return viaMessage;
  }
  return null;
}

function loadSettings(): Promise<Partial<Settings>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(SETTINGS_KEY, (data) => {
      resolve((data && (data[SETTINGS_KEY] as Partial<Settings> | undefined)) || {});
    });
  });
}

async function patchSettings(patch: Partial<Settings>): Promise<void> {
  const cur = await loadSettings();
  const next = { ...cur, ...patch };
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SETTINGS_KEY]: next }, () => resolve());
  });
}

const batchWindowSelect = $("batch-window") as HTMLSelectElement;
const maxTurnsSelect = $("max-turns") as HTMLSelectElement;
const resetSessionBtn = $("reset-session-btn") as HTMLButtonElement;

async function initSettings(): Promise<void> {
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
    const reply = await new Promise<{ ok?: boolean; error?: string } | undefined>((resolve) => {
      chrome.runtime.sendMessage({ type: MSG.RESET_SESSION }, (r) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(r);
      });
    });
    resetSessionBtn.textContent = (reply && reply.ok) ? "재시작됨 ✓" : "실패";
  } catch {
    resetSessionBtn.textContent = "오류";
  }
  setTimeout(() => {
    resetSessionBtn.textContent = orig;
    resetSessionBtn.disabled = false;
  }, 1500);
});

async function initMainTab(): Promise<void> {
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

const pingBtn = $("ping-btn") as HTMLButtonElement;
const claudeBtn = $("claude-btn") as HTMLButtonElement;
const promptInput = $("prompt-input") as HTMLInputElement;
const output = $("output");

function setOutput(label: string, payload: unknown): void {
  output.textContent = `[${label}] ${new Date().toISOString()}\n` + JSON.stringify(payload, null, 2);
}

function send(message: unknown): Promise<unknown> {
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

async function withButton(btn: HTMLButtonElement, label: string, fn: () => Promise<unknown>): Promise<void> {
  btn.disabled = true;
  output.textContent = `[${label}] running...`;
  const t0 = performance.now();
  try {
    const result = await fn();
    const elapsed = Math.round(performance.now() - t0);
    setOutput(`${label} done in ${elapsed}ms`, result);
  } catch (err) {
    setOutput(`${label} threw`, { error: err instanceof Error ? err.message : String(err) });
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
