// Codex model auto-detection.
//
// Codex pins concrete versioned model names (e.g. gpt-5.4-mini) that change as
// new versions ship and differ per account/plan. `codex debug models` renders
// the account's usable catalog as JSON, so we query it once per host session
// and auto-pick the lightest model: among the "mini" variants the account can
// list, the lowest version number. Falls back to the CLI default (no -m) if the
// account has no mini or the command fails. YLCT_CODEX_MODEL overrides everything.

import { createLogger, errMsg, runCommand } from "./proc-util";
import { CODEX_CMD } from "./codex-config";

const ENV_MODEL = process.env.YLCT_CODEX_MODEL || "";

const log = createLogger("[ylct-codex-models]");

interface CatalogModel {
  slug?: string;
  visibility?: string;
  supported_in_api?: boolean;
}

// Extract a comparable version tuple from a slug ("gpt-5.4-mini" -> [5, 4]).
function parseVersion(slug: string): number[] {
  const m = slug.match(/(\d+(?:\.\d+)+|\d+)/);
  if (!m) return [Number.MAX_SAFE_INTEGER];
  return m[1].split(".").map((n) => parseInt(n, 10));
}

function compareVersion(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Lowest-version "mini" model the account can list (lightest/fastest).
function selectLightestMini(models: CatalogModel[]): string | null {
  const minis = models.filter((m) =>
    typeof m.slug === "string" &&
    m.slug.includes("mini") &&
    (m.visibility === undefined || m.visibility === "list") &&
    m.supported_in_api !== false
  );
  if (minis.length === 0) return null;
  minis.sort((a, b) => compareVersion(parseVersion(a.slug!), parseVersion(b.slug!)));
  return minis[0].slug!;
}

async function detect(): Promise<string | undefined> {
  const res = await runCommand({ cmd: CODEX_CMD, args: ["debug", "models"], timeoutMs: 15_000 });
  if (!res.ok) {
    log("`codex debug models` failed, using CLI default:", res.error || "");
    return undefined;
  }
  try {
    const parsed = JSON.parse(res.stdout) as { models?: CatalogModel[] } | CatalogModel[];
    const models = Array.isArray(parsed) ? parsed : (parsed.models || []);
    const pick = selectLightestMini(models);
    if (pick) log("auto-selected codex model:", pick);
    else log("no mini model in catalog, using CLI default");
    return pick ?? undefined;
  } catch (err) {
    log("could not parse catalog, using CLI default:", (err as Error).message);
    return undefined;
  }
}

let cached: Promise<string | undefined> | null = null;

// Resolve the codex model to use: explicit env override, else the auto-detected
// lightest mini (cached for the host session), else undefined (CLI default).
export function getCodexModel(): Promise<string | undefined> {
  if (ENV_MODEL) return Promise.resolve(ENV_MODEL);
  if (!cached) cached = detect();
  return cached;
}

// Drop the cached detection so the next call re-queries (used on session reset
// and on a model error, so the auto-detected model is re-validated lazily).
export function resetCodexModelCache(): void {
  cached = null;
}

// Whether an error message looks like the chosen model is invalid/unavailable
// (vs auth/network/other), so callers re-detect only when it would help.
function isCodexModelError(message: string): boolean {
  return /model/i.test(message) &&
    /(not supported|not found|unknown|invalid|unavailable|does not exist|deprecated|no longer)/i.test(message);
}

// Run `fn`; if it fails with a model-specific error (not auth/network) and the
// model isn't pinned via env, drop the cached detection and retry once. Lets the
// auto-detected model self-heal without re-checking on every call. Used by both
// the persistent session and the one-shot path.
export async function withModelErrorRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = errMsg(err);
    if (!ENV_MODEL && isCodexModelError(msg)) {
      resetCodexModelCache();
      return fn();
    }
    throw err;
  }
}
