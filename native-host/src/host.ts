#!/usr/bin/env node
// Native Messaging Host entrypoint for YouTube Live Chat Translator.
// Spawned by Chrome via the registered manifest. Communicates over stdin/stdout
// using the Native Messaging wire protocol (see nm-protocol.ts).

import { readMessages, writeMessage } from "./nm-protocol";
import { runClaudePrompt } from "./claude-runner";
import { getSession } from "./claude-session";

const SESSION_MODE = process.env.YLCT_SESSION_MODE !== "0";

function log(...args: unknown[]): void {
  process.stderr.write("[ylct-host] " + args.map(String).join(" ") + "\n");
}

interface InboundMessage {
  id?: string;
  type?: string;
  prompt?: string;
  direction?: "ja_to_ko" | "ko_to_ja";
  maxTurns?: number;
  timeoutMs?: number;
}

interface Response {
  id: string;
  ok: boolean;
  text?: string;
  error?: string;
  stderr?: string;
  elapsedMs: number;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function handleMessage(msg: InboundMessage | null | undefined): Promise<Response> {
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
        return { id, ok: false, error: errMsg(err), elapsedMs: Date.now() - startedAt };
      }
    }

    if (type === "translate") {
      const prompt = msg!.prompt;
      if (typeof prompt !== "string" || prompt.length === 0) {
        return { id, ok: false, error: "empty prompt", elapsedMs: Date.now() - startedAt };
      }

      if (SESSION_MODE) {
        try {
          const direction = msg!.direction === "ko_to_ja" ? "ko_to_ja" : "ja_to_ko";
          const maxTurns = typeof msg!.maxTurns === "number" ? msg!.maxTurns : 0;
          const text = await getSession().sendUserMessage(prompt, direction, maxTurns);
          return { id, ok: true, text, elapsedMs: Date.now() - startedAt };
        } catch (err) {
          return {
            id,
            ok: false,
            error: "session: " + errMsg(err),
            elapsedMs: Date.now() - startedAt,
          };
        }
      }

      const result = await runClaudePrompt(prompt, { timeoutMs: msg!.timeoutMs || 30_000 });
      if (result.ok) {
        return { id, ok: true, text: result.text, elapsedMs: Date.now() - startedAt };
      }
      return {
        id,
        ok: false,
        error: result.error,
        stderr: result.stderr,
        elapsedMs: Date.now() - startedAt,
      };
    }

    return { id, ok: false, error: `unknown type: ${type}`, elapsedMs: Date.now() - startedAt };
  } catch (err) {
    return {
      id,
      ok: false,
      error: `handler crashed: ${errMsg(err)}`,
      elapsedMs: Date.now() - startedAt,
    };
  }
}

async function main(): Promise<void> {
  log("starting (pid=" + process.pid + ", node=" + process.version + ")");

  process.stdin.on("end", () => {
    log("stdin closed by Chrome, exiting");
    process.exit(0);
  });
  process.stdin.on("error", (err: Error) => {
    log("stdin error:", err.message);
    process.exit(1);
  });

  try {
    for await (const msg of readMessages(process.stdin)) {
      const m = msg as InboundMessage | null | undefined;
      log("recv id=" + (m && m.id) + " type=" + (m && m.type));
      const response = await handleMessage(m);
      writeMessage(process.stdout, response);
      log("sent id=" + response.id + " ok=" + response.ok + " elapsed=" + response.elapsedMs + "ms");
    }
  } catch (err) {
    log("fatal:", err instanceof Error ? (err.stack || err.message) : String(err));
    process.exit(1);
  }
}

main();
