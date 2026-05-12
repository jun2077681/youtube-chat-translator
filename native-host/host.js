#!/usr/bin/env node
// Native Messaging Host entrypoint for YouTube Live Chat Translator.
// Spawned by Chrome via the registered manifest. Communicates over stdin/stdout
// using the Native Messaging wire protocol (see nm-protocol.js).

"use strict";

const { readMessages, writeMessage } = require("./nm-protocol");
const { runClaudePrompt } = require("./claude-runner");
const { getSession } = require("./claude-session");

// Session mode: one persistent `claude` process for all translate calls.
// Default ON. Set YLCT_SESSION_MODE=0 to fall back to one-shot spawn per call.
const SESSION_MODE = process.env.YLCT_SESSION_MODE !== "0";

function log(...args) {
  process.stderr.write("[ylct-host] " + args.map(String).join(" ") + "\n");
}

async function handleMessage(msg) {
  const id = msg && msg.id;
  const type = msg && msg.type;
  const startedAt = Date.now();

  if (!id || typeof id !== "string") {
    return { id: id || "<unknown>", ok: false, error: "missing id", elapsedMs: 0 };
  }

  try {
    if (type === "ping") {
      return { id, ok: true, text: "pong", elapsedMs: Date.now() - startedAt };
    }

    if (type === "reset_session") {
      try {
        getSession().manualRestart();
        return { id, ok: true, elapsedMs: Date.now() - startedAt };
      } catch (err) {
        return { id, ok: false, error: String(err && err.message || err), elapsedMs: Date.now() - startedAt };
      }
    }

    if (type === "translate") {
      const prompt = msg.prompt;
      if (typeof prompt !== "string" || prompt.length === 0) {
        return { id, ok: false, error: "empty prompt", elapsedMs: Date.now() - startedAt };
      }

      if (SESSION_MODE) {
        try {
          const direction = msg.direction === "ko_to_ja" ? "ko_to_ja" : "ja_to_ko";
          const maxTurns = typeof msg.maxTurns === "number" ? msg.maxTurns : 0;
          const text = await getSession().sendUserMessage(prompt, direction, maxTurns);
          return { id, ok: true, text, elapsedMs: Date.now() - startedAt };
        } catch (err) {
          return {
            id,
            ok: false,
            error: "session: " + (err && err.message),
            elapsedMs: Date.now() - startedAt,
          };
        }
      }

      const result = await runClaudePrompt(prompt, { timeoutMs: msg.timeoutMs || 30_000 });
      return {
        id,
        ok: result.ok,
        text: result.ok ? result.text : undefined,
        error: result.ok ? undefined : result.error,
        stderr: result.ok ? undefined : result.stderr,
        elapsedMs: Date.now() - startedAt,
      };
    }

    return { id, ok: false, error: `unknown type: ${type}`, elapsedMs: Date.now() - startedAt };
  } catch (err) {
    return {
      id,
      ok: false,
      error: `handler crashed: ${err && err.message}`,
      elapsedMs: Date.now() - startedAt,
    };
  }
}

async function main() {
  log("starting (pid=" + process.pid + ", node=" + process.version + ")");

  process.stdin.on("end", () => {
    log("stdin closed by Chrome, exiting");
    process.exit(0);
  });
  process.stdin.on("error", (err) => {
    log("stdin error:", err.message);
    process.exit(1);
  });

  try {
    for await (const msg of readMessages(process.stdin)) {
      log("recv id=" + (msg && msg.id) + " type=" + (msg && msg.type));
      const response = await handleMessage(msg);
      writeMessage(process.stdout, response);
      log("sent id=" + response.id + " ok=" + response.ok + " elapsed=" + response.elapsedMs + "ms");
    }
  } catch (err) {
    log("fatal:", err && err.stack || err);
    process.exit(1);
  }
}

main();
