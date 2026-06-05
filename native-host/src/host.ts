#!/usr/bin/env node
// Native Messaging Host entrypoint for YouTube Live Chat Translator.
// Spawned by Chrome via the registered manifest. Communicates over stdin/stdout
// using the Native Messaging wire protocol (see nm-protocol.ts).

import { readMessages, writeMessage } from "./nm-protocol";
import { resolveProvider, shutdownAll } from "./providers";
import { toDirection } from "./translation-prompt";
import { createLogger, errMsg } from "./proc-util";

const log = createLogger("[ylct-host]");

interface InboundMessage {
  id?: string;
  type?: string;
  prompt?: string;
  provider?: string;
  direction?: "ja_to_ko" | "ko_to_ja";
  maxTurns?: number;
  timeoutMs?: number;
  // Per-tab session isolation key (Chrome tab id as a string). Scopes the
  // persistent provider session so different tabs/channels don't share context.
  sessionKey?: string;
  // Include the resolved model in the reply (debug test only); skipped on the
  // hot translate path since it's informational.
  withModel?: boolean;
}

interface Response {
  id: string;
  ok: boolean;
  text?: string;
  model?: string;
  error?: string;
  stderr?: string;
  elapsedMs: number;
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
      resolveProvider(msg!.provider).reset(msg!.sessionKey);
      return ok();
    }

    if (type === "close_session") {
      resolveProvider(msg!.provider).shutdown(msg!.sessionKey);
      return ok();
    }

    if (type === "translate") {
      const prompt = msg!.prompt;
      if (typeof prompt !== "string" || prompt.length === 0) return fail("empty prompt");

      const provider = resolveProvider(msg!.provider);
      const direction = toDirection(msg!.direction);
      const maxTurns = typeof msg!.maxTurns === "number" ? msg!.maxTurns : 0;
      try {
        const text = await provider.translate(prompt, { direction, maxTurns, timeoutMs: msg!.timeoutMs, sessionKey: msg!.sessionKey });
        let model: string | undefined;
        if (msg!.withModel) {
          try { model = await provider.currentModel(); } catch { /* informational only */ }
        }
        return ok({ text, model });
      } catch (err) {
        return fail(provider.name + ": " + errMsg(err));
      }
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
    shutdownAll();
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
