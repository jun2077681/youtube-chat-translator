// Translation use-cases: build the host request, send it, and shape the reply
// for the popup / content script. Each function takes the resolved provider
// explicitly so this module holds no settings state.

import {
  type BatchItem,
  type BatchResponse,
  type KoToJaResponse,
  type Provider,
  type Translation,
} from "../shared/constants";
import { sendToHost, randomId } from "./host-port";
import { parseClaudeJson } from "./parse";

const HOST_TIMEOUT_MS = 30_000;

export async function translateBatch(
  provider: Provider,
  items: BatchItem[],
  maxTurns = 0,
  sessionKey?: string
): Promise<BatchResponse> {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: true, translations: [] };
  }

  const prompt = JSON.stringify({ items: items.map((it) => ({ id: it.id, ja: it.ja })) });
  const reply = await sendToHost({ type: "translate", provider, prompt, maxTurns, timeoutMs: HOST_TIMEOUT_MS, sessionKey });

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

export async function translateKoToJa(provider: Provider, text: string, sessionKey?: string): Promise<KoToJaResponse> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "empty input" };

  const prompt = JSON.stringify({ items: [{ id: randomId("k-"), ko: trimmed }] });
  const reply = await sendToHost({ type: "translate", provider, direction: "ko_to_ja", prompt, timeoutMs: HOST_TIMEOUT_MS, sessionKey });
  if (!reply.ok) return { ok: false, error: reply.error || "host error" };

  const result = parseClaudeJson(reply.text)?.results?.[0];
  if (result && typeof result.ja === "string") {
    return { ok: true, ja: result.ja, elapsedMs: reply.elapsedMs };
  }
  return { ok: false, error: "no translation in response", raw: reply.text };
}

export async function pingHost(): Promise<unknown> {
  return { ok: true, reply: await sendToHost({ type: "ping" }) };
}

// Debug-tab translation test: run one JA->KO translation through a chosen
// provider and surface the resolved model + translated output.
export async function testTranslate(provider: Provider, text: string): Promise<unknown> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "empty input" };
  const prompt = JSON.stringify({ items: [{ id: "test", ja: trimmed }] });
  const reply = await sendToHost({ type: "translate", provider, direction: "ja_to_ko", prompt, timeoutMs: HOST_TIMEOUT_MS, withModel: true });
  return {
    ok: !!reply.ok,
    provider,
    model: reply.model,
    translated: parseClaudeJson(reply.text)?.results?.[0]?.ko ?? null,
    raw: reply.text,
    elapsedMs: reply.elapsedMs,
    error: reply.ok ? undefined : reply.error,
    stderr: reply.stderr,
  };
}

export async function resetSession(provider: Provider, sessionKey?: string): Promise<unknown> {
  const reply = await sendToHost({ type: "reset_session", provider, timeoutMs: 5_000, sessionKey });
  return { ok: !!reply.ok, elapsedMs: reply.elapsedMs };
}

export async function warmup(provider: Provider, sessionKey?: string): Promise<unknown> {
  const reply = await sendToHost({
    type: "translate",
    provider,
    direction: "ja_to_ko",
    prompt: JSON.stringify({ items: [{ id: "warmup", ja: "テスト" }] }),
    timeoutMs: HOST_TIMEOUT_MS,
    sessionKey,
  });
  return { ok: !!reply.ok, elapsedMs: reply.elapsedMs };
}
