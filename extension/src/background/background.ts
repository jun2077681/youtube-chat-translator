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
const HOST_TIMEOUT_MS = 30_000;

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

function randomId(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 10);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

function sendToHost(payload: HostRequest): Promise<HostReply> {
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

interface ParsedResults {
  results?: Array<{ id?: string; ko?: string; ja?: string }>;
}

function parseClaudeJson(text: string | undefined): ParsedResults | null {
  if (!text) return null;
  let s = text.trim();

  const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) s = fenceMatch[1].trim();

  try { return JSON.parse(s) as ParsedResults; } catch { /* try slice below */ }

  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)) as ParsedResults; } catch { /* give up */ }
  }
  return null;
}

async function translateBatch(items: BatchItem[], maxTurns = 0): Promise<BatchResponse> {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: true, translations: [] };
  }

  const prompt = JSON.stringify({ items: items.map((it) => ({ id: it.id, ja: it.ja })) });
  const reply = await sendToHost({ type: "translate", prompt, maxTurns, timeoutMs: HOST_TIMEOUT_MS });

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

async function translateKoToJa(text: string): Promise<KoToJaResponse> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "empty input" };

  const prompt = JSON.stringify({ items: [{ id: randomId("k-"), ko: trimmed }] });
  const reply = await sendToHost({ type: "translate", direction: "ko_to_ja", prompt, timeoutMs: HOST_TIMEOUT_MS });
  if (!reply.ok) return { ok: false, error: reply.error || "host error" };

  const result = parseClaudeJson(reply.text)?.results?.[0];
  if (result && typeof result.ja === "string") {
    return { ok: true, ja: result.ja, elapsedMs: reply.elapsedMs };
  }
  return { ok: false, error: "no translation in response", raw: reply.text };
}

async function pingHost(): Promise<unknown> {
  return { ok: true, reply: await sendToHost({ type: "ping" }) };
}

async function callClaude(prompt: string): Promise<unknown> {
  return { ok: true, reply: await sendToHost({ type: "translate", prompt, timeoutMs: HOST_TIMEOUT_MS }) };
}

async function resetSession(): Promise<unknown> {
  const reply = await sendToHost({ type: "reset_session", timeoutMs: 5_000 });
  return { ok: !!reply.ok, elapsedMs: reply.elapsedMs };
}

async function warmup(): Promise<unknown> {
  const reply = await sendToHost({
    type: "translate",
    direction: "ja_to_ko",
    prompt: JSON.stringify({ items: [{ id: "warmup", ja: "テスト" }] }),
    timeoutMs: HOST_TIMEOUT_MS,
  });
  return { ok: !!reply.ok, elapsedMs: reply.elapsedMs };
}

type InboundMessage =
  | { type: typeof MSG.PING_HOST }
  | { type: typeof MSG.CALL_CLAUDE; prompt: string }
  | { type: typeof MSG.TRANSLATE_BATCH; items: BatchItem[]; maxTurns?: number }
  | { type: typeof MSG.TRANSLATE_KO_TO_JA; text: string }
  | { type: typeof MSG.RESET_SESSION }
  | { type: typeof MSG.WARMUP };

function respond<T>(work: Promise<T>, sendResponse: (r: unknown) => void): true {
  work
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: errMsg(err) }));
  return true;
}

chrome.runtime.onMessage.addListener(
  (message: InboundMessage, _sender, sendResponse: (response: unknown) => void) => {
    if (!message || typeof message !== "object") return false;

    switch (message.type) {
      case MSG.PING_HOST:          return respond(pingHost(), sendResponse);
      case MSG.CALL_CLAUDE:        return respond(callClaude(message.prompt), sendResponse);
      case MSG.TRANSLATE_BATCH:    return respond(translateBatch(message.items || [], message.maxTurns || 0), sendResponse);
      case MSG.TRANSLATE_KO_TO_JA: return respond(translateKoToJa(String(message.text || "")), sendResponse);
      case MSG.RESET_SESSION:      return respond(resetSession(), sendResponse);
      case MSG.WARMUP:             return respond(warmup(), sendResponse);
      default:                     return false;
    }
  }
);
