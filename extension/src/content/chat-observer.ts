// Watches the live-chat DOM: attaches a MutationObserver to the message list,
// re-attaches when YouTube swaps the list (mode changes), backfills recent
// messages on attach / tab re-activation, and warms up the host session. Owns
// the current list reference and the warmup latch.
//
// Feeds each added/backfilled node to the batch-queue pipeline; the enabled flag
// is injected via configure() to avoid importing lifecycle code.

import { handleNode, resetQueueState } from "./batch-queue";
import {
  getChatScroller,
  isNearBottom,
  pinToBottom,
  pinToBottomBurst,
  resetScrollerCache,
} from "./chat-dom";
import { isRuntimeAlive, sendWarmup } from "./background-bridge";

const BACKFILL_COUNT = 10;

interface Deps {
  isEnabled: () => boolean;
}

let deps: Deps = { isEnabled: () => false };

export function configure(d: Deps): void {
  deps = d;
}

let currentList: HTMLElement | null = null;
let messageObserver: MutationObserver | null = null;

export function getCurrentList(): HTMLElement | null {
  return currentList;
}

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

export function backfillCurrent(): void {
  if (currentList) backfillRecent(currentList);
}

function attachToList(list: HTMLElement): void {
  if (!list || list === currentList) return;

  if (messageObserver) {
    messageObserver.disconnect();
    messageObserver = null;
  }
  resetQueueState();
  currentList = list;
  resetScrollerCache();

  const backfilled = backfillRecent(list);

  messageObserver = new MutationObserver((mutations) => {
    const scroller = getChatScroller(currentList);
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

export function resetWarmup(): void {
  warmupSent = false;
}

export function maybeWarmup(): void {
  if (!deps.isEnabled()) return;
  if (warmupSent) return;
  if (!isRuntimeAlive()) return;
  warmupSent = true;
  sendWarmup()
    .then((reply) => console.log("[ylct] warmup done:", reply))
    .catch((err) => {
      console.warn("[ylct] warmup error:", err instanceof Error ? err.message : err);
      warmupSent = false;
    });
}

export function watchForList(): void {
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
