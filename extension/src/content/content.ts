// Content script (runs in the live-chat iframe): detect Japanese messages ->
// insert placeholder -> batch -> background -> Native Host -> apply translation.

import {
  KEY,
  MSG,
  SETTINGS_DEFAULTS,
  readChannelInfoFromDocument,
  type BatchResponse,
  type ChannelInfo,
  type Settings,
  type Translation,
  type WhitelistEntry,
} from "../shared/constants";

declare global {
  interface Window {
    __ylctContentLoaded?: boolean;
    __ylctEnabled?: boolean;
    __ylctSentByMe?: Set<string>;
    __ylctStats?: () => unknown;
    __ylctDebug?: () => unknown;
  }
}

(() => {
  if (window.__ylctContentLoaded) {
    console.warn("[ylct] content script already loaded, skipping");
    return;
  }
  window.__ylctContentLoaded = true;

  const DEFAULT_BATCH_WINDOW_MS = SETTINGS_DEFAULTS.batchWindowMs;
  const MIN_BATCH_WINDOW_MS = 5_000;
  const MAX_BATCH_WINDOW_MS = 60_000;
  const MAX_BATCH_SIZE = 30;
  const BACKFILL_COUNT = 10;
  const CACHE_KEY = KEY.CACHE;
  const CACHE_MAX_ENTRIES = 2000;
  const CACHE_FLUSH_DEBOUNCE_MS = 5_000;
  const WHITELIST_KEY = KEY.WHITELIST;
  const SETTINGS_KEY = KEY.SETTINGS;

  let batchWindowMs = DEFAULT_BATCH_WINDOW_MS;
  let maxTurns = SETTINGS_DEFAULTS.maxTurns;

  function readParentChannelInfo(): ChannelInfo | null {
    try {
      return readChannelInfoFromDocument(window.parent && window.parent.document);
    } catch {
      return null;
    }
  }

  function loadWhitelist(): Promise<WhitelistEntry[]> {
    return new Promise((resolve) => {
      chrome.storage.local.get(WHITELIST_KEY, (data) => {
        const list = data && (data[WHITELIST_KEY] as WhitelistEntry[] | undefined);
        resolve(Array.isArray(list) ? list : []);
      });
    });
  }

  async function shouldOperateForCurrentChannel(): Promise<{ active: boolean; parentInfoReady: boolean }> {
    const list = await loadWhitelist();
    if (list.length === 0) return { active: false, parentInfoReady: true };
    const info = readParentChannelInfo();
    if (!info || !info.handle) return { active: false, parentInfoReady: false };
    const active = list.some((e) => e.handle === info.handle);
    return { active, parentInfoReady: true };
  }

  chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
    if (msg && msg.type === MSG.GET_CHANNEL_INFO) {
      const info = readParentChannelInfo();
      sendResponse(info || { handle: null, channelName: null });
      return false;
    }
    return false;
  });

  const HIRAGANA = /[ぁ-ゟ]/;
  const KATAKANA = /[゠-ヿㇰ-ㇿ]/;
  const CJK = /[一-鿿]/;
  const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/g;

  const NOISE_PATTERNS: RegExp[] = [
    /^[wWｗ草藁笑]+$/,
    /^k+$/i,
    /^[ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ]+$/,
    /^(lol|lmao|lmfao|rofl|wtf|omg|gg|wp|gj)$/i,
    /^[!?.…]+$/,
    /^[\p{Extended_Pictographic}\s]+$/u,
    /^[8８]{2,}$/,
    /^(おつ|乙|うぽつ|うぽ|り|りょ|うぽつー*)$/,
    /^(.)\1{2,}$/u,
  ];

  const PICTOGRAM_NOISE_RATIO = 0.7;
  const PICTOGRAM_RE = /[\p{Extended_Pictographic}\s]/gu;

  function pictogramRatio(text: string): number {
    if (!text) return 0;
    const m = text.match(PICTOGRAM_RE);
    return m ? m.length / text.length : 0;
  }

  function isNoise(text: string): boolean {
    return NOISE_PATTERNS.some((re) => re.test(text));
  }

  type Verdict = "skip" | "korean" | "japanese" | "noise";

  function classify(rawText: string): Verdict {
    const text = (rawText || "").trim();
    if (!text) return "skip";

    const hangulMatches = text.match(HANGUL);
    if (hangulMatches && hangulMatches.length / text.length > 0.3) return "korean";
    const hasJa = HIRAGANA.test(text) || KATAKANA.test(text) || CJK.test(text);

    if (hasJa && pictogramRatio(text) >= PICTOGRAM_NOISE_RATIO) return "noise";
    if (hasJa && isNoise(text)) return "noise";
    if (hasJa) return "japanese";
    if (isNoise(text)) return "noise";
    return "skip";
  }

  function extractText(node: HTMLElement): string {
    const messageEl = node.querySelector<HTMLElement>("#message");
    if (!messageEl) return "";
    return (messageEl.innerText || messageEl.textContent || "").trim();
  }

  function normalize(text: string): string {
    return (text || "")
      .normalize("NFC")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  }

  const REPEAT_RE_G = /(.)\1{2,}/gu;
  function collapseRepeats(text: string): string {
    return text ? text.replace(REPEAT_RE_G, "$1") : "";
  }

  function cacheKey(text: string): string {
    return collapseRepeats(normalize(text));
  }

  const cache = new Map<string, string>();

  function cacheGet(key: string): string | null {
    if (!cache.has(key)) return null;
    const value = cache.get(key)!;
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  function cachePut(key: string, value: string): void {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    scheduleCacheFlush();
  }

  let cacheFlushTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleCacheFlush(): void {
    if (cacheFlushTimer) return;
    cacheFlushTimer = setTimeout(flushCacheToStorage, CACHE_FLUSH_DEBOUNCE_MS);
  }

  interface StoredCache {
    version: number;
    entries: Array<[string, string]>;
  }

  function flushCacheToStorage(): void {
    cacheFlushTimer = null;
    const entries = Array.from(cache.entries());
    const payload: StoredCache = { version: 1, entries };
    chrome.storage.local.set({ [CACHE_KEY]: payload }, () => {
      if (chrome.runtime.lastError) {
        console.warn("[ylct] cache flush failed:", chrome.runtime.lastError.message);
      }
    });
  }

  function loadCacheFromStorage(done?: () => void): void {
    chrome.storage.local.get(CACHE_KEY, (data) => {
      if (chrome.runtime.lastError) {
        console.warn("[ylct] cache load failed:", chrome.runtime.lastError.message);
        return done && done();
      }
      const stored = data && (data[CACHE_KEY] as StoredCache | undefined);
      if (stored && Array.isArray(stored.entries)) {
        for (const [k, v] of stored.entries) {
          if (typeof k === "string" && typeof v === "string") cache.set(k, v);
        }
        console.log(`[ylct] cache loaded: ${cache.size} entries`);
      }
      done && done();
    });
  }

  interface Stats {
    seen: number;
    japanese: number;
    korean: number;
    noise: number;
    skip: number;
    pending: number;
    done: number;
    error: number;
    cacheHits: number;
    hidden: number;
    self: number;
    dedupHits: number;
    sampled: number;
  }

  const stats: Stats = {
    seen: 0, japanese: 0, korean: 0, noise: 0, skip: 0,
    pending: 0, done: 0, error: 0,
    cacheHits: 0, hidden: 0, self: 0,
    dedupHits: 0, sampled: 0,
  };
  window.__ylctStats = () => ({
    ...stats,
    cacheSize: cache.size,
    inflightKeys: inflightByKey.size,
    queueLen: queue.length,
  });

  const inflightByKey = new Map<string, Set<string>>();

  const SAMPLING_SOFT = 40;
  const SAMPLING_HARD = 80;

  function shouldDrop(): boolean {
    const load = queue.length + pendingMap.size;
    if (load >= SAMPLING_HARD) return Math.random() < 0.75;
    if (load >= SAMPLING_SOFT) return Math.random() < 0.5;
    return false;
  }

  window.__ylctDebug = () => {
    const scroller = getChatScroller();
    return {
      scrollerTag: scroller && (scroller.tagName + "#" + scroller.id),
      scrollerOverflowY: scroller && getComputedStyle(scroller).overflowY,
      scrollTop: scroller && scroller.scrollTop,
      scrollHeight: scroller && scroller.scrollHeight,
      clientHeight: scroller && scroller.clientHeight,
      diffFromBottom: scroller && (scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight)),
      isNearBottom: isNearBottom(scroller),
      threshold: SCROLL_BOTTOM_THRESHOLD,
      currentList: currentList && (currentList.tagName + "#" + currentList.id),
      listChildren: currentList && currentList.children.length,
    };
  };

  interface QueueItem {
    id: string;
    ja: string;
    node: HTMLElement;
  }

  interface PendingEntry {
    node: HTMLElement;
    ja: string;
    key: string;
  }

  let queue: QueueItem[] = [];
  const pendingMap = new Map<string, PendingEntry>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(flushBatch, batchWindowMs);
  }

  function enqueue(node: HTMLElement, id: string, ja: string, key: string): void {
    queue.push({ id, ja, node });
    pendingMap.set(id, { node, ja, key });
    stats.pending += 1;

    if (queue.length >= MAX_BATCH_SIZE) {
      flushBatch();
    } else {
      scheduleFlush();
    }
  }

  function consumeSiblings(id: string): string[] {
    const entry = pendingMap.get(id);
    const key = entry && entry.key;
    if (key && inflightByKey.has(key)) {
      const ids = Array.from(inflightByKey.get(key)!);
      inflightByKey.delete(key);
      return ids;
    }
    return [id];
  }

  function failAll(batch: QueueItem[], reason: string): void {
    batch.forEach((b) => {
      for (const sid of consumeSiblings(b.id)) markError(sid, reason);
    });
  }

  function flushBatch(): void {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (queue.length === 0) return;

    const batch = queue;
    queue = [];

    const items = batch.map((b) => ({ id: b.id, ja: b.ja }));
    console.log(`[ylct] flushing batch: ${items.length} item(s)`);

    if (!chrome.runtime || !chrome.runtime.id) {
      const reason = "extension reloaded — refresh the page";
      console.warn("[ylct] " + reason);
      failAll(batch, reason);
      return;
    }

    try {
      chrome.runtime.sendMessage(
        { type: MSG.TRANSLATE_BATCH, items, maxTurns },
        (response: BatchResponse | undefined) => {
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message || "sendMessage error";
            console.warn("[ylct] sendMessage error:", msg);
            failAll(batch, msg);
            return;
          }
          handleBatchResponse(batch, response);
        }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[ylct] sendMessage threw:", msg);
      failAll(batch, msg);
    }
  }

  function handleBatchResponse(batch: QueueItem[], response: BatchResponse | undefined): void {
    if (!response || !response.ok) {
      const err = (response && (response.error || response.raw)) || "unknown error";
      console.warn("[ylct] translate failed:", err);
      failAll(batch, err);
      return;
    }

    const translations: Translation[] = response.translations || [];
    const translated = new Set<string>();
    let dedupFanout = 0;
    for (const r of translations) {
      const siblings = consumeSiblings(r.id);
      if (siblings.length > 1) dedupFanout += siblings.length - 1;
      for (const sid of siblings) {
        applyTranslation(sid, r.ko);
        translated.add(sid);
      }
    }
    batch.forEach((b) => {
      if (translated.has(b.id)) return;
      for (const sid of consumeSiblings(b.id)) {
        if (!translated.has(sid)) markError(sid, "no translation in response");
      }
    });

    if (response.elapsedMs != null) {
      console.log(
        `[ylct] batch done in ${response.elapsedMs}ms ` +
        `(${translated.size}/${batch.length + dedupFanout}, dedup=${dedupFanout})`
      );
    }
  }

  const SCROLL_BOTTOM_THRESHOLD = 150;

  let cachedScroller: HTMLElement | null = null;

  function findScrollableAncestor(node: Element | null): HTMLElement | null {
    let p = node && (node.parentElement as HTMLElement | null);
    while (p) {
      const cs = getComputedStyle(p);
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") &&
          p.scrollHeight > p.clientHeight) {
        return p;
      }
      p = p.parentElement as HTMLElement | null;
    }
    return null;
  }

  function getChatScroller(): HTMLElement | null {
    if (cachedScroller && cachedScroller.isConnected) return cachedScroller;
    cachedScroller =
      document.querySelector<HTMLElement>("yt-live-chat-item-list-renderer #item-scroller") ||
      document.querySelector<HTMLElement>("yt-live-chat-item-list-renderer #contents") ||
      null;
    if (!cachedScroller && currentList) {
      cachedScroller = findScrollableAncestor(currentList);
    }
    return cachedScroller;
  }

  function isNearBottom(el: HTMLElement | null): boolean {
    if (!el) return false;
    return el.scrollHeight - (el.scrollTop + el.clientHeight) < SCROLL_BOTTOM_THRESHOLD;
  }

  function pinToBottom(scroller: HTMLElement | null): void {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  function pinToBottomBurst(scroller: HTMLElement, frames: number): void {
    pinToBottom(scroller);
    if (frames <= 0) return;
    requestAnimationFrame(() => pinToBottomBurst(scroller, frames - 1));
  }

  function preserveBottomScroll(mutateFn: () => void): void {
    const scroller = getChatScroller();
    const wasAtBottom = isNearBottom(scroller);
    mutateFn();
    if (wasAtBottom && scroller) pinToBottomBurst(scroller, 1);
  }

  function injectPlaceholder(node: HTMLElement, id: string): HTMLDivElement | null {
    const messageEl = node.querySelector<HTMLElement>("#message");
    if (!messageEl) return null;

    const div = document.createElement("div");
    div.className = "ylct-translation";
    div.dataset.ylctState = "pending";
    div.dataset.ylctId = id;
    div.textContent = "번역 중";
    messageEl.insertAdjacentElement("afterend", div);
    return div;
  }

  function getInjectedEl(id: string): HTMLElement | null {
    const entry = pendingMap.get(id);
    if (!entry) return null;
    const node = entry.node;
    return node && node.querySelector<HTMLElement>(`.ylct-translation[data-ylct-id="${CSS.escape(id)}"]`);
  }

  function applyTranslation(id: string, ko: string): void {
    const entry = pendingMap.get(id);
    const el = getInjectedEl(id);
    pendingMap.delete(id);
    stats.pending = Math.max(0, stats.pending - 1);

    if (entry && entry.ja && typeof ko === "string") {
      cachePut(entry.key || cacheKey(entry.ja), ko);
    }

    if (!el) return;
    preserveBottomScroll(() => {
      el.textContent = ko;
      el.dataset.ylctState = "done";
    });
    stats.done += 1;
  }

  function markError(id: string, reason: string): void {
    const el = getInjectedEl(id);
    pendingMap.delete(id);
    stats.pending = Math.max(0, stats.pending - 1);
    if (!el) return;
    preserveBottomScroll(() => {
      el.textContent = "번역 실패";
      el.title = String(reason || "");
      el.dataset.ylctState = "error";
    });
    stats.error += 1;
  }

  function handleNode(node: Node): void {
    if (!enabled) return;
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName !== "YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER") return;
    if (node.dataset.ylctId) return;

    stats.seen += 1;
    const id = "m-" + stats.seen + "-" + Math.random().toString(36).slice(2, 8);
    node.dataset.ylctId = id;

    const text = extractText(node);
    if (!text) { stats.skip += 1; return; }

    if (window.__ylctSentByMe && window.__ylctSentByMe.has(text)) {
      stats.self += 1;
      return;
    }

    const verdict = classify(text);
    stats[verdict] += 1;
    if (verdict !== "japanese") return;

    const key = cacheKey(text);
    const cached = cacheGet(key);
    if (cached != null) {
      stats.cacheHits += 1;
      const placeholder = injectPlaceholder(node, id);
      if (placeholder) {
        placeholder.textContent = cached;
        placeholder.dataset.ylctState = "done";
        stats.done += 1;
      }
      return;
    }

    if (inflightByKey.has(key)) {
      if (!injectPlaceholder(node, id)) return;
      inflightByKey.get(key)!.add(id);
      pendingMap.set(id, { node, ja: text, key });
      stats.pending += 1;
      stats.dedupHits += 1;
      return;
    }

    if (document.hidden) {
      stats.hidden += 1;
      return;
    }

    if (shouldDrop()) {
      stats.sampled += 1;
      return;
    }

    if (!injectPlaceholder(node, id)) return;
    inflightByKey.set(key, new Set([id]));
    enqueue(node, id, text, key);
  }

  let currentList: HTMLElement | null = null;
  let messageObserver: MutationObserver | null = null;

  // Translate the most recent messages already present in the list. Used both on
  // first attach and when a tab becomes visible again. A node that already shows
  // a translation is skipped so we never inject a duplicate placeholder; any
  // other recent node has its stale ylctId cleared so handleNode reprocesses it
  // (messages seen while the tab was hidden were marked but dropped before
  // translation — see the document.hidden guard in handleNode).
  function backfillRecent(list: HTMLElement): number {
    const recent = Array.from(
      list.querySelectorAll<HTMLElement>("yt-live-chat-text-message-renderer")
    ).slice(-BACKFILL_COUNT);
    for (const node of recent) {
      if (node.querySelector(".ylct-translation")) continue;
      delete node.dataset.ylctId;
      handleNode(node);
    }
    return recent.length;
  }

  function attachToList(list: HTMLElement): void {
    if (!list || list === currentList) return;

    if (messageObserver) {
      messageObserver.disconnect();
      messageObserver = null;
    }
    queue.length = 0;
    pendingMap.clear();
    inflightByKey.clear();
    stats.pending = 0;
    currentList = list;
    cachedScroller = null;

    const backfilled = backfillRecent(list);

    messageObserver = new MutationObserver((mutations) => {
      const scroller = getChatScroller();
      const wasAtBottom = isNearBottom(scroller);

      for (const m of mutations) {
        m.addedNodes.forEach((n) => handleNode(n));
      }

      if (wasAtBottom && scroller) {
        pinToBottomBurst(scroller, 2);
        setTimeout(() => pinToBottom(scroller), 120);
      }
    });
    messageObserver.observe(list, { childList: true, subtree: false });

    console.log(`[ylct] message observer attached (${backfilled} backfilled)`);
  }

  let warmupSent = false;
  function maybeWarmup(): void {
    if (!enabled) return;
    if (warmupSent) return;
    if (!chrome.runtime || !chrome.runtime.id) return;
    warmupSent = true;
    try {
      chrome.runtime.sendMessage({ type: MSG.WARMUP }, (reply) => {
        if (chrome.runtime.lastError) {
          console.warn("[ylct] warmup error:", chrome.runtime.lastError.message);
          warmupSent = false;
          return;
        }
        console.log("[ylct] warmup done:", reply);
      });
    } catch (err) {
      console.warn("[ylct] warmup threw:", err instanceof Error ? err.message : err);
      warmupSent = false;
    }
  }

  function watchForList(): void {
    const tryAttach = () => {
      const list = document.querySelector<HTMLElement>("yt-live-chat-item-list-renderer #items");
      if (list) {
        attachToList(list);
        maybeWarmup();
      }
    };

    tryAttach();

    const rootObserver = new MutationObserver(() => {
      const list = document.querySelector<HTMLElement>("yt-live-chat-item-list-renderer #items");
      if (list && list !== currentList) {
        attachToList(list);
      }
    });
    rootObserver.observe(document.documentElement, { childList: true, subtree: true });

    console.log("[ylct] M5 root watcher armed. window.__ylctStats() for counters.");
  }

  let enabled = false;
  let watchersAttached = false;
  window.__ylctEnabled = false;

  let parentInfoRetryTimer: ReturnType<typeof setTimeout> | null = null;
  const PARENT_INFO_RETRY_MS = 500;
  const PARENT_INFO_MAX_ATTEMPTS = 60;
  let parentInfoAttempts = 0;

  function clearParentInfoRetry(): void {
    if (parentInfoRetryTimer) {
      clearTimeout(parentInfoRetryTimer);
      parentInfoRetryTimer = null;
    }
    parentInfoAttempts = 0;
  }

  async function recomputeEnabled(): Promise<void> {
    const { active, parentInfoReady } = await shouldOperateForCurrentChannel();

    if (!parentInfoReady && !parentInfoRetryTimer && parentInfoAttempts < PARENT_INFO_MAX_ATTEMPTS) {
      parentInfoAttempts += 1;
      parentInfoRetryTimer = setTimeout(() => {
        parentInfoRetryTimer = null;
        recomputeEnabled();
      }, PARENT_INFO_RETRY_MS);
    } else if (parentInfoReady) {
      clearParentInfoRetry();
    }

    if (active === enabled) return;
    enabled = active;
    window.__ylctEnabled = enabled;
    const info = readParentChannelInfo();
    console.log(
      "[ylct] enabled =", enabled,
      info ? `handle=${info.handle}` : "(no parent channel info)"
    );
    if (enabled && !watchersAttached) {
      watchersAttached = true;
      loadCacheFromStorage(() => {
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", watchForList, { once: true });
        } else {
          watchForList();
        }
      });
    }
  }

  function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
  }

  function pickNumber(v: unknown, fallback: number, lo: number, hi: number): number {
    return clamp(typeof v === "number" ? v : fallback, lo, hi);
  }

  function recomputeSettings(): void {
    chrome.storage.local.get(SETTINGS_KEY, (data) => {
      const s = (data && (data[SETTINGS_KEY] as Partial<Settings> | undefined)) || {};

      const nextWin = pickNumber(s.batchWindowMs, DEFAULT_BATCH_WINDOW_MS, MIN_BATCH_WINDOW_MS, MAX_BATCH_WINDOW_MS);
      if (nextWin !== batchWindowMs) {
        batchWindowMs = nextWin;
        console.log("[ylct] batch window updated:", batchWindowMs + "ms");
      }

      const nextMt = pickNumber(s.maxTurns, SETTINGS_DEFAULTS.maxTurns, 0, 100000);
      if (nextMt !== maxTurns) {
        maxTurns = nextMt;
        console.log("[ylct] maxTurns updated:", maxTurns === 0 ? "unlimited" : maxTurns);
      }
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[WHITELIST_KEY]) recomputeEnabled();
    if (changes[SETTINGS_KEY])  recomputeSettings();
  });

  function init(): void {
    recomputeSettings();
    recomputeEnabled();
  }

  window.addEventListener("pagehide", () => {
    if (cacheFlushTimer) {
      clearTimeout(cacheFlushTimer);
      cacheFlushTimer = null;
      flushCacheToStorage();
    }
    clearParentInfoRetry();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      // (b) Tab hidden: cancel the pending auto-flush so a queued batch isn't
      // translated in the background. New enqueues are already blocked while
      // hidden (see handleNode), and we intentionally keep the local queue
      // intact so injected placeholders stay consistent — it flushes naturally
      // once the tab is visible again. Only content-local state is touched here,
      // never the shared host session (which other visible tabs may be using).
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    } else if (enabled) {
      // (a) Tab visible again: the per-tab host session may have idled out while
      // hidden, so re-trigger warmup to avoid a cold start on the first message.
      warmupSent = false;
      maybeWarmup();
      // (c) Backfill the most recent messages just like on first attach, so the
      // chat that scrolled past while the tab was hidden gets translated.
      if (currentList) backfillRecent(currentList);
    }
  });

  init();
})();
