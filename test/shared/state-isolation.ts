// bun test preload (bunfig.toml): give the whole run a throwaway Workit state
// dir. Processes the suite spawns (the Cursor MCP server, the hook launcher,
// the CLI) inherit it, so their logs and heartbeats never land in the real
// ~/.local/state/workit. Tests that need a specific state dir still set
// WORKFLOW_TOOLKIT_STATE (or HOME/XDG_STATE_HOME after clearing it) themselves.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A host shell running the suite (OpenCode, Pi, Codex, a Claude Code-launched
// host) exports its own session id, which the CLI treats as the real session:
// a test's own WORKIT_SESSION_ID would then read as forged. Tests that need a
// host session set these themselves.
for (const key of ["OPENCODE_SESSION_ID", "PI_SESSION_ID", "CODEX_THREAD_ID", "WORKIT_HOST"])
  delete process.env[key];

// A shell's (or CI runner's) XDG dirs would point a test that sets only HOME
// at the developer's real ~/.config (OpenCode config, Workit config): every
// test resolves them under its own HOME unless it sets them itself.
for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"])
  delete process.env[key];

// Always a fresh dir, never an inherited one: `bun test --parallel` workers
// inherit the coordinator's env, and a shared dir made every worker share one
// ledger and its locks, and the first worker to finish deleted it under the
// rest (CI hangs, #415).
const dir = mkdtempSync(path.join(tmpdir(), "wk-test-state-"));
process.env.WORKFLOW_TOOLKIT_STATE = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
