// Content script entry point (runs in the live-chat iframe). Wires the pipeline
// modules together and owns the page lifecycle: whitelist/channel gating,
// settings, and the visibility/pagehide handlers. The actual work lives in:
//   chat-observer  — watch the chat DOM, backfill, warmup
//   batch-queue    — classify/dedupe/batch/apply translations
//   translation-cache, chat-dom, background-bridge, stats, domain/*

import {
  KEY,
  MSG,
  SETTINGS_DEFAULTS,
  type ChannelInfo,
  type Settings,
  type WhitelistEntry,
} from "../shared/constants";
import { readChannelInfoFromDocument } from "../shared/channel";
import { stats } from "./stats";
import { cacheSize, loadCacheFromStorage, flushCacheNow } from "./translation-cache";
import { scrollerDebugSnapshot } from "./chat-dom";
import * as queue from "./batch-queue";
import * as observer from "./chat-observer";

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
  const WHITELIST_KEY = KEY.WHITELIST;
  const SETTINGS_KEY = KEY.SETTINGS;

  let batchWindowMs = DEFAULT_BATCH_WINDOW_MS;
  let maxTurns = SETTINGS_DEFAULTS.maxTurns;
  let enabled = false;
  let watchersAttached = false;
  window.__ylctEnabled = false;

  // Wire the cross-module dependencies (avoids import cycles between the queue
  // and observer; both read the live `enabled` flag and current chat list).
  queue.configure({ isEnabled: () => enabled, getCurrentList: () => observer.getCurrentList() });
  observer.configure({ isEnabled: () => enabled });

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

  window.__ylctStats = () => ({
    ...stats,
    cacheSize: cacheSize(),
    ...queue.debugCounts(),
  });

  window.__ylctDebug = () => scrollerDebugSnapshot(observer.getCurrentList());

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
          document.addEventListener("DOMContentLoaded", observer.watchForList, { once: true });
        } else {
          observer.watchForList();
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
        queue.setBatchWindowMs(batchWindowMs);
        console.log("[ylct] batch window updated:", batchWindowMs + "ms");
      }

      const nextMt = pickNumber(s.maxTurns, SETTINGS_DEFAULTS.maxTurns, 0, 100000);
      if (nextMt !== maxTurns) {
        maxTurns = nextMt;
        queue.setMaxTurns(maxTurns);
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
    flushCacheNow();
    clearParentInfoRetry();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      // (b) Tab hidden: cancel the pending auto-flush so a queued batch isn't
      // translated in the background. New enqueues are already blocked while
      // hidden (see the document.hidden guard in batch-queue.handleNode), and we
      // intentionally keep the local queue intact so injected placeholders stay
      // consistent — it flushes naturally once the tab is visible again. Only
      // content-local state is touched here, never the shared host session
      // (which other visible tabs may be using).
      queue.cancelScheduledFlush();
    } else if (enabled) {
      // (a) Tab visible again: the per-tab host session may have idled out while
      // hidden, so re-trigger warmup to avoid a cold start on the first message.
      observer.resetWarmup();
      observer.maybeWarmup();
      // (c) Backfill the most recent messages just like on first attach, so the
      // chat that scrolled past while the tab was hidden gets translated.
      observer.backfillCurrent();
    }
  });

  init();
})();
