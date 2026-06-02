// Shared translation prompt logic.
// Used by every provider (Claude session/one-shot, Codex, Gemini) so the
// system prompt, per-direction wrap, and output schema stay identical
// regardless of which CLI backend produces the translation.

export type Direction = "ja_to_ko" | "ko_to_ja";

// Normalize an untrusted value to a Direction, defaulting to ja_to_ko. Keeps the
// boundary's "is this ko_to_ja?" check in one place next to the type it produces.
export function toDirection(value: unknown): Direction {
  return value === "ko_to_ja" ? "ko_to_ja" : "ja_to_ko";
}

export const SYSTEM_PROMPT: string = [
  "You translate live-stream chat between Japanese and Korean.",
  "Tone: casual, live-chat. Preserve emoji, kaomoji, @mentions, URLs, and hashtags as-is.",
  "For internet slang use natural equivalents in the target language.",
  "Each output 'id' MUST match the input 'id'.",
  "Output ONLY the JSON shape requested in the user message — no commentary, no markdown fences.",
].join("\n");

const WRAP_SPECS: Record<Direction, { instr: string; out: "ko" | "ja"; sample: string; lang: string }> = {
  ja_to_ko: {
    instr: "Translate the 'ja' field of each item to natural Korean.",
    out: "ko",
    sample: "<한국어 번역>",
    lang: "Korean (한국어), not English",
  },
  ko_to_ja: {
    instr: "Translate the 'ko' field of each item to natural casual Japanese suitable for live stream chat.",
    out: "ja",
    sample: "<日本語訳>",
    lang: "Japanese (日本語), not Korean, not English",
  },
};

// Build the per-message instruction wrapper around the raw `{items:[...]}` JSON.
export function wrap(direction: Direction, content: string): string {
  const w = WRAP_SPECS[direction];
  return `${w.instr} Output ONLY this JSON shape, no commentary:\n` +
    `{"results":[{"id":"<input id>","${w.out}":"${w.sample}"}]}\n` +
    `The '${w.out}' field MUST contain ${w.lang}.\n\n` +
    `Input:\n${content}`;
}

// One-shot providers (Codex/Gemini) cannot pass a separate system prompt the
// way the Claude session does, so they prepend it to the wrapped user message.
export function buildOneShotPrompt(direction: Direction, content: string): string {
  return `${SYSTEM_PROMPT}\n\n${wrap(direction, content)}`;
}

export const OUTPUT_SCHEMA: string = JSON.stringify({
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
