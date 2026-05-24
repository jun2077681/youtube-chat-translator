// Wrapper around `claude -p` (Claude Code CLI in non-interactive print mode).
// One-shot spawn per call. Used as a fallback when YLCT_SESSION_MODE=0;
// the default path is the long-running session in claude-session.ts.

import { spawn, execSync, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CMD: string = process.env.YLCT_CLAUDE_PATH || "claude";
export const DEFAULT_TIMEOUT_MS = 30_000;

function killTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid) { try { proc.kill(); } catch { /* ignore */ } return; }
  if (process.platform === "win32") {
    try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" }); } catch { /* ignore */ }
  } else {
    try { proc.kill("SIGKILL"); } catch { /* ignore */ }
  }
}

export interface RunOptions {
  cmd?: string;
  timeoutMs?: number;
  extraArgs?: string[];
}

export type RunResult =
  | { ok: true; text: string }
  | { ok: false; error: string; code: number; stderr: string };

export function runClaudePrompt(prompt: string, opts: RunOptions = {}): Promise<RunResult> {
  const cmd = opts.cmd || DEFAULT_CMD;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const extraArgs = opts.extraArgs || [];

  return new Promise((resolve) => {
    const mcpConfigPath = path.resolve(__dirname, "../mcp-empty.json");
    const args = ["-p", "--mcp-config", mcpConfigPath, "--strict-mcp-config", ...extraArgs];
    let proc: ChildProcess;
    try {
      proc = spawn(cmd, args, {
        shell: process.platform === "win32",
        env: process.env,
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, error: `spawn failed: ${(err as Error).message}`, code: -1, stderr: "" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let finished = false;

    const finish = (result: RunResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killTree(proc);
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: `timeout after ${timeoutMs}ms`, code: -1, stderr });
    }, timeoutMs);

    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    proc.stderr?.on("data", (chunk: string) => { stderr += chunk; });

    proc.on("error", (err) => {
      finish({ ok: false, error: `process error: ${err.message}`, code: -1, stderr });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true, text: stdout.trim() });
      } else {
        finish({
          ok: false,
          error: `claude exited with code ${code}`,
          code: code ?? -1,
          stderr: stderr.trim(),
        });
      }
    });

    try {
      proc.stdin?.end(prompt + os.EOL);
    } catch (err) {
      finish({ ok: false, error: `stdin write failed: ${(err as Error).message}`, code: -1, stderr });
    }
  });
}
