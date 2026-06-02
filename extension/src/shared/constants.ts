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

const HANDLE_EXCLUDE_HOSTS: ReadonlyArray<string> = Object.freeze([
  "ytd-masthead",
  "tp-yt-iron-dropdown",
  "ytd-popup-container",
  "ytd-account-section-list-renderer",
  "ytd-mini-guide-renderer",
  "ytd-guide-renderer",
]);

function hasLiveChatFrame(doc: Document): boolean {
  return !!doc.querySelector("ytd-live-chat-frame");
}

export function readChannelInfoFromDocument(doc: Document | null | undefined): ChannelInfo | null {
  try {
    if (!doc) return null;
    if (!hasLiveChatFrame(doc)) return null;

    const anchors = doc.querySelectorAll<HTMLAnchorElement>('a[href^="/@"]');
    let handle: string | null = null;
    for (const a of Array.from(anchors)) {
      let inExcluded = false;
      for (const host of HANDLE_EXCLUDE_HOSTS) {
        if (a.closest && a.closest(host)) {
          inExcluded = true;
          break;
        }
      }
      if (inExcluded) continue;
      const href = a.getAttribute("href") || "";
      const m = href.match(/^\/(@[^/?#]+)/);
      if (m) {
        handle = m[1];
        break;
      }
    }
    if (!handle) return null;

    let channelName: string | null = null;
    for (const { sel, attr } of CHANNEL_NAME_SOURCES) {
      const el = doc.querySelector(sel);
      if (!el) continue;
      const v = attr ? el.getAttribute(attr) : el.textContent;
      if (v && v.trim()) {
        channelName = v.trim();
        break;
      }
    }
    return { handle, channelName };
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
