// Thin messaging layer between the content script and the background service
// worker. Wraps chrome.runtime.sendMessage in promises; callers decide how to
// react to success/failure. Keeps the queue/observer logic free of raw
// messaging plumbing.

import { MSG, type BatchItem, type BatchResponse } from "../shared/constants";

// True only when the extension context is still valid. After an extension
// reload the content script keeps running but chrome.runtime.id goes undefined.
export function isRuntimeAlive(): boolean {
  return !!(chrome.runtime && chrome.runtime.id);
}

// Resolves with the host's batch response (which may itself be { ok: false });
// rejects only on a messaging-layer failure (lastError or a thrown call).
export function sendTranslateBatch(items: BatchItem[], maxTurns: number): Promise<BatchResponse | undefined> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(
        { type: MSG.TRANSLATE_BATCH, items, maxTurns },
        (response: BatchResponse | undefined) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || "sendMessage error"));
            return;
          }
          resolve(response);
        }
      );
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function sendWarmup(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type: MSG.WARMUP }, (reply) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || "warmup error"));
          return;
        }
        resolve(reply);
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
