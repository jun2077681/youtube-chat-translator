// Content script (runs in the live-chat iframe): detect Japanese messages ->
// insert placeholder -> batch -> background -> Native Host -> apply translation.

(() => {
  "use strict";

  if (window.__ylctContentLoaded) {
    console.warn("[ylct] content script already loaded, skipping");
    return;
  }
  window.__ylctContentLoaded = true;

  const { MSG, KEY, SETTINGS_DEFAULTS, readChannelInfoFromDocument } = globalThis.YLCT_CONST;

  const DEFAULT_BATCH_WINDOW_MS = SETTINGS_DEFAULTS.batchWindowMs;
  const MIN_BATCH_WINDOW_MS = 5_000;
  const MAX_BATCH_WINDOW_MS = 60_000;
  const MAX_BATCH_SIZE = 30;
  const CACHE_KEY = KEY.CACHE;
  const CACHE_MAX_ENTRIES = 2000;
  const CACHE_FLUSH_DEBOUNCE_MS = 5_000;
  const WHITELIST_KEY = KEY.WHITELIST;
  const SETTINGS_KEY = KEY.SETTINGS;

  let batchWindowMs = DEFAULT_BATCH_WINDOW_MS;
  let maxTurns = SETTINGS_DEFAULTS.maxTurns; // 0 = no auto-restart

  // ---------- channel info from parent /watch page ----------

  function readParentChannelInfo() {
    try {
      return readChannelInfoFromDocument(window.parent && window.parent.document);
    } catch (_) {
      return null;
    }
  }

  function loadWhitelist() {
    return new Promise((resolve) => {
      chrome.storage.local.get(WHITELIST_KEY, (data) => {
        const list = data && data[WHITELIST_KEY];
        resolve(Array.isArray(list) ? list : []);
      });
    });
  }

  // Whitelist is opt-in: empty means OFF. `parentInfoReady` is false when
  // the /watch page hasn't rendered its owner /@handle yet so the caller
  // can poll instead of waiting for the next whitelist mutation.
  async function shouldOperateForCurrentChannel() {
    const list = await loadWhitelist();
    if (list.length === 0) return { active: false, parentInfoReady: true };
    const info = readParentChannelInfo();
    if (!info || !info.handle) return { active: false, parentInfoReady: false };
    const active = list.some((e) => e.handle === info.handle);
    return { active, parentInfoReady: true };
  }

  // Always-on listener so the popup can ask "what's the current channel?"
  // even when translation is disabled for this channel.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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

  const NOISE_PATTERNS = [
    /^[wWｗ草藁笑]+$/,                                // laughter stamps (EN/JP)
    /^k+$/i,
    /^[ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ]+$/,
    /^(lol|lmao|lmfao|rofl|wtf|omg|gg|wp|gj)$/i,
    /^[!?.…]+$/,
    /^[\p{Extended_Pictographic}\s]+$/u,
    /^[8８]{2,}$/,                                    // 8888 clap
    /^(おつ|乙|うぽつ|うぽ|り|りょ|うぽつー*)$/,        // chat stamps
    /^(.)\1{2,}$/u,                                   // bare single-char run
  ];

  // Reject pictogram-dominated messages even when they contain stray kana.
  const PICTOGRAM_NOISE_RATIO = 0.7;
  const PICTOGRAM_RE = /[\p{Extended_Pictographic}\s]/gu;

  function pictogramRatio(text) {
    if (!text) return 0;
    const m = text.match(PICTOGRAM_RE);
    return m ? m.length / text.length : 0;
  }

  function isNoise(text) {
    return NOISE_PATTERNS.some((re) => re.test(text));
  }

  function classify(rawText) {
    const text = (rawText || "").trim();
    if (!text) return "skip";

    // Cheap script checks first; pictogram-ratio scan only runs if Japanese
    // is detected (most non-JP messages skip the Unicode-property regex).
    const hangulMatches = text.match(HANGUL);
    if (hangulMatches && hangulMatches.length / text.length > 0.3) return "korean";
    const hasJa = HIRAGANA.test(text) || KATAKANA.test(text) || CJK.test(text);

    if (hasJa && pictogramRatio(text) >= PICTOGRAM_NOISE_RATIO) return "noise";
    if (hasJa && isNoise(text)) return "noise";
    if (hasJa) return "japanese";
    if (isNoise(text)) return "noise";
    return "skip";
  }

  function extractText(node) {
    const messageEl = node.querySelector("#message");
    if (!messageEl) return "";
    return (messageEl.innerText || messageEl.textContent || "").trim();
  }

  // ---------- normalization + LRU cache ----------

  function normalize(text) {
    return (text || "")
      .normalize("NFC")
      .trim()
      .replace(/\s+/g, " ")
      // Full-width digits and ASCII -> half-width
      .replace(/[！-～]/g, (ch) =>
        String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
      );
  }

  // Collapse runs of the same char (3+) down to one. Stylistic emphasis
  // like "ありがとうううう" should share a cache slot with "ありがとう".
  function collapseRepeats(text) {
    return (text || "").replace(/(.)\1{2,}/gu, "$1");
  }

  // Cache key used for storage lookups and in-flight dedup.
  function cacheKey(text) {
    return collapseRepeats(normalize(text));
  }

  // LRU using insertion-order Map.
  const cache = new Map();

  function cacheGet(key) {
    if (!cache.has(key)) return null;
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value); // move to most-recent
    return value;
  }

  function cachePut(key, value) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    scheduleCacheFlush();
  }

  let cacheFlushTimer = null;
  function scheduleCacheFlush() {
    if (cacheFlushTimer) return;
    cacheFlushTimer = setTimeout(flushCacheToStorage, CACHE_FLUSH_DEBOUNCE_MS);
  }

  function flushCacheToStorage() {
    cacheFlushTimer = null;
    const entries = Array.from(cache.entries());
    chrome.storage.local.set({ [CACHE_KEY]: { version: 1, entries } }, () => {
      if (chrome.runtime.lastError) {
        console.warn("[ylct] cache flush failed:", chrome.runtime.lastError.message);
      }
    });
  }

  function loadCacheFromStorage(done) {
    chrome.storage.local.get(CACHE_KEY, (data) => {
      if (chrome.runtime.lastError) {
        console.warn("[ylct] cache load failed:", chrome.runtime.lastError.message);
        return done && done();
      }
      const stored = data && data[CACHE_KEY];
      if (stored && Array.isArray(stored.entries)) {
        for (const [k, v] of stored.entries) {
          if (typeof k === "string" && typeof v === "string") cache.set(k, v);
        }
        console.log(`[ylct] cache loaded: ${cache.size} entries`);
      }
      done && done();
    });
  }

  // ---------- queue + batch ----------

  const stats = {
    seen: 0, japanese: 0, korean: 0, noise: 0, skip: 0,
    pending: 0, done: 0, error: 0,
    cacheHits: 0, hidden: 0, self: 0,
  };
  window.__ylctStats = () => ({ ...stats, cacheSize: cache.size });

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

  let queue = [];
  const pendingMap = new Map();
  let flushTimer = null;

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flushBatch, batchWindowMs);
  }

  function enqueue(node, id, ja) {
    queue.push({ id, ja, node });
    pendingMap.set(id, { node, ja });
    stats.pending += 1;

    if (queue.length >= MAX_BATCH_SIZE) {
      flushBatch();
    } else {
      scheduleFlush();
    }
  }

  function flushBatch() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (queue.length === 0) return;

    const batch = queue;
    queue = [];

    const items = batch.map((b) => ({ id: b.id, ja: b.ja }));
    console.log(`[ylct] flushing batch: ${items.length} item(s)`);

    // Detect "extension context invalidated" up front: chrome.runtime is gone
    // when the user reloads the extension while this page is still open.
    if (!chrome.runtime || !chrome.runtime.id) {
      const reason = "extension reloaded — refresh the page";
      console.warn("[ylct] " + reason);
      batch.forEach((b) => markError(b.id, reason));
      return;
    }

    try {
      chrome.runtime.sendMessage({ type: MSG.TRANSLATE_BATCH, items, maxTurns }, (response) => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message;
          console.warn("[ylct] sendMessage error:", msg);
          batch.forEach((b) => markError(b.id, msg));
          return;
        }
        handleBatchResponse(batch, response);
      });
    } catch (err) {
      // Throws synchronously when the runtime port is gone.
      const msg = (err && err.message) || String(err);
      console.warn("[ylct] sendMessage threw:", msg);
      batch.forEach((b) => markError(b.id, msg));
    }
  }

  function handleBatchResponse(batch, response) {
    if (!response || !response.ok) {
      const err = (response && (response.error || response.raw)) || "unknown error";
      console.warn("[ylct] translate failed:", err);
      batch.forEach((b) => markError(b.id, err));
      return;
    }

    const translated = new Set();
    for (const r of response.translations) {
      applyTranslation(r.id, r.ko);
      translated.add(r.id);
    }
    batch.forEach((b) => {
      if (!translated.has(b.id)) markError(b.id, "no translation in response");
    });

    if (response.elapsedMs != null) {
      console.log(`[ylct] batch done in ${response.elapsedMs}ms (${translated.size}/${batch.length})`);
    }
  }

  // ---------- scroll preservation ----------
  //
  // YouTube auto-scrolls the chat list only while the viewport is at the bottom.
  // Inserting our placeholder grows scrollHeight, which moves the user away from
  // "exactly at bottom" and breaks auto-scroll. We snapshot the bottom state
  // before mutating and re-pin to bottom on the next frame if it was active.

  // Threshold is generous (~3-4 message rows) so we still treat the user
  // as "at the bottom" even if YouTube has just appended a new row that
  // shifted the scroll math slightly.
  const SCROLL_BOTTOM_THRESHOLD = 150; // px

  let cachedScroller = null;

  function findScrollableAncestor(node) {
    let p = node && node.parentElement;
    while (p) {
      const cs = getComputedStyle(p);
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") &&
          p.scrollHeight > p.clientHeight) {
        return p;
      }
      p = p.parentElement;
    }
    return null;
  }

  function getChatScroller() {
    if (cachedScroller && cachedScroller.isConnected) return cachedScroller;
    // Try the well-known selectors first.
    cachedScroller =
      document.querySelector("yt-live-chat-item-list-renderer #item-scroller") ||
      document.querySelector("yt-live-chat-item-list-renderer #contents") ||
      null;
    // Fallback: walk up from the message list to the first scrollable parent.
    if (!cachedScroller && currentList) {
      cachedScroller = findScrollableAncestor(currentList);
    }
    return cachedScroller;
  }

  function isNearBottom(el) {
    if (!el) return false;
    return el.scrollHeight - (el.scrollTop + el.clientHeight) < SCROLL_BOTTOM_THRESHOLD;
  }

  function pinToBottom(scroller) {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  function preserveBottomScroll(mutateFn) {
    const scroller = getChatScroller();
    const wasAtBottom = isNearBottom(scroller);
    mutateFn();
    if (!wasAtBottom || !scroller) return;
    // Immediate pin in case YouTube already ran its auto-scroll for this tick.
    pinToBottom(scroller);
    // Second pin after layout settles (covers placeholder height growth).
    requestAnimationFrame(() => pinToBottom(scroller));
  }

  // ---------- DOM injection ----------

  function injectPlaceholder(node, id) {
    const messageEl = node.querySelector("#message");
    if (!messageEl) return null;

    const div = document.createElement("div");
    div.className = "ylct-translation";
    div.dataset.ylctState = "pending";
    div.dataset.ylctId = id;
    div.textContent = "번역 중";
    // Bottom-scroll preservation is done by the message observer callback
    // (single measure + pin per mutation tick) so we don't duplicate work.
    messageEl.insertAdjacentElement("afterend", div);
    return div;
  }

  function getInjectedEl(id) {
    const entry = pendingMap.get(id);
    if (!entry) return null;
    const node = entry.node;
    return node && node.querySelector(`.ylct-translation[data-ylct-id="${CSS.escape(id)}"]`);
  }

  function applyTranslation(id, ko) {
    const entry = pendingMap.get(id);
    const el = getInjectedEl(id);
    pendingMap.delete(id);
    stats.pending = Math.max(0, stats.pending - 1);

    // Cache the result keyed by normalized + repeat-collapsed source text.
    if (entry && entry.ja && typeof ko === "string") {
      cachePut(cacheKey(entry.ja), ko);
    }

    if (!el) return;
    preserveBottomScroll(() => {
      el.textContent = ko;
      el.dataset.ylctState = "done";
    });
    stats.done += 1;
  }

  function markError(id, reason) {
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

  // ---------- observer ----------

  function handleNode(node) {
    if (!enabled) return;
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName !== "YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER") return;
    if (node.dataset.ylctId) return;

    stats.seen += 1;
    const id = "m-" + stats.seen + "-" + Math.random().toString(36).slice(2, 8);
    node.dataset.ylctId = id;

    const text = extractText(node);
    if (!text) { stats.skip += 1; return; }

    // Skip messages the current user just sent (input-translator records them).
    if (window.__ylctSentByMe && window.__ylctSentByMe.has(text)) {
      stats.self += 1;
      return;
    }

    const verdict = classify(text);
    stats[verdict] += 1;
    if (verdict !== "japanese") return;

    // Cache lookup BEFORE placeholder + visibility check.
    // Cached translations are free, so always apply even when hidden.
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

    // Skip un-cached translation when the iframe is not visible
    // to conserve Max usage.
    if (document.hidden) {
      stats.hidden += 1;
      return;
    }

    if (!injectPlaceholder(node, id)) return;
    enqueue(node, id, text);
  }

  // YouTube re-renders the chat list when the user switches between
  // "Top chat" / "Live chat" modes. The original #items element is replaced,
  // so we watch the document for list element changes and re-attach.

  let currentList = null;
  let messageObserver = null;

  function attachToList(list) {
    if (!list || list === currentList) return;

    if (messageObserver) {
      messageObserver.disconnect();
      messageObserver = null;
    }
    currentList = list;
    cachedScroller = null; // scroller may have changed too

    // Initial backfill: only the most recent 10 messages.
    const existing = Array.from(list.querySelectorAll("yt-live-chat-text-message-renderer"));
    existing.slice(-10).forEach(handleNode);

    messageObserver = new MutationObserver((mutations) => {
      // Measure scroll state once per mutation tick, BEFORE we inject
      // any placeholders. Then process all added nodes. Finally re-pin
      // if the user was following at the bottom.
      const scroller = getChatScroller();
      const wasAtBottom = isNearBottom(scroller);

      for (const m of mutations) {
        m.addedNodes.forEach((n) => handleNode(n));
      }

      if (wasAtBottom && scroller) {
        pinToBottom(scroller);
        requestAnimationFrame(() => {
          pinToBottom(scroller);
          requestAnimationFrame(() => pinToBottom(scroller));
        });
        // Final pin after YouTube's own auto-scroll has had time to fire.
        setTimeout(() => pinToBottom(scroller), 120);
      }
    });
    messageObserver.observe(list, { childList: true, subtree: false });

    console.log(`[ylct] message observer attached (${existing.length} existing, ${Math.min(existing.length, 10)} backfilled)`);
  }

  let warmupSent = false;
  function maybeWarmup() {
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
      console.warn("[ylct] warmup threw:", err && err.message);
      warmupSent = false;
    }
  }

  function watchForList() {
    const tryAttach = () => {
      const list = document.querySelector("yt-live-chat-item-list-renderer #items");
      if (list) {
        attachToList(list);
        maybeWarmup();
      }
    };

    tryAttach();

    // Watch the whole document for list element replacement (e.g., chat
    // mode toggle, or initial late mount).
    const rootObserver = new MutationObserver(() => {
      const list = document.querySelector("yt-live-chat-item-list-renderer #items");
      if (list && list !== currentList) {
        attachToList(list);
      }
    });
    rootObserver.observe(document.documentElement, { childList: true, subtree: true });

    console.log("[ylct] M5 root watcher armed. window.__ylctStats() for counters.");
  }

  // Live-toggleable enabled state. Mirrored to window so input-translator.js
  // (separate IIFE in the same isolated world) can gate on it too.
  let enabled = false;
  let watchersAttached = false;
  window.__ylctEnabled = false;

  // Parent channel meta can mount lazily during SPA navigation. Retry with
  // backoff (up to ~30s) so the iframe doesn't stay disabled just because
  // it sampled the parent doc one tick too early.
  let parentInfoRetryTimer = null;
  const PARENT_INFO_RETRY_MS = 500;
  const PARENT_INFO_MAX_ATTEMPTS = 60;
  let parentInfoAttempts = 0;

  function clearParentInfoRetry() {
    if (parentInfoRetryTimer) {
      clearTimeout(parentInfoRetryTimer);
      parentInfoRetryTimer = null;
    }
    parentInfoAttempts = 0;
  }

  async function recomputeEnabled() {
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
    // When disabling, we leave the existing rootObserver in place but
    // handleNode/maybeWarmup short-circuit on `enabled === false`. Already
    // pending placeholders are allowed to resolve.
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function recomputeSettings() {
    chrome.storage.local.get(SETTINGS_KEY, (data) => {
      const s = (data && data[SETTINGS_KEY]) || {};

      const wantedWin = typeof s.batchWindowMs === "number" ? s.batchWindowMs : DEFAULT_BATCH_WINDOW_MS;
      const nextWin = clamp(wantedWin, MIN_BATCH_WINDOW_MS, MAX_BATCH_WINDOW_MS);
      if (nextWin !== batchWindowMs) {
        batchWindowMs = nextWin;
        console.log("[ylct] batch window updated:", batchWindowMs + "ms");
      }

      const wantedMt = typeof s.maxTurns === "number" ? s.maxTurns : 200;
      const nextMt = clamp(wantedMt, 0, 100000);
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

  function init() {
    recomputeSettings();
    recomputeEnabled();
  }

  // Flush cache to storage when the page is about to unload, and stop the
  // parent-info retry loop so it doesn't keep firing after the iframe goes
  // away during YouTube SPA navigation.
  window.addEventListener("pagehide", () => {
    if (cacheFlushTimer) {
      clearTimeout(cacheFlushTimer);
      cacheFlushTimer = null;
      flushCacheToStorage();
    }
    clearParentInfoRetry();
  });

  init();
})();
