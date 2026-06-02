// Small process helpers shared by the CLI providers.

import { spawn, execSync, type ChildProcess } from "node:child_process";

// A stderr logger with a fixed prefix. Every session/provider tags its diagnostic
// lines this way, so the formatting lives here instead of being redefined per file.
export function createLogger(prefix: string): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    process.stderr.write(prefix + " " + args.map(String).join(" ") + "\n");
  };
}

// Coerce an unknown thrown value to a message string.
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Append a stdout chunk to `buffer`, dispatch every complete newline-delimited
// JSON object to `onObj` (silently skipping blank or unparseable lines), and
// return the leftover partial line. Both persistent sessions speak NDJSON over
// stdout, so this framing lives here instead of being duplicated per session.
export function readJsonLines(buffer: string, chunk: string, onObj: (obj: unknown) => void): string {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { continue; }
    onObj(obj);
  }
  return buffer;
}

// Kill a child process and its whole tree. On Windows a plain kill() leaves
// grandchildren alive, so use taskkill /T; elsewhere SIGKILL is enough.
export function killTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid) {
    try { proc.kill(); } catch { /* ignore */ }
    return;
  }
  if (process.platform === "win32") {
    try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" }); } catch { /* ignore */ }
  } else {
    try { proc.kill("SIGKILL"); } catch { /* ignore */ }
  }
}

export interface RunCommandOptions {
  cmd: string;
  args: string[];
  // Written to the child's stdin then closed. Omit to leave stdin empty.
  stdin?: string;
  timeoutMs: number;
  cwd?: string;
}

export interface RunCommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  error?: string;
}

// Build an Error from a failed one-shot run: prefer stderr, fall back to stdout,
// cap the detail so a noisy CLI dump doesn't bloat the message.
export function commandFailureError(name: string, result: RunCommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new Error(`${name} ${result.error}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
}

// Spawn a one-shot command, optionally feed stdin, and collect stdout/stderr
// with a hard timeout that kills the whole process tree. Never rejects — all
// outcomes (spawn failure, timeout, non-zero exit) come back as a result.
export function runCommand(opts: RunCommandOptions): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(opts.cmd, opts.args, {
        shell: process.platform === "win32",
        env: process.env,
        windowsHide: true,
        cwd: opts.cwd,
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: "", stderr: "", error: `spawn failed: ${(err as Error).message}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let finished = false;

    const finish = (result: RunCommandResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killTree(proc);
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, code: -1, stdout, stderr, error: `timeout after ${opts.timeoutMs}ms` });
    }, opts.timeoutMs);

    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    proc.stderr?.on("data", (chunk: string) => { stderr += chunk; });

    proc.on("error", (err) => {
      finish({ ok: false, code: -1, stdout, stderr, error: `process error: ${err.message}` });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true, code: 0, stdout, stderr });
      } else {
        finish({ ok: false, code: code ?? -1, stdout, stderr, error: `exited with code ${code}` });
      }
    });

    if (opts.stdin !== undefined) {
      try {
        proc.stdin?.end(opts.stdin);
      } catch (err) {
        finish({ ok: false, code: -1, stdout, stderr, error: `stdin write failed: ${(err as Error).message}` });
      }
    }
  });
}
