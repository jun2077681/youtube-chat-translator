// Claude provider. Default path is the long-running stream-json session
// (fast subsequent calls); set YLCT_SESSION_MODE=0 to fall back to a one-shot
// `claude -p` spawn per call.

import { claudeSessions } from "../claude-session";
import { runClaudePrompt } from "../claude-runner";
import { buildOneShotPrompt } from "../translation-prompt";
import type { TranslationProvider, TranslateOptions } from "./types";

const SESSION_MODE = process.env.YLCT_SESSION_MODE !== "0";

export const claudeProvider: TranslationProvider = {
  name: "claude",

  async translate(content: string, opts: TranslateOptions): Promise<string> {
    if (SESSION_MODE) {
      return claudeSessions.get(opts.sessionKey)
        .sendUserMessage(content, opts.direction, opts.maxTurns ?? 0);
    }
    const prompt = buildOneShotPrompt(opts.direction, content);
    const result = await runClaudePrompt(prompt, { timeoutMs: opts.timeoutMs });
    if (result.ok) return result.text;
    throw new Error(result.stderr ? `${result.error}: ${result.stderr}` : result.error);
  },

  async currentModel(): Promise<string> {
    return process.env.YLCT_MODEL || "haiku";
  },

  reset(sessionKey?: string): void {
    if (SESSION_MODE) claudeSessions.shutdown(sessionKey);
  },

  shutdown(sessionKey?: string): void {
    if (SESSION_MODE) claudeSessions.shutdown(sessionKey);
  },
};
