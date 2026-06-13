// DOM rendering + scroll-pinning for the live-chat list. Pure DOM concerns: read
// a message's text, inject/locate the translation placeholder, and keep the
// chat pinned to the bottom while we mutate it. Owns only the cached scroller
// element; `currentList` is passed in by the observer (its owner) so this module
// stays free of observer state and import cycles.

const SCROLL_BOTTOM_THRESHOLD = 150;

let cachedScroller: HTMLElement | null = null;

export function extractText(node: HTMLElement): string {
  const messageEl = node.querySelector<HTMLElement>("#message");
  if (!messageEl) return "";
  return (messageEl.innerText || messageEl.textContent || "").trim();
}

export function injectPlaceholder(node: HTMLElement, id: string): HTMLDivElement | null {
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

export function getInjectedEl(node: HTMLElement | null | undefined, id: string): HTMLElement | null {
  return (node && node.querySelector<HTMLElement>(`.ylct-translation[data-ylct-id="${CSS.escape(id)}"]`)) || null;
}

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

export function getChatScroller(currentList: HTMLElement | null): HTMLElement | null {
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

export function resetScrollerCache(): void {
  cachedScroller = null;
}

export function isNearBottom(el: HTMLElement | null): boolean {
  if (!el) return false;
  return el.scrollHeight - (el.scrollTop + el.clientHeight) < SCROLL_BOTTOM_THRESHOLD;
}

export function pinToBottom(scroller: HTMLElement | null): void {
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

export function pinToBottomBurst(scroller: HTMLElement, frames: number): void {
  pinToBottom(scroller);
  if (frames <= 0) return;
  requestAnimationFrame(() => pinToBottomBurst(scroller, frames - 1));
}

export function preserveBottomScroll(currentList: HTMLElement | null, mutateFn: () => void): void {
  const scroller = getChatScroller(currentList);
  const wasAtBottom = isNearBottom(scroller);
  mutateFn();
  if (wasAtBottom && scroller) pinToBottomBurst(scroller, 1);
}

// Snapshot for window.__ylctDebug(). Includes both scroller and current-list
// fields so the debug output shape is unchanged from the original inline hook.
export function scrollerDebugSnapshot(currentList: HTMLElement | null): unknown {
  const scroller = getChatScroller(currentList);
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
}
