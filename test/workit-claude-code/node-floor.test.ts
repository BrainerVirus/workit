// #424: a Node below the package's own engines minimum fails the Claude Code
// launcher open with one clear stderr line, before dist loads.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PLUGIN_DIR } from "./plugin-helpers";

const LAUNCHER = path.join(PLUGIN_DIR, "bin", "workit-hook.mjs");
const run = (version: string) =>
  spawnSync("node", [LAUNCHER], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: "/tmp" }),
    encoding: "utf8",
    env: { ...process.env, WORKIT_HOOK_NODE_VERSION: version },
  });

test("Given Node 20 on PATH, When the launcher runs, Then it answers {} with exit 0 and names both versions", () => {
  const child = run("20.11.1");
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({});
  expect(child.stderr.trim()).toBe(
    "[workit] Claude Code hook unavailable: needs Node >=24, found 20.11.1",
  );
});

test("Given Node 24, When the launcher runs, Then the floor message is not written", () => {
  expect(run("24.0.0").stderr).not.toContain("needs Node");
});
