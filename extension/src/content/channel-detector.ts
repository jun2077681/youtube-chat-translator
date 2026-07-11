// Lightweight content script for YouTube /watch pages.
// Sole purpose: respond to popup's GET_CHANNEL_INFO query so the user can
// add the current channel to the whitelist.

import { MSG } from "../shared/constants";
import { readChannelInfoFromDocument } from "../shared/channel";

declare global {
  interface Window {
    __ylctChannelDetectorLoaded?: boolean;
  }
}

(() => {
  if (window.__ylctChannelDetectorLoaded) return;
  window.__ylctChannelDetectorLoaded = true;

  chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
    if (msg && msg.type === MSG.GET_CHANNEL_INFO) {
      const info = readChannelInfoFromDocument(document);
      sendResponse(info || { handle: null, channelName: null });
      return false;
    }
    return false;
  });
})();
