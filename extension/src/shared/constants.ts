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

const CHANNEL_NAME_SOURCES: ReadonlyArray<{ sel: string; attr: string | null }> = Object.freeze([
  { sel: "ytd-channel-name yt-formatted-string a", attr: null },
  { sel: "ytd-channel-name yt-formatted-string", attr: null },
  { sel: "#owner #channel-name yt-formatted-string", attr: null },
]);

// The video owner row (channel link + name shown under the player). Handle
// detection is scoped here so that /@mentions in the description, recommended
// videos, or comments can never be mistaken for the current channel.
const OWNER_SCOPE_SELECTORS: ReadonlyArray<string> = Object.freeze([
  "ytd-video-owner-renderer",
  "#owner",
]);

function hasLiveChatFrame(doc: Document): boolean {
  return !!doc.querySelector("ytd-live-chat-frame");
}

function findOwnerScope(doc: Document): Element | null {
  for (const sel of OWNER_SCOPE_SELECTORS) {
    const el = doc.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function readHandleFromOwner(owner: Element): string | null {
  const anchors = owner.querySelectorAll<HTMLAnchorElement>('a[href^="/@"]');
  for (const a of Array.from(anchors)) {
    const href = a.getAttribute("href") || "";
    const m = href.match(/^\/(@[^/?#]+)/);
    if (m) return m[1];
  }
  return null;
}

function readChannelName(owner: Element, doc: Document): string | null {
  for (const { sel, attr } of CHANNEL_NAME_SOURCES) {
    const el = owner.querySelector(sel) || doc.querySelector(sel);
    if (!el) continue;
    const v = attr ? el.getAttribute(attr) : el.textContent;
    if (v && v.trim()) return v.trim();
  }
  return null;
}

export function readChannelInfoFromDocument(doc: Document | null | undefined): ChannelInfo | null {
  try {
    if (!doc) return null;
    if (!hasLiveChatFrame(doc)) return null;

    const owner = findOwnerScope(doc);
    if (!owner) return null;

    const handle = readHandleFromOwner(owner);
    if (!handle) return null;

    return { handle, channelName: readChannelName(owner, doc) };
  } catch {
    return null;
  }
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
