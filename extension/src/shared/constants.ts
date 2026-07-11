// Shared constants and helpers for YLCT.
// Imported by entry points; esbuild bundles into each output.

export const MSG = {
  PING_HOST: "PING_HOST",
  TEST_TRANSLATE: "TEST_TRANSLATE",
  TRANSLATE_BATCH: "TRANSLATE_BATCH",
  TRANSLATE_KO_TO_JA: "TRANSLATE_KO_TO_JA",
  RESET_SESSION: "RESET_SESSION",
  WARMUP: "WARMUP",
  GET_CHANNEL_INFO: "GET_CHANNEL_INFO",
} as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];

export const KEY = {
  WHITELIST: "ylct:whitelist:v2",
  SETTINGS: "ylct:settings:v1",
  CACHE: "ylct:cache:v1",
} as const;

// Translation backend. The native host routes each request to the matching CLI.
export type Provider = "claude" | "codex" | "gemini";

export const PROVIDERS: readonly Provider[] = ["claude", "codex", "gemini"];

export const PROVIDER_DEFAULT: Provider = "claude";

// Human-readable labels for the popup dropdown.
export const PROVIDER_LABELS: Readonly<Record<Provider, string>> = Object.freeze({
  claude: "Claude (빠름, 세션 유지)",
  codex: "Codex (호출마다 cold start)",
  gemini: "Gemini (호출마다 cold start)",
});

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

export interface Settings {
  batchWindowMs: number;
  maxTurns: number;
  provider: Provider;
}

export const SETTINGS_DEFAULTS: Readonly<Settings> = Object.freeze({
  batchWindowMs: 15000,
  maxTurns: 200,
  provider: PROVIDER_DEFAULT,
});

export interface ChannelInfo {
  handle: string | null;
  channelName: string | null;
}

export interface WhitelistEntry {
  handle: string;
  channelName: string;
  addedAt: string;
}

// ---------- shared message contract types ----------

export interface BatchItem {
  id: string;
  ja: string;
}

export interface Translation {
  id: string;
  ko: string;
}

export interface HostReply {
  ok: boolean;
  text?: string;
  model?: string;
  error?: string;
  stderr?: string;
  elapsedMs?: number;
}

export interface BatchResponse {
  ok: boolean;
  translations?: Translation[];
  error?: string;
  raw?: string;
  stderr?: string;
  elapsedMs?: number;
}

export interface KoToJaResponse {
  ok: boolean;
  ja?: string;
  error?: string;
  raw?: string;
  elapsedMs?: number;
}
