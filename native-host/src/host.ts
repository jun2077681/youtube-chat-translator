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
    return { id: "<unknown>", ok: false, error: "missing id", elapsedMs: 0 };
  }

  const elapsed = (): number => Date.now() - startedAt;
  const ok = (extra: Partial<Response> = {}): Response => ({ id, ok: true, elapsedMs: elapsed(), ...extra });
  const fail = (error: string, extra: Partial<Response> = {}): Response => ({ id, ok: false, error, elapsedMs: elapsed(), ...extra });

  try {
    if (type === "ping") return ok({ text: "pong" });

    if (type === "reset_session") {
      getSession().manualRestart();
      return ok();
    }

    if (type === "translate") {
      const prompt = msg!.prompt;
      if (typeof prompt !== "string" || prompt.length === 0) return fail("empty prompt");

      if (SESSION_MODE) {
        const direction = msg!.direction === "ko_to_ja" ? "ko_to_ja" : "ja_to_ko";
        const maxTurns = typeof msg!.maxTurns === "number" ? msg!.maxTurns : 0;
        try {
          const text = await getSession().sendUserMessage(prompt, direction, maxTurns);
          return ok({ text });
        } catch (err) {
          return fail("session: " + errMsg(err));
        }
      }

      const result = await runClaudePrompt(prompt, { timeoutMs: msg!.timeoutMs || 30_000 });
      return result.ok ? ok({ text: result.text }) : fail(result.error, { stderr: result.stderr });
    }

    return fail(`unknown type: ${type}`);
  } catch (err) {
    return fail(`handler crashed: ${errMsg(err)}`);
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
