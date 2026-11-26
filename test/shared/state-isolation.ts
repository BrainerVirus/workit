// bun test preload (bunfig.toml): give the whole run a throwaway Workit state
// dir. Processes the suite spawns (the Cursor MCP server, the hook launcher,
// the CLI) inherit it, so their logs and heartbeats never land in the real
// ~/.local/state/workit. Tests that need a specific state dir still set
// WORKIT_STATE_DIR (or HOME/XDG_STATE_HOME after clearing it) themselves.
import { afterAll, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TEST_RUN_ENV, grantsHome } from "@/packages/workit-core/src/core/account-home";
import { guardRealHome, guardRealState } from "./real-state-guard";
import { TEST_RUN_REFUSALS } from "@/packages/workit-core/src/store/folder-store";

// Fail the run if a test left a worktree in the real state dir (a child given
// an env without this run's WORKIT_STATE_DIR), or changed the account's
// grants, seal or host settings (#859). Before the env below changes.
guardRealState();
guardRealHome();

// A host shell running the suite (OpenCode, Pi, Codex, a Claude Code-launched
// host) exports its own session id, which the CLI treats as the real session:
// a test's own WORKIT_SESSION_ID would then read as forged, and Claude Code's
// own marks, or Cursor's, make any of those variables a foreign host's (#981,
// #986). Tests that need a host session set these themselves.
for (const key of [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CURSOR_AGENT",
  "OPENCODE_SESSION_ID",
  "PI_SESSION_ID",
  "CODEX_THREAD_ID",
  "WORKIT_HOST",
  "WORKIT_AGENT_ID",
])
  delete process.env[key];

// A shell's (or CI runner's) XDG dirs would point a test that sets only HOME
// at the developer's real ~/.config (OpenCode config, Workit config): every
// test resolves them under its own HOME unless it sets them itself.
for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"])
  delete process.env[key];

// A shell that exports a host's config dir (often the developer's real one)
// would point a test's host commands and settings at it, which the run marker
// then refuses (#859): every test resolves them under its own HOME unless it
// sets them itself.
for (const key of [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "PI_CODING_AGENT_DIR",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG",
])
  delete process.env[key];

// Always a fresh dir, never an inherited one: `bun test --parallel` workers
// inherit the coordinator's env, and a shared dir made every worker share one
// ledger and its locks, and the first worker to finish deleted it under the
// rest (CI hangs, #415).
const dir = mkdtempSync(path.join(tmpdir(), "wk-test-state-"));
process.env.WORKIT_STATE_DIR = dir;
// Never let a test reach the developer's real, logged-in ytrack (youtrack-ytrack.ts findYtrack).
process.env.WORKIT_NO_YTRACK = "1";
// Never let the runner's own load hold a heavy check back (core/pressure.ts):
// the pressure gate's tests inject their own reading.
process.env.WORKIT_NO_PRESSURE_GATE = "1";
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A test (or a hook or CLI child it spawned) that resolved a folder store at
// the temp dir itself, a parent of it, or a folder outside it holding a
// .workit: the move would carry a real `.workit` into this run's state dir,
// deleted below (#892). Hooks fail open, so the refusal is recorded here and
// fails the test that caused it.
afterEach(() => {
  const file = path.join(dir, TEST_RUN_REFUSALS);
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  rmSync(file, { force: true });
  throw new Error(`folder-store guard tripped:\n${text}`);
});

// Grants are read from the OS account's home, which no env var moves (D15):
// in-process, every test reads them from a run-scoped temp home instead, so
// the real account's workspaces.json and its seal are never read here
// (useConfigHome swaps in its own home). Child processes still read the
// account record (D15): the run marker they inherit changes nothing they read
// and only makes them refuse to write the account's seal, grants or host
// settings (core/account-home.ts testRunWriteRefusal). Keep grant assertions
// in-process.
process.env[TEST_RUN_ENV] = dir;
const accountHomeForRun = path.join(dir, "account-home");
grantsHome.resolve = () => accountHomeForRun;

// Throwaway test repos never need git's auto-maintenance, which every commit
// started as an extra process (53 of 1,285 spawns in ledger-gates; costly on
// Windows). A test that sets GIT_CONFIG_COUNT itself replaces these.
process.env.GIT_CONFIG_COUNT = "2";
process.env.GIT_CONFIG_KEY_0 = "maintenance.auto";
process.env.GIT_CONFIG_VALUE_0 = "false";
process.env.GIT_CONFIG_KEY_1 = "gc.auto";
process.env.GIT_CONFIG_VALUE_1 = "0";
