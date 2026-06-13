// Channel detection: read the current video's owner handle + name from the
// YouTube DOM. Handle detection is scoped to the video owner row so that
// /@mentions in the description, recommended videos, or comments can never be
// mistaken for the current channel.

import type { ChannelInfo } from "./constants";

const CHANNEL_NAME_SOURCES: ReadonlyArray<{ sel: string; attr: string | null }> = Object.freeze([
  { sel: "ytd-channel-name yt-formatted-string a", attr: null },
  { sel: "ytd-channel-name yt-formatted-string", attr: null },
  { sel: "#owner #channel-name yt-formatted-string", attr: null },
]);

// The video owner row (channel link + name shown under the player).
const OWNER_SCOPE_SELECTORS: ReadonlyArray<string> = Object.freeze([
  "ytd-video-owner-renderer",
  "#owner",
]);

function hasLiveChatFrame(doc: Document): boolean {
  return !!doc.querySelector("ytd-live-chat-frame");
}

function findOwnerScope(doc: Document): Element | null {
  for (const sel of OWNER_SCOPE_SELECTORS) {
    const el = doc.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function readHandleFromOwner(owner: Element): string | null {
  const anchors = owner.querySelectorAll<HTMLAnchorElement>('a[href^="/@"]');
  for (const a of Array.from(anchors)) {
    const href = a.getAttribute("href") || "";
    const m = href.match(/^\/(@[^/?#]+)/);
    if (m) return m[1];
  }
  return null;
}

function readChannelName(owner: Element, doc: Document): string | null {
  for (const { sel, attr } of CHANNEL_NAME_SOURCES) {
    const el = owner.querySelector(sel) || doc.querySelector(sel);
    if (!el) continue;
    const v = attr ? el.getAttribute(attr) : el.textContent;
    if (v && v.trim()) return v.trim();
  }
  return null;
}

export function readChannelInfoFromDocument(doc: Document | null | undefined): ChannelInfo | null {
  try {
    if (!doc) return null;
    if (!hasLiveChatFrame(doc)) return null;

    const owner = findOwnerScope(doc);
    if (!owner) return null;

    const handle = readHandleFromOwner(owner);
    if (!handle) return null;

    return { handle, channelName: readChannelName(owner, doc) };
  } catch {
    return null;
  }
}
