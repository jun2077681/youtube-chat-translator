// Wrapper around `claude -p` (Claude Code CLI in non-interactive print mode).
// One-shot spawn per call. Used as a fallback when YLCT_SESSION_MODE=0;
// the default path is the long-running session in claude-session.ts.

import os from "node:os";
import path from "node:path";
import { runCommand } from "./proc-util";

const DEFAULT_CMD: string = process.env.YLCT_CLAUDE_PATH || "claude";
const DEFAULT_TIMEOUT_MS = 30_000;
const MCP_CONFIG_PATH = path.resolve(__dirname, "../mcp-empty.json");

export interface RunOptions {
  cmd?: string;
  timeoutMs?: number;
  extraArgs?: string[];
}

export type RunResult =
  | { ok: true; text: string }
  | { ok: false; error: string; code: number; stderr: string };

export async function runClaudePrompt(prompt: string, opts: RunOptions = {}): Promise<RunResult> {
  const result = await runCommand({
    cmd: opts.cmd || DEFAULT_CMD,
    args: ["-p", "--mcp-config", MCP_CONFIG_PATH, "--strict-mcp-config", ...(opts.extraArgs || [])],
    stdin: prompt + os.EOL,
    timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
  });

  if (result.ok) return { ok: true, text: result.stdout.trim() };
  return {
    ok: false,
    error: result.error ?? `claude exited with code ${result.code}`,
    code: result.code,
    stderr: result.stderr.trim(),
  };
}
