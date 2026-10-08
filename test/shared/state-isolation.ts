// bun test preload (bunfig.toml): give the whole run a throwaway Workit state
// dir. Processes the suite spawns (the Cursor MCP server, the hook launcher,
// the CLI) inherit it, so their logs and heartbeats never land in the real
// ~/.local/state/workit. Tests that need a specific state dir still set
// WORKFLOW_TOOLKIT_STATE (or HOME/XDG_STATE_HOME after clearing it) themselves.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (!process.env.WORKFLOW_TOOLKIT_STATE) {
  const dir = mkdtempSync(path.join(tmpdir(), "wk-test-state-"));
  process.env.WORKFLOW_TOOLKIT_STATE = dir;
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
}
