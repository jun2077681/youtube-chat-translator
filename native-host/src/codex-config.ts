// Shared Codex configuration read from the environment once. Imported by the
// persistent session, the one-shot path, and model detection so the env-var
// names and defaults live in a single place.

import { envInt, envWorkDir } from "./env";

export const CODEX_CMD: string = process.env.YLCT_CODEX_PATH || "codex";
export const CODEX_EFFORT: string = process.env.YLCT_CODEX_EFFORT || "low";
// Neutral working root so codex does not depend on Chrome's spawn cwd.
export const CODEX_WORK_DIR: string = envWorkDir("YLCT_CODEX_CWD");
export const CODEX_REQUEST_TIMEOUT_MS: number = envInt("YLCT_CODEX_TIMEOUT_MS", 60_000);
export const CODEX_IDLE_TIMEOUT_MS: number = envInt("YLCT_CODEX_IDLE_MS", 30 * 60_000);
