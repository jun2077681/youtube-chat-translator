// LRU translation cache (normalized source text -> translation), persisted to
// chrome.storage.local with a debounced flush. Self-contained: owns the Map and
// the flush timer, exposes get/put plus load and an immediate flush for pagehide.

import { KEY } from "../shared/constants";

const CACHE_KEY = KEY.CACHE;
const CACHE_MAX_ENTRIES = 2000;
const CACHE_FLUSH_DEBOUNCE_MS = 5_000;

const cache = new Map<string, string>();

interface StoredCache {
  version: number;
  entries: Array<[string, string]>;
}

let cacheFlushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCacheFlush(): void {
  if (cacheFlushTimer) return;
  cacheFlushTimer = setTimeout(flushCacheToStorage, CACHE_FLUSH_DEBOUNCE_MS);
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

export function cacheSize(): number {
  return cache.size;
}

export function cacheGet(key: string): string | null {
  if (!cache.has(key)) return null;
  const value = cache.get(key)!;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

export function cachePut(key: string, value: string): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  scheduleCacheFlush();
}

export function loadCacheFromStorage(done?: () => void): void {
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

// Cancel any pending debounced flush and write immediately. Used on pagehide so
// the latest entries are not lost when the tab unloads.
export function flushCacheNow(): void {
  if (cacheFlushTimer) {
    clearTimeout(cacheFlushTimer);
    cacheFlushTimer = null;
    flushCacheToStorage();
  }
}
