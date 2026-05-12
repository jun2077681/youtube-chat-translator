// Wrapper around `claude -p` (Claude Code CLI in non-interactive print mode).
// One-shot spawn per call. Used as a fallback when YLCT_SESSION_MODE=0;
// the default path is the long-running session in claude-session.js.

"use strict";

const { spawn } = require("child_process");
const os = require("os");

const DEFAULT_CMD = process.env.YLCT_CLAUDE_PATH || "claude";
const DEFAULT_TIMEOUT_MS = 30_000;

function runClaudePrompt(prompt, opts = {}) {
  const cmd = opts.cmd || DEFAULT_CMD;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const extraArgs = opts.extraArgs || [];

  return new Promise((resolve) => {
    const args = ["-p", ...extraArgs];
    let proc;
    try {
      proc = spawn(cmd, args, {
        shell: process.platform === "win32",
        env: process.env,
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, error: `spawn failed: ${err.message}`, code: -1, stderr: "" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let finished = false;

    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { proc.kill("SIGKILL"); } catch (_) {}
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: `timeout after ${timeoutMs}ms`, code: -1, stderr });
    }, timeoutMs);

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });

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
      proc.stdin.end(prompt + os.EOL);
    } catch (err) {
      finish({ ok: false, error: `stdin write failed: ${err.message}`, code: -1, stderr });
    }
  });
}

module.exports = { runClaudePrompt, DEFAULT_CMD, DEFAULT_TIMEOUT_MS };
