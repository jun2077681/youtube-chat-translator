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
    WHITELIST: "ylct:whitelist:v1",
    SETTINGS: "ylct:settings:v1",
    CACHE: "ylct:cache:v1",
  });

  const SETTINGS_DEFAULTS = Object.freeze({
    batchWindowMs: 15000,
    maxTurns: 200,
  });

  const CHANNEL_ID_SELECTORS = Object.freeze([
    'meta[itemprop="channelId"]',
    'meta[itemprop="identifier"]',
  ]);

  const CHANNEL_NAME_SOURCES = Object.freeze([
    { sel: 'span[itemprop="author"] link[itemprop="name"]', attr: "content" },
    { sel: "ytd-channel-name yt-formatted-string", attr: null },
    { sel: "#owner #channel-name yt-formatted-string", attr: null },
  ]);

  function readChannelInfoFromDocument(doc) {
    try {
      if (!doc) return null;

      let channelId = null;
      for (const sel of CHANNEL_ID_SELECTORS) {
        const el = doc.querySelector(sel);
        if (el && el.content) { channelId = el.content; break; }
      }
      if (!channelId) return null;

      let channelName = null;
      for (const { sel, attr } of CHANNEL_NAME_SOURCES) {
        const el = doc.querySelector(sel);
        if (!el) continue;
        const v = attr ? el.getAttribute(attr) : el.textContent;
        if (v && v.trim()) { channelName = v.trim(); break; }
      }
      return { channelId, channelName };
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
