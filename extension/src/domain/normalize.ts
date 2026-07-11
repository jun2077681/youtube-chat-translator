// Pure text normalization used to build cache keys. NFC + trim + whitespace
// collapse + full-width→half-width, then collapse runs of 3+ repeated chars so
// "おはよーーーー" and "おはよー" share a cache entry. No DOM / chrome deps.

export function normalize(text: string): string {
  return (text || "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

const REPEAT_RE_G = /(.)\1{2,}/gu;

export function collapseRepeats(text: string): string {
  return text ? text.replace(REPEAT_RE_G, "$1") : "";
}

export function cacheKey(text: string): string {
  return collapseRepeats(normalize(text));
}
