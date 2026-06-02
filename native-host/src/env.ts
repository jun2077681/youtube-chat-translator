// Tiny env-var parsing helpers shared across the providers and sessions so the
// `parseInt(... ?? "") || default` and `process.env.X || tmpdir()` idioms live
// in one place instead of being re-inlined per file.

import os from "node:os";

// Parse an integer env var, falling back to `fallback` when unset/empty/invalid
// (NaN and 0 both fall through to the default, matching the original idiom).
export function envInt(name: string, fallback: number): number {
  return parseInt(process.env[name] ?? "", 10) || fallback;
}

// A neutral working directory from the named env var, defaulting to the OS temp
// dir so CLIs do not depend on Chrome's spawn cwd.
export function envWorkDir(name: string): string {
  return process.env[name] || os.tmpdir();
}
