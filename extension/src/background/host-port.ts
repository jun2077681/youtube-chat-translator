// Single persistent Native Messaging port to the host, with request/response
// correlation by id and a per-request timeout. Owns the port and the pending
// map; everything else talks to the host through sendToHost().

import { type HostReply, type Provider } from "../shared/constants";

const HOST_NAME = "com.ylct.translator";
const REQUEST_TIMEOUT_MS = 35_000;

export interface HostRequest {
  type: string;
  id?: string;
  prompt?: string;
  provider?: Provider;
  direction?: "ja_to_ko" | "ko_to_ja";
  maxTurns?: number;
  timeoutMs?: number;
  // Per-tab session key (Chrome tab id as string) so the host isolates each
  // tab's persistent translation session.
  sessionKey?: string;
  withModel?: boolean;
}

interface PendingEntry {
  resolve: (value: HostReply) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let port: chrome.runtime.Port | null = null;
const pending = new Map<string, PendingEntry>();

export function randomId(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 10);
}

// True when a host port is currently live. Used to avoid spawning the host just
// to clean up (e.g. tabs.onRemoved fires for every tab, not only YouTube ones).
export function hasActivePort(): boolean {
  return port !== null;
}

function ensurePort(): chrome.runtime.Port {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST_NAME);

  port.onMessage.addListener((msg: HostReply & { id?: string }) => {
    const id = msg && msg.id;
    const entry = id ? pending.get(id) : undefined;
    if (!entry) {
      console.warn("[ylct] response for unknown id:", id, msg);
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(id!);
    entry.resolve(msg);
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    const reason = (err && err.message) || "native host disconnected";
    console.warn("[ylct] native port disconnected:", reason);
    port = null;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    pending.clear();
  });

  return port;
}

export function sendToHost(payload: HostRequest): Promise<HostReply> {
  return new Promise((resolve, reject) => {
    let p: chrome.runtime.Port;
    try {
      p = ensurePort();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const id = payload.id || randomId("req-");
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`request timeout after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });
    try {
      p.postMessage({ ...payload, id });
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
