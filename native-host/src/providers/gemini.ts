// Gemini provider. `gemini -p` runs one-shot headless (no persistent session),
// so every call spawns a fresh process. With `-o json` the structured output
// carries the model text in the `.response` field; warnings go to stderr.

import { buildOneShotPrompt } from "../translation-prompt";
import { commandFailureError, runCommand } from "../proc-util";
import { envInt, envWorkDir } from "../env";
import type { TranslationProvider, TranslateOptions } from "./types";

const CMD = process.env.YLCT_GEMINI_PATH || "gemini";
// flash-lite is the fastest reliable model here: the heavier default
// (gemini-3-flash-preview) "thinks" and runs ~11-17s, and gemini-2.5-flash was
// unavailable/slow on test accounts. The one-shot floor is ~8s (CLI startup +
// auth), so model choice mainly trims the tail. Override with YLCT_GEMINI_MODEL
// (e.g. for higher quality at the cost of latency); set "" to use the CLI default.
const MODEL = process.env.YLCT_GEMINI_MODEL ?? "gemini-2.5-flash-lite";
const DEFAULT_TIMEOUT_MS = envInt("YLCT_GEMINI_TIMEOUT_MS", 60_000);
// Neutral working root so gemini does not depend on Chrome's spawn cwd.
const WORK_DIR = envWorkDir("YLCT_GEMINI_CWD");

interface GeminiJson {
  response?: string;
}

// stdout should be a single JSON object, but be defensive against any leading
// non-JSON noise by slicing from the first brace.
function extractResponse(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  const tryParse = (s: string): string | null => {
    try {
      const obj = JSON.parse(s) as GeminiJson;
      return typeof obj.response === "string" ? obj.response : null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(trimmed);
  if (direct !== null) return direct;

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return tryParse(trimmed.slice(first, last + 1));
  }
  return null;
}

export const geminiProvider: TranslationProvider = {
  name: "gemini",

  async translate(content: string, opts: TranslateOptions): Promise<string> {
    const prompt = buildOneShotPrompt(opts.direction, content);

    // The prompt goes on stdin (not via `-p`): under shell:true on Windows a
    // multi-word `-p <prompt>` arg gets re-tokenized and gemini rejects it as a
    // stray positional. With piped stdin gemini runs headless all the same.
    // `-e none` skips loading extensions/tools to shave startup.
    const args = ["-o", "json", "--approval-mode", "yolo", "--skip-trust", "-e", "none"];
    if (MODEL) args.push("-m", MODEL);

    const result = await runCommand({
      cmd: CMD,
      args,
      stdin: prompt,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      cwd: WORK_DIR,
    });

    if (!result.ok) throw commandFailureError("gemini", result);

    const response = extractResponse(result.stdout);
    if (response === null) {
      throw new Error(`gemini: could not parse response from output: ${result.stdout.slice(0, 300)}`);
    }
    return response.trim();
  },

  async currentModel(): Promise<string> {
    return MODEL || "(gemini CLI default)";
  },

  reset(): void { /* stateless one-shot, nothing to reset */ },
  shutdown(): void { /* stateless one-shot, nothing to release */ },
};
