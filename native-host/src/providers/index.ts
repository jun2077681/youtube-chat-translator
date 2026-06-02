// Provider registry. Maps a provider name to its singleton implementation and
// re-exports the selection helpers used by the host.

import { claudeProvider } from "./claude";
import { codexProvider } from "./codex";
import { geminiProvider } from "./gemini";
import {
  DEFAULT_PROVIDER,
  isProvider,
  PROVIDERS,
  type Provider,
  type TranslationProvider,
} from "./types";

const REGISTRY: Record<Provider, TranslationProvider> = {
  claude: claudeProvider,
  codex: codexProvider,
  gemini: geminiProvider,
};

// Resolve an untrusted value to a provider, falling back to the default.
export function resolveProvider(value: unknown): TranslationProvider {
  return REGISTRY[isProvider(value) ? value : DEFAULT_PROVIDER];
}

export function shutdownAll(): void {
  for (const name of PROVIDERS) {
    try { REGISTRY[name].shutdown(); } catch { /* ignore */ }
  }
}

export { DEFAULT_PROVIDER, isProvider, PROVIDERS };
export type { Provider, TranslationProvider };
