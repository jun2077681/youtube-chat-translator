// Translation pipeline: classify an incoming chat node, dedupe against in-flight
// and cached translations, batch the rest, send to the background worker, and
// apply results back to the DOM. Owns the queue / pending / in-flight state.
//
// Cross-module needs (the enabled flag and the current chat list) are injected
// by the entry point via configure() so this module never imports the observer
// or lifecycle code — keeping the dependency graph one-directional.

import { type BatchItem, type BatchResponse, type Translation, SETTINGS_DEFAULTS } from "../shared/constants";
import { classify } from "../domain/classify";
import { cacheKey } from "../domain/normalize";
import { cacheGet, cachePut } from "./translation-cache";
import { extractText, injectPlaceholder, getInjectedEl, preserveBottomScroll } from "./chat-dom";
import { isRuntimeAlive, sendTranslateBatch } from "./background-bridge";
import { stats } from "./stats";

const MAX_BATCH_SIZE = 30;
const SAMPLING_SOFT = 40;
const SAMPLING_HARD = 80;

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

interface Deps {
  isEnabled: () => boolean;
  getCurrentList: () => HTMLElement | null;
}

let deps: Deps = { isEnabled: () => false, getCurrentList: () => null };

export function configure(d: Deps): void {
  deps = d;
}

let queue: QueueItem[] = [];
const pendingMap = new Map<string, PendingEntry>();
const inflightByKey = new Map<string, Set<string>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

let batchWindowMs = SETTINGS_DEFAULTS.batchWindowMs;
let maxTurns = SETTINGS_DEFAULTS.maxTurns;

export function setBatchWindowMs(ms: number): void {
  batchWindowMs = ms;
}

export function setMaxTurns(n: number): void {
  maxTurns = n;
}

export function debugCounts(): { inflightKeys: number; queueLen: number } {
  return { inflightKeys: inflightByKey.size, queueLen: queue.length };
}

// Clear all pipeline state. Used when (re)attaching to a new chat list.
export function resetQueueState(): void {
  queue.length = 0;
  pendingMap.clear();
  inflightByKey.clear();
  stats.pending = 0;
}

// Cancel a pending auto-flush without discarding the queued items. Used when the
// tab is hidden so a batch isn't translated in the background; it flushes again
// naturally once the tab is visible and a new node arrives.
export function cancelScheduledFlush(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
}

function shouldDrop(): boolean {
  const load = queue.length + pendingMap.size;
  if (load >= SAMPLING_HARD) return Math.random() < 0.75;
  if (load >= SAMPLING_SOFT) return Math.random() < 0.5;
  return false;
}

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

  const items: BatchItem[] = batch.map((b) => ({ id: b.id, ja: b.ja }));
  console.log(`[ylct] flushing batch: ${items.length} item(s)`);

  if (!isRuntimeAlive()) {
    const reason = "extension reloaded — refresh the page";
    console.warn("[ylct] " + reason);
    failAll(batch, reason);
    return;
  }

  sendTranslateBatch(items, maxTurns)
    .then((response) => handleBatchResponse(batch, response))
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[ylct] sendMessage error:", msg);
      failAll(batch, msg);
    });
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

function applyTranslation(id: string, ko: string): void {
  const entry = pendingMap.get(id);
  const el = getInjectedEl(entry && entry.node, id);
  pendingMap.delete(id);
  stats.pending = Math.max(0, stats.pending - 1);

  if (entry && entry.ja && typeof ko === "string") {
    cachePut(entry.key || cacheKey(entry.ja), ko);
  }

  if (!el) return;
  preserveBottomScroll(deps.getCurrentList(), () => {
    el.textContent = ko;
    el.dataset.ylctState = "done";
  });
  stats.done += 1;
}

function markError(id: string, reason: string): void {
  const entry = pendingMap.get(id);
  const el = getInjectedEl(entry && entry.node, id);
  pendingMap.delete(id);
  stats.pending = Math.max(0, stats.pending - 1);
  if (!el) return;
  preserveBottomScroll(deps.getCurrentList(), () => {
    el.textContent = "번역 실패";
    el.title = String(reason || "");
    el.dataset.ylctState = "error";
  });
  stats.error += 1;
}

// Ingest a single chat node: filter, classify, dedupe, and enqueue for
// translation (or apply a cached translation immediately).
export function handleNode(node: Node): void {
  if (!deps.isEnabled()) return;
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
