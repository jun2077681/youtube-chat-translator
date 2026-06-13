// Pure message classification: decide whether a chat message is Japanese (to be
// translated), Korean, noise, or skippable. No DOM / chrome dependencies — unit
// testable in isolation.

const HIRAGANA = /[ぁ-ゟ]/;
const KATAKANA = /[゠-ヿㇰ-ㇿ]/;
const CJK = /[一-鿿]/;
const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/g;

const NOISE_PATTERNS: RegExp[] = [
  /^[wWｗ草藁笑]+$/,
  /^k+$/i,
  /^[ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ]+$/,
  /^(lol|lmao|lmfao|rofl|wtf|omg|gg|wp|gj)$/i,
  /^[!?.…]+$/,
  /^[\p{Extended_Pictographic}\s]+$/u,
  /^[8８]{2,}$/,
  /^(おつ|乙|うぽつ|うぽ|り|りょ|うぽつー*)$/,
  /^(.)\1{2,}$/u,
];

const PICTOGRAM_NOISE_RATIO = 0.7;
const PICTOGRAM_RE = /[\p{Extended_Pictographic}\s]/gu;

export function pictogramRatio(text: string): number {
  if (!text) return 0;
  const m = text.match(PICTOGRAM_RE);
  return m ? m.length / text.length : 0;
}

export function isNoise(text: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(text));
}

export type Verdict = "skip" | "korean" | "japanese" | "noise";

export function classify(rawText: string): Verdict {
  const text = (rawText || "").trim();
  if (!text) return "skip";

  const hangulMatches = text.match(HANGUL);
  if (hangulMatches && hangulMatches.length / text.length > 0.3) return "korean";
  const hasJa = HIRAGANA.test(text) || KATAKANA.test(text) || CJK.test(text);

  if (hasJa && pictogramRatio(text) >= PICTOGRAM_NOISE_RATIO) return "noise";
  if (hasJa && isNoise(text)) return "noise";
  if (hasJa) return "japanese";
  if (isNoise(text)) return "noise";
  return "skip";
}
