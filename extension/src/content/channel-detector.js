// Lightweight content script for YouTube /watch pages.
// Sole purpose: respond to popup's GET_CHANNEL_INFO query so the user can
// add the current channel to the whitelist.

(() => {
  "use strict";

  if (window.__ylctChannelDetectorLoaded) return;
  window.__ylctChannelDetectorLoaded = true;

  const { MSG, readChannelInfoFromDocument } = globalThis.YLCT_CONST;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === MSG.GET_CHANNEL_INFO) {
      const info = readChannelInfoFromDocument(document);
      sendResponse(info || { channelId: null, channelName: null });
      return false;
    }
    return false;
  });
})();
