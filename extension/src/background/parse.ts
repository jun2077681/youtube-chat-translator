// Parse the model's raw text reply into the expected { results: [...] } shape.
// The CLI sometimes wraps JSON in a markdown fence or adds preamble, so we try
// strict parse first, then a fenced-block extract, then a first-{ to last-}
// slice before giving up.

export interface ParsedResults {
  results?: Array<{ id?: string; ko?: string; ja?: string }>;
}

export function parseClaudeJson(text: string | undefined): ParsedResults | null {
  if (!text) return null;
  let s = text.trim();

  const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) s = fenceMatch[1].trim();

  try { return JSON.parse(s) as ParsedResults; } catch { /* try slice below */ }

  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)) as ParsedResults; } catch { /* give up */ }
  }
  return null;
}
