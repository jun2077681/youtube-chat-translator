// Service worker. Routes popup/content-script requests to the native host
// over a single persistent Native Messaging port.

import {
  MSG,
  type BatchItem,
  type BatchResponse,
  type HostReply,
  type KoToJaResponse,
  type Translation,
} from "../shared/constants";

const HOST_NAME = "com.ylct.translator";
const REQUEST_TIMEOUT_MS = 35_000;

interface PendingEntry {
  resolve: (value: HostReply) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface HostRequest {
  type: string;
  id?: string;
  prompt?: string;
  direction?: "ja_to_ko" | "ko_to_ja";
  maxTurns?: number;
  timeoutMs?: number;
}

let port: chrome.runtime.Port | null = null;
const pending = new Map<string, PendingEntry>();

function ensurePort(): chrome.runtime.Port {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST_NAME);

  port.onMessage.addListener((msg: HostReply & { id?: string }) => {
    const id = msg && msg.id;
    if (!id || !pending.has(id)) {
      console.warn("[ylct] response for unknown id:", id, msg);
      return;
    }
    const entry = pending.get(id)!;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(msg);
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    console.warn("[ylct] native port disconnected:", err && err.message);
    port = null;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(err && err.message ? err.message : "native host disconnected"));
    }
    pending.clear();
  });

  return port;
}

function sendToHost(payload: HostRequest): Promise<HostReply> {
  return new Promise((resolve, reject) => {
    let p: chrome.runtime.Port;
    try {
      p = ensurePort();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const id = payload.id || "req-" + Math.random().toString(36).slice(2, 10);
    const msg = { ...payload, id };

    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`request timeout after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });
    try {
      p.postMessage(msg);
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function buildPrompt(items: BatchItem[]): string {
  return JSON.stringify({ items: items.map((it) => ({ id: it.id, ja: it.ja })) });
}

interface ParsedResults {
  results?: Array<{ id?: string; ko?: string; ja?: string }>;
}

function parseClaudeJson(text: string | undefined): ParsedResults | null {
  if (!text) return null;
  let s = String(text).trim();

  const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) s = fenceMatch[1].trim();

  try {
    return JSON.parse(s) as ParsedResults;
  } catch {
    /* fall through */
  }

  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(s.slice(first, last + 1)) as ParsedResults;
    } catch {
      /* fall through */
    }
  }
  return null;
}

async function translateBatch(items: BatchItem[], maxTurns: number = 0): Promise<BatchResponse> {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: true, translations: [] };
  }

  const prompt = buildPrompt(items);
  const reply = await sendToHost({ type: "translate", prompt, maxTurns, timeoutMs: 30_000 });

  if (!reply.ok) {
    return { ok: false, error: reply.error || "host error", stderr: reply.stderr };
  }

  const parsed = parseClaudeJson(reply.text);
  if (!parsed || !Array.isArray(parsed.results)) {
    return { ok: false, error: "parse failed", raw: reply.text };
  }

  const knownIds = new Set(items.map((i) => i.id));
  const translations: Translation[] = parsed.results
    .filter((r): r is { id: string; ko: string } =>
      !!r && typeof r.id === "string" && knownIds.has(r.id) && typeof r.ko === "string"
    )
    .map((r) => ({ id: r.id, ko: r.ko }));

  return { ok: true, translations, elapsedMs: reply.elapsedMs };
}

type InboundMessage =
  | { type: typeof MSG.PING_HOST }
  | { type: typeof MSG.CALL_CLAUDE; prompt: string }
  | { type: typeof MSG.TRANSLATE_BATCH; items: BatchItem[]; maxTurns?: number }
  | { type: typeof MSG.TRANSLATE_KO_TO_JA; text: string }
  | { type: typeof MSG.RESET_SESSION }
  | { type: typeof MSG.WARMUP };

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

chrome.runtime.onMessage.addListener(
  (message: InboundMessage, _sender, sendResponse: (response: unknown) => void) => {
    if (!message || typeof message !== "object") return false;

    if (message.type === MSG.PING_HOST) {
      sendToHost({ type: "ping" })
        .then((reply) => sendResponse({ ok: true, reply }))
        .catch((err) => sendResponse({ ok: false, error: errMsg(err) }));
      return true;
    }

    if (message.type === MSG.CALL_CLAUDE) {
      sendToHost({ type: "translate", prompt: message.prompt, timeoutMs: 30_000 })
        .then((reply) => sendResponse({ ok: true, reply }))
        .catch((err) => sendResponse({ ok: false, error: errMsg(err) }));
      return true;
    }

    if (message.type === MSG.TRANSLATE_BATCH) {
      translateBatch(message.items || [], message.maxTurns || 0)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: errMsg(err) }));
      return true;
    }

    if (message.type === MSG.RESET_SESSION) {
      sendToHost({ type: "reset_session", timeoutMs: 5_000 })
        .then((reply) => sendResponse({ ok: !!(reply && reply.ok), elapsedMs: reply && reply.elapsedMs }))
        .catch((err) => sendResponse({ ok: false, error: errMsg(err) }));
      return true;
    }

    if (message.type === MSG.WARMUP) {
      sendToHost({
        type: "translate",
        direction: "ja_to_ko",
        prompt: JSON.stringify({ items: [{ id: "warmup", ja: "テスト" }] }),
        timeoutMs: 30_000,
      })
        .then((reply) => sendResponse({ ok: !!(reply && reply.ok), elapsedMs: reply && reply.elapsedMs }))
        .catch((err) => sendResponse({ ok: false, error: errMsg(err) }));
      return true;
    }

    if (message.type === MSG.TRANSLATE_KO_TO_JA) {
      const text = String(message.text || "").trim();
      if (!text) {
        sendResponse({ ok: false, error: "empty input" } satisfies KoToJaResponse);
        return true;
      }
      const id = "k-" + Math.random().toString(36).slice(2, 8);
      const prompt = JSON.stringify({ items: [{ id, ko: text }] });
      sendToHost({ type: "translate", direction: "ko_to_ja", prompt, timeoutMs: 30_000 })
        .then((reply) => {
          if (!reply.ok) {
            sendResponse({ ok: false, error: reply.error || "host error" } satisfies KoToJaResponse);
            return;
          }
          const parsed = parseClaudeJson(reply.text);
          const result = parsed && Array.isArray(parsed.results) && parsed.results[0];
          if (result && typeof result.ja === "string") {
            sendResponse({ ok: true, ja: result.ja, elapsedMs: reply.elapsedMs } satisfies KoToJaResponse);
          } else {
            sendResponse({ ok: false, error: "no translation in response", raw: reply.text } satisfies KoToJaResponse);
          }
        })
        .catch((err) => sendResponse({ ok: false, error: errMsg(err) } satisfies KoToJaResponse));
      return true;
    }

    return false;
  }
);
