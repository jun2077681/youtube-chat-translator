// Shared constants and helpers for YLCT.
// Side-effect only: assigns `globalThis.YLCT_CONST`. No exports.
// Loaded as a classic <script> in popup, the first entry of each content_scripts
// list, and a side-effect `import` in the service worker.

"use strict";

(() => {
  const MSG = Object.freeze({
    PING_HOST: "PING_HOST",
    CALL_CLAUDE: "CALL_CLAUDE",
    TRANSLATE_BATCH: "TRANSLATE_BATCH",
    TRANSLATE_KO_TO_JA: "TRANSLATE_KO_TO_JA",
    RESET_SESSION: "RESET_SESSION",
    WARMUP: "WARMUP",
    GET_CHANNEL_INFO: "GET_CHANNEL_INFO",
  });

  const KEY = Object.freeze({
    // v2: keyed by @handle instead of channelId.
    WHITELIST: "ylct:whitelist:v2",
    SETTINGS: "ylct:settings:v1",
    CACHE: "ylct:cache:v1",
  });

  const SETTINGS_DEFAULTS = Object.freeze({
    batchWindowMs: 15000,
    maxTurns: 200,
  });

  const CHANNEL_NAME_SOURCES = Object.freeze([
    { sel: "ytd-channel-name yt-formatted-string a", attr: null },
    { sel: "ytd-channel-name yt-formatted-string", attr: null },
    { sel: "#owner #channel-name yt-formatted-string", attr: null },
  ]);

  // Areas that host the viewer's own /@me links (NOT the watched streamer).
  const HANDLE_EXCLUDE_HOSTS = Object.freeze([
    "ytd-masthead",
    "tp-yt-iron-dropdown",
    "ytd-popup-container",
    "ytd-account-section-list-renderer",
    "ytd-mini-guide-renderer",
    "ytd-guide-renderer",
  ]);

  function hasLiveChatFrame(doc) {
    return !!doc.querySelector("ytd-live-chat-frame");
  }

  // Gating on the chat frame keeps non-watch surfaces (home, search,
  // channel pages) from resolving to whichever /@handle they happen to
  // render first.
  function readChannelInfoFromDocument(doc) {
    try {
      if (!doc) return null;
      if (!hasLiveChatFrame(doc)) return null;

      // The watched video's owner section renders before the recommendations
      // in DOM order, so the first body-level /@handle anchor outside the
      // viewer's masthead/guide/popups is reliably the streamer.
      const anchors = doc.querySelectorAll('a[href^="/@"]');
      let handle = null;
      for (const a of anchors) {
        let inExcluded = false;
        for (const host of HANDLE_EXCLUDE_HOSTS) {
          if (a.closest && a.closest(host)) { inExcluded = true; break; }
        }
        if (inExcluded) continue;
        const href = a.getAttribute("href") || "";
        const m = href.match(/^\/(@[^/?#]+)/);
        if (m) { handle = m[1]; break; }
      }
      if (!handle) return null;

      let channelName = null;
      for (const { sel, attr } of CHANNEL_NAME_SOURCES) {
        const el = doc.querySelector(sel);
        if (!el) continue;
        const v = attr ? el.getAttribute(attr) : el.textContent;
        if (v && v.trim()) { channelName = v.trim(); break; }
      }
      return { handle, channelName };
    } catch (_) {
      return null;
    }
  }

  globalThis.YLCT_CONST = Object.freeze({
    MSG,
    KEY,
    SETTINGS_DEFAULTS,
    readChannelInfoFromDocument,
  });
})();
