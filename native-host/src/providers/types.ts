// Provider abstraction: a uniform interface over the different translation
// backends (Claude persistent session, Codex one-shot, Gemini one-shot).

import type { Direction } from "../translation-prompt";

export type Provider = "claude" | "codex" | "gemini";

export const PROVIDERS: readonly Provider[] = ["claude", "codex", "gemini"];

export const DEFAULT_PROVIDER: Provider = "claude";

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

export interface TranslateOptions {
  direction: Direction;
  // Only meaningful for the persistent Claude session (auto-restart threshold).
  // Ignored by one-shot providers.
  maxTurns?: number;
  timeoutMs?: number;
  // Isolates conversation context per caller (the extension passes the Chrome
  // tab id). Stateful providers keep one session per key; stateless ones ignore it.
  sessionKey?: string;
}

export interface TranslationProvider {
  readonly name: Provider;
  // `content` is the raw `{"items":[...]}` JSON string. Returns the model's raw
  // text output (expected to be the requested JSON shape). Parsing/validation of
  // that JSON happens in the extension background worker.
  translate(content: string, opts: TranslateOptions): Promise<string>;
  // The model this provider will use (resolved/auto-detected). For debug display.
  currentModel(): Promise<string>;
  // Restart/clear persistent state. With a sessionKey, only that session is
  // reset; without one, all sessions reset. No-op for stateless providers.
  reset(sessionKey?: string): void;
  // Release resources. With a sessionKey, only that session is torn down (e.g. a
  // tab closed); without one, all sessions are released (host exit).
  shutdown(sessionKey?: string): void;
}
