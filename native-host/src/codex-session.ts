// Long-running `codex mcp-server` session. Codex exposes itself as an MCP server
// over stdio; we speak MCP (JSON-RPC 2.0, newline-delimited) and call the
// `codex` tool once per translation. Keeping the server process alive removes
// the per-call process cold start (one-shot codex exec is ~8-38s; through the
// persistent server each call is ~5s).

import { spawn, type ChildProcess } from "node:child_process";
import { createLogger, killTree, readJsonLines } from "./proc-util";
import { getCodexModel, withModelErrorRetry } from "./codex-models";
import { CODEX_CMD, CODEX_EFFORT, CODEX_WORK_DIR, CODEX_REQUEST_TIMEOUT_MS, CODEX_IDLE_TIMEOUT_MS } from "./codex-config";
import { SessionRegistry } from "./session-registry";

// MCP handshake protocol version we advertise to `codex mcp-server`.
const MCP_PROTOCOL_VERSION = "2025-06-18";

const log = createLogger("[ylct-codex]");

interface JsonRpcResponse {
  id?: number | string;
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  error?: { message?: string };
  method?: string;
}

interface Pending {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CodexSession {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private ready: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Called once on full teardown so the owning session map drops the dead instance.
  private onDispose: (() => void) | null = null;

  setDispose(fn: () => void): void {
    this.onDispose = fn;
  }

  private spawnProc(): void {
    log("spawning codex mcp-server");
    const proc = spawn(CODEX_CMD, ["mcp-server"], {
      shell: process.platform === "win32",
      env: process.env,
      windowsHide: true,
    });
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    proc.stderr?.on("data", (chunk: string) => {
      const s = String(chunk).trim();
      if (s) log("stderr:", s.slice(0, 200));
    });
    proc.on("error", (err) => this.handleDeath(err.message));
    proc.on("close", (code) => this.handleDeath("process exited code=" + code));
    this.proc = proc;
    this.buffer = "";
  }

  private handleDeath(reason: string): void {
    const proc = this.proc;
    this.proc = null;
    this.buffer = "";
    this.ready = null;
    if (proc) killTree(proc);
    this.rejectAllPending(new Error("codex session died: " + reason));
  }

  private rejectAllPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onStdout(chunk: string): void {
    this.buffer = readJsonLines(this.buffer, chunk, (obj) => this.onMessage(obj as JsonRpcResponse));
  }

  private onMessage(obj: JsonRpcResponse): void {
    // Only responses to our requests carry a matching numeric id; ignore
    // server-initiated notifications (progress, etc.).
    if (obj.id === undefined || typeof obj.id !== "number") return;
    const p = this.pending.get(obj.id);
    if (!p) return;
    this.pending.delete(obj.id);
    clearTimeout(p.timer);

    if (obj.error) {
      p.reject(new Error("codex rpc error: " + (obj.error.message || "unknown")));
      return;
    }
    const result = obj.result;
    if (result?.isError) {
      const text = result.content?.map((c) => c.text || "").join("") || "tool error";
      p.reject(new Error("codex tool error: " + text.slice(0, 200)));
      return;
    }
    const text = (result?.content || []).map((c) => c.text || "").join("").trim();
    p.resolve(text);
  }

  private rpc(method: string, params: unknown, timeoutMs: number): Promise<string> {
    if (!this.proc) this.spawnProc();
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        log("request timed out, restarting session");
        this.shutdown();
        reject(new Error("codex request timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc?.stdin?.write(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  // initialize handshake; the tool result content is unused here.
  private async handshake(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "ylct", version: "0.1.0" },
    }, CODEX_REQUEST_TIMEOUT_MS);
    // notifications/initialized has no id and expects no response.
    try {
      this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    } catch { /* ignore */ }
  }

  private ensureReady(): Promise<void> {
    if (!this.proc) this.spawnProc();
    if (!this.ready) this.ready = this.handshake();
    return this.ready;
  }

  // Normal calls reuse the cached model; on a model-specific error the helper
  // re-detects once and retries, so a stale/removed model self-heals without
  // per-call overhead.
  sendPrompt(prompt: string): Promise<string> {
    return withModelErrorRetry(() => this.attempt(prompt));
  }

  private async attempt(prompt: string): Promise<string> {
    this.cancelIdleShutdown();
    // Resolve the model (may run `codex debug models`) before spawning the
    // mcp-server, so the two codex processes don't refresh OAuth concurrently.
    const model = await getCodexModel();
    await this.ensureReady();
    const args = {
      name: "codex",
      arguments: {
        prompt,
        sandbox: "read-only",
        cwd: CODEX_WORK_DIR,
        config: { model_reasoning_effort: CODEX_EFFORT },
        ...(model ? { model } : {}),
      },
    };
    try {
      const text = await this.rpc("tools/call", args, CODEX_REQUEST_TIMEOUT_MS);
      if (!text) throw new Error("codex returned empty output");
      return text;
    } finally {
      this.scheduleIdleShutdown();
    }
  }

  private scheduleIdleShutdown(): void {
    this.cancelIdleShutdown();
    this.idleTimer = setTimeout(() => {
      log("idle timeout, shutting down session");
      this.shutdown();
    }, CODEX_IDLE_TIMEOUT_MS);
  }

  private cancelIdleShutdown(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  shutdown(): void {
    this.cancelIdleShutdown();
    const proc = this.proc;
    this.proc = null;
    this.buffer = "";
    this.ready = null;
    this.rejectAllPending(new Error("codex session shut down"));
    if (proc) {
      try { proc.removeAllListeners(); } catch { /* ignore */ }
      try { proc.stdin?.end(); } catch { /* ignore */ }
      killTree(proc);
    }
    if (this.onDispose) {
      const fn = this.onDispose;
      this.onDispose = null;
      fn();
    }
  }
}

// One persistent Codex session per key (Chrome tab id), mirroring claude-session.
export const codexSessions = new SessionRegistry<CodexSession>(() => new CodexSession());
