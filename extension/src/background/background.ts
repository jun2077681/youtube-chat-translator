// Service worker entry point. Caches the selected provider and routes
// popup/content-script messages to the translation use-cases. The Native
// Messaging transport lives in host-port.ts; the use-cases in translate.ts.

import {
  KEY,
  MSG,
  PROVIDER_DEFAULT,
  isProvider,
  type BatchItem,
  type Provider,
} from "../shared/constants";
import { sendToHost, hasActivePort } from "./host-port";
import {
  pingHost,
  resetSession,
  testTranslate,
  translateBatch,
  translateKoToJa,
  warmup,
} from "./translate";

// Selected provider, cached in memory so the translate hot path doesn't hit
// chrome.storage on every call. The native host routes each translate/reset
// call to the matching CLI; default to Claude when unset.
let provider: Provider = PROVIDER_DEFAULT;

function readProvider(settings: unknown): Provider {
  const s = settings as { provider?: unknown } | undefined;
  return isProvider(s && s.provider) ? (s!.provider as Provider) : PROVIDER_DEFAULT;
}

chrome.storage.local.get(KEY.SETTINGS, (data) => { provider = readProvider(data && data[KEY.SETTINGS]); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[KEY.SETTINGS]) provider = readProvider(changes[KEY.SETTINGS].newValue);
});

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type InboundMessage =
  | { type: typeof MSG.PING_HOST }
  | { type: typeof MSG.TEST_TRANSLATE; provider: Provider; text: string }
  | { type: typeof MSG.TRANSLATE_BATCH; items: BatchItem[]; maxTurns?: number }
  | { type: typeof MSG.TRANSLATE_KO_TO_JA; text: string }
  // tabId is supplied by the popup (whose own sender.tab is the popup, not the
  // target YouTube tab) so the host resets the right per-tab session.
  | { type: typeof MSG.RESET_SESSION; tabId?: number }
  | { type: typeof MSG.WARMUP };

function respond<T>(work: Promise<T>, sendResponse: (r: unknown) => void): true {
  work
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: errMsg(err) }));
  return true;
}

chrome.runtime.onMessage.addListener(
  (message: InboundMessage, sender, sendResponse: (response: unknown) => void) => {
    if (!message || typeof message !== "object") return false;

    // Content-script messages carry the originating tab; use its id as the
    // per-tab session key. Falls back to "default" when absent (e.g. popup).
    const senderKey = String(sender.tab?.id ?? "default");

    switch (message.type) {
      case MSG.PING_HOST:          return respond(pingHost(), sendResponse);
      case MSG.TEST_TRANSLATE:     return respond(testTranslate(message.provider, message.text), sendResponse);
      case MSG.TRANSLATE_BATCH:    return respond(translateBatch(provider, message.items || [], message.maxTurns || 0, senderKey), sendResponse);
      case MSG.TRANSLATE_KO_TO_JA: return respond(translateKoToJa(provider, String(message.text || ""), senderKey), sendResponse);
      case MSG.RESET_SESSION:      return respond(resetSession(provider, message.tabId != null ? String(message.tabId) : senderKey), sendResponse);
      case MSG.WARMUP:             return respond(warmup(provider, senderKey), sendResponse);
      default:                     return false;
    }
  }
);

// When a tab closes, tear down its per-tab session in the host so the CLI
// process doesn't linger until idle timeout. Only act when a host port is
// already live — no port means no sessions, and we must not spawn the host
// just to clean up (onRemoved fires for every tab, not only YouTube ones).
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!hasActivePort()) return;
  sendToHost({ type: "close_session", provider, sessionKey: String(tabId) })
    .catch(() => { /* host may be down; idle timeout is the backstop */ });
});
