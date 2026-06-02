// Long-running `claude --print --input-format stream-json --output-format stream-json` session.
// Spawn once, send many user messages. Avoids cold start per request.

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { SYSTEM_PROMPT, OUTPUT_SCHEMA, wrap, type Direction } from "./translation-prompt";
import { createLogger, killTree, readJsonLines } from "./proc-util";
import { envInt } from "./env";

const DEFAULT_CMD: string = process.env.YLCT_CLAUDE_PATH || "claude";
const DEFAULT_MODEL: string = process.env.YLCT_MODEL || "haiku";
const IDLE_TIMEOUT_MS: number = envInt("YLCT_SESSION_IDLE_MS", 30 * 60_000);
const REQUEST_TIMEOUT_MS: number = envInt("YLCT_REQUEST_TIMEOUT_MS", 60_000);

const log = createLogger("[ylct-session]");

interface QueueItem {
  content: string;
  direction: Direction;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ClaudeResultMessage {
  type: "result";
  is_error?: boolean;
  result?: string;
  subtype?: string;
}

export class ClaudeSession {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private queue: QueueItem[] = [];
  private busy: QueueItem | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private turnCount = 0;

  spawnProc(): void {
    log("spawning claude session");
    const mcpConfigPath = path.resolve(__dirname, "../mcp-empty.json");
    const args = [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--system-prompt", SYSTEM_PROMPT,
      "--json-schema", OUTPUT_SCHEMA,
      "--tools", "",
      "--mcp-config", mcpConfigPath,
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--model", DEFAULT_MODEL,
      "--effort", "low",
      "--exclude-dynamic-system-prompt-sections",
    ];

    const proc = spawn(DEFAULT_CMD, args, {
      shell: process.platform === "win32",
      env: process.env,
      windowsHide: true,
    });

    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");

    proc.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    proc.stderr?.on("data", (chunk: string) => {
      const s = String(chunk).trim();
      if (s) log("claude stderr:", s.slice(0, 200));
    });

    proc.on("error", (err) => {
      log("proc error:", err.message);
      this.handleDeath(err.message);
    });

    proc.on("close", (code) => {
      log("proc closed code=" + code);
      this.handleDeath("process exited code=" + code);
    });

    this.proc = proc;
    this.buffer = "";
    this.turnCount = 0;
  }

  private handleDeath(reason: string): void {
    const wasBusy = this.busy;
    const proc = this.proc;
    this.proc = null;
    this.buffer = "";
    this.busy = null;
    if (proc) killTree(proc);
    if (wasBusy) {
      if (wasBusy.timer) clearTimeout(wasBusy.timer);
      wasBusy.reject(new Error("session died: " + reason));
    }
  }

  private onStdout(chunk: string): void {
    this.buffer = readJsonLines(this.buffer, chunk, (obj) => this.onMessage(obj));
  }

  private onMessage(obj: unknown): void {
    if (
      obj && typeof obj === "object" &&
      (obj as ClaudeResultMessage).type === "result" &&
      this.busy
    ) {
      const msg = obj as ClaudeResultMessage;
      const item = this.busy;
      this.busy = null;
      if (item.timer) clearTimeout(item.timer);

      if (msg.is_error) {
        item.reject(new Error("claude result error: " + (msg.result || msg.subtype || "unknown")));
      } else {
        this.turnCount += 1;
        item.resolve(String(msg.result || ""));
      }
      this.dequeue();
    }
  }

  private dequeue(): void {
    if (this.busy) return;
    const next = this.queue.shift();
    if (!next) {
      this.scheduleIdleShutdown();
      return;
    }
    this.cancelIdleShutdown();
    this.send(next);
  }

  private send(item: QueueItem): void {
    if (!this.proc) {
      try {
        this.spawnProc();
      } catch (err) {
        item.reject(err as Error);
        this.dequeue();
        return;
      }
    }
    this.busy = item;
    item.timer = setTimeout(() => {
      log("request timed out after " + REQUEST_TIMEOUT_MS + "ms, killing session");
      this.busy = null;
      if (this.proc) killTree(this.proc);
      item.reject(new Error("session request timeout"));
    }, REQUEST_TIMEOUT_MS);

    const wrappedContent = wrap(item.direction, item.content);

    const payload = JSON.stringify({
      type: "user",
      message: { role: "user", content: wrappedContent },
    }) + "\n";
    try {
      this.proc?.stdin?.write(payload);
    } catch (err) {
      if (item.timer) clearTimeout(item.timer);
      this.busy = null;
      item.reject(err as Error);
    }
  }

  private scheduleIdleShutdown(): void {
    this.cancelIdleShutdown();
    this.idleTimer = setTimeout(() => {
      log("idle timeout reached, shutting down session");
      this.shutdown();
    }, IDLE_TIMEOUT_MS);
  }

  private cancelIdleShutdown(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  shutdown(): void {
    this.cancelIdleShutdown();
    if (this.proc) {
      try { this.proc.removeAllListeners(); } catch { /* ignore */ }
      try { this.proc.stdout?.removeAllListeners(); } catch { /* ignore */ }
      try { this.proc.stderr?.removeAllListeners(); } catch { /* ignore */ }
      try { this.proc.stdin?.end(); } catch { /* ignore */ }
      killTree(this.proc);
      this.proc = null;
      this.buffer = "";
      this.turnCount = 0;
    }
  }

  sendUserMessage(content: string, direction: Direction = "ja_to_ko", maxTurns = 0): Promise<string> {
    if (maxTurns > 0 && this.turnCount >= maxTurns &&
        !this.busy && this.queue.length === 0 && this.proc) {
      log("turn limit reached (" + this.turnCount + " >= " + maxTurns + "), restarting session for fresh context");
      this.shutdown();
    }
    return new Promise<string>((resolve, reject) => {
      this.cancelIdleShutdown();
      this.queue.push({ content, direction, resolve, reject, timer: null });
      this.dequeue();
    });
  }

  manualRestart(): void {
    log("manual session restart requested");
    this.shutdown();
  }
}

let _instance: ClaudeSession | null = null;
export function getSession(): ClaudeSession {
  if (!_instance) _instance = new ClaudeSession();
  return _instance;
}
