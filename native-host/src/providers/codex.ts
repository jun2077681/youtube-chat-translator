// Codex provider. Default path is the long-running `codex mcp-server` session
// (persistent process, ~5s/call); set YLCT_CODEX_ONESHOT=1 to fall back to a
// fresh `codex exec` spawn per call (~8-38s). The one-shot path captures the
// final message via `--output-last-message <file>` to avoid the banner stdout.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildOneShotPrompt } from "../translation-prompt";
import { commandFailureError, runCommand } from "../proc-util";
import { codexSessions } from "../codex-session";
import { getCodexModel, resetCodexModelCache, withModelErrorRetry } from "../codex-models";
import { CODEX_CMD, CODEX_EFFORT, CODEX_WORK_DIR, CODEX_REQUEST_TIMEOUT_MS } from "../codex-config";
import type { TranslationProvider, TranslateOptions } from "./types";

const SESSION_MODE = process.env.YLCT_CODEX_ONESHOT !== "1";

let counter = 0;
function tmpOutputPath(): string {
  counter += 1;
  return path.join(os.tmpdir(), `ylct-codex-${process.pid}-${Date.now()}-${counter}.txt`);
}

function translateOneShot(content: string, opts: TranslateOptions): Promise<string> {
  return withModelErrorRetry(() => runOneShot(content, opts));
}

async function runOneShot(content: string, opts: TranslateOptions): Promise<string> {
  const prompt = buildOneShotPrompt(opts.direction, content);
  const outPath = tmpOutputPath();
  const model = await getCodexModel();

  const args = [
    "exec",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "-C", CODEX_WORK_DIR,
    "-c", `model_reasoning_effort=${CODEX_EFFORT}`,
    "--output-last-message", outPath,
  ];
  if (model) args.push("-m", model);
  args.push("-"); // read prompt from stdin

  try {
    const result = await runCommand({
      cmd: CODEX_CMD,
      args,
      stdin: prompt,
      timeoutMs: opts.timeoutMs ?? CODEX_REQUEST_TIMEOUT_MS,
      cwd: CODEX_WORK_DIR,
    });

    if (!result.ok) throw commandFailureError("codex", result);

    const text = (await fs.readFile(outPath, "utf8")).trim();
    if (!text) throw new Error("codex returned empty output");
    return text;
  } finally {
    fs.unlink(outPath).catch(() => { /* best-effort cleanup */ });
  }
}

export const codexProvider: TranslationProvider = {
  name: "codex",

  async translate(content: string, opts: TranslateOptions): Promise<string> {
    if (SESSION_MODE) {
      return codexSessions.get(opts.sessionKey)
        .sendPrompt(buildOneShotPrompt(opts.direction, content));
    }
    return translateOneShot(content, opts);
  },

  async currentModel(): Promise<string> {
    return (await getCodexModel()) ?? "(codex CLI default)";
  },

  reset(sessionKey?: string): void {
    if (!SESSION_MODE) return;
    codexSessions.shutdown(sessionKey);
    // The detected model is process-global, so only a full reset (no key)
    // re-detects it; a per-tab reset must not churn the shared model cache.
    if (!sessionKey) resetCodexModelCache();
  },

  shutdown(sessionKey?: string): void {
    if (SESSION_MODE) codexSessions.shutdown(sessionKey);
  },
};
