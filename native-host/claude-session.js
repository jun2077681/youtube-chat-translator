// Long-running `claude --print --input-format stream-json --output-format stream-json` session.
// Spawn once, send many user messages. Avoids cold start per request.

"use strict";

const { spawn } = require("child_process");

const DEFAULT_CMD = process.env.YLCT_CLAUDE_PATH || "claude";
const DEFAULT_MODEL = process.env.YLCT_MODEL || "haiku";
const IDLE_TIMEOUT_MS = parseInt(process.env.YLCT_SESSION_IDLE_MS, 10) || 30 * 60_000;
const REQUEST_TIMEOUT_MS = parseInt(process.env.YLCT_REQUEST_TIMEOUT_MS, 10) || 60_000;

// System prompt is generic; per-message wrappers below enforce exact output shape.
const SYSTEM_PROMPT = [
  "You translate live-stream chat between Japanese and Korean.",
  "Tone: casual, live-chat. Preserve emoji, kaomoji, @mentions, URLs, and hashtags as-is.",
  "For internet slang use natural equivalents in the target language.",
  "Each output 'id' MUST match the input 'id'.",
  "Output ONLY the JSON shape requested in the user message — no commentary, no markdown fences.",
].join("\n");

const WRAP_JA_TO_KO = (content) =>
  "Translate the 'ja' field of each item to natural Korean. " +
  "Output ONLY this JSON shape, no commentary:\n" +
  "{\"results\":[{\"id\":\"<input id>\",\"ko\":\"<한국어 번역>\"}]}\n" +
  "The 'ko' field MUST contain Korean (한국어), not English.\n\n" +
  "Input:\n" + content;

const WRAP_KO_TO_JA = (content) =>
  "Translate the 'ko' field of each item to natural casual Japanese suitable for live stream chat. " +
  "Output ONLY this JSON shape, no commentary:\n" +
  "{\"results\":[{\"id\":\"<input id>\",\"ja\":\"<日本語訳>\"}]}\n" +
  "The 'ja' field MUST contain Japanese (日本語), not Korean, not English.\n\n" +
  "Input:\n" + content;

function wrapFor(direction) {
  return direction === "ko_to_ja" ? WRAP_KO_TO_JA : WRAP_JA_TO_KO;
}

// JSON Schema enforced by claude --json-schema. Locks the envelope.
// Both `ko` and `ja` are optional — schema is set once at spawn time but the
// same session serves both directions, so the per-message wrap prompt is what
// decides which field gets populated.
const OUTPUT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          ko: { type: "string" },
          ja: { type: "string" },
        },
        required: ["id"],
      },
    },
  },
  required: ["results"],
});

function log(...args) {
  process.stderr.write("[ylct-session] " + args.map(String).join(" ") + "\n");
}

class ClaudeSession {
  constructor() {
    this.proc = null;
    this.buffer = "";
    this.queue = [];
    this.busy = null;
    this.idleTimer = null;
    this.turnCount = 0;
  }

  spawnProc() {
    log("spawning claude session");
    const args = [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--system-prompt", SYSTEM_PROMPT,
      "--json-schema", OUTPUT_SCHEMA,
      "--tools", "",
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

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    proc.stdout.on("data", (chunk) => this.onStdout(chunk));
    proc.stderr.on("data", (chunk) => {
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

  handleDeath(reason) {
    const wasBusy = this.busy;
    this.proc = null;
    this.buffer = "";
    this.busy = null;
    if (wasBusy) {
      clearTimeout(wasBusy.timer);
      wasBusy.reject(new Error("session died: " + reason));
    }
  }

  onStdout(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      this.onMessage(obj);
    }
  }

  onMessage(obj) {
    if (obj && obj.type === "result" && this.busy) {
      const item = this.busy;
      this.busy = null;
      clearTimeout(item.timer);

      if (obj.is_error) {
        item.reject(new Error("claude result error: " + (obj.result || obj.subtype || "unknown")));
      } else {
        this.turnCount += 1;
        item.resolve(String(obj.result || ""));
      }
      this.dequeue();
    }
  }

  dequeue() {
    if (this.busy) return;
    const next = this.queue.shift();
    if (!next) {
      this.scheduleIdleShutdown();
      return;
    }
    this.cancelIdleShutdown();
    this.send(next);
  }

  send(item) {
    if (!this.proc) {
      try {
        this.spawnProc();
      } catch (err) {
        item.reject(err);
        this.dequeue();
        return;
      }
    }
    this.busy = item;
    item.timer = setTimeout(() => {
      log("request timed out after " + REQUEST_TIMEOUT_MS + "ms, killing session");
      this.busy = null;
      try { this.proc && this.proc.kill("SIGKILL"); } catch (_) {}
      item.reject(new Error("session request timeout"));
    }, REQUEST_TIMEOUT_MS);

    const wrap = wrapFor(item.direction);
    const wrappedContent = wrap(item.content);

    const payload = JSON.stringify({
      type: "user",
      message: { role: "user", content: wrappedContent },
    }) + "\n";
    try {
      this.proc.stdin.write(payload);
    } catch (err) {
      clearTimeout(item.timer);
      this.busy = null;
      item.reject(err);
    }
  }

  scheduleIdleShutdown() {
    this.cancelIdleShutdown();
    this.idleTimer = setTimeout(() => {
      log("idle timeout reached, shutting down session");
      this.shutdown();
    }, IDLE_TIMEOUT_MS);
  }

  cancelIdleShutdown() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  shutdown() {
    this.cancelIdleShutdown();
    if (this.proc) {
      // Detach listeners first so the dying process's 'close'/'error' events
      // do not call back into handleDeath() and reject the *next* in-flight
      // request after we spawn a fresh process.
      try { this.proc.removeAllListeners(); } catch (_) {}
      try { this.proc.stdout && this.proc.stdout.removeAllListeners(); } catch (_) {}
      try { this.proc.stderr && this.proc.stderr.removeAllListeners(); } catch (_) {}
      try { this.proc.stdin.end(); } catch (_) {}
      try { this.proc.kill(); } catch (_) {}
      this.proc = null;
      this.buffer = "";
      this.turnCount = 0;
    }
  }

  sendUserMessage(content, direction = "ja_to_ko", maxTurns = 0) {
    // Auto-restart when the running session has accumulated enough turns.
    // Only restart while idle (no in-flight request, empty queue) so we
    // don't drop work mid-flight.
    if (maxTurns > 0 && this.turnCount >= maxTurns &&
        !this.busy && this.queue.length === 0 && this.proc) {
      log("turn limit reached (" + this.turnCount + " >= " + maxTurns + "), restarting session for fresh context");
      this.shutdown();
    }
    return new Promise((resolve, reject) => {
      this.cancelIdleShutdown();
      this.queue.push({ content, direction, resolve, reject, timer: null });
      this.dequeue();
    });
  }

  manualRestart() {
    log("manual session restart requested");
    this.shutdown();
  }

  getTurnCount() { return this.turnCount; }
}

let _instance = null;
function getSession() {
  if (!_instance) _instance = new ClaudeSession();
  return _instance;
}

module.exports = { getSession, ClaudeSession, SYSTEM_PROMPT };
