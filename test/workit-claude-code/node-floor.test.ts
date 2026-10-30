// #424: a Node below the package's own engines minimum no longer fails the
// Claude Code launcher open when a Node >= 24 exists: it re-runs the hook on
// that one. With none, it fails open (one stderr line) and SessionStart tells
// the agent once.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { bareNodeEnv, fakeNode } from "../shared/helpers/hook-node";
import { PLUGIN_DIR } from "./plugin-helpers";

const LAUNCHER = path.join(PLUGIN_DIR, "bin", "workit-hook.mjs");
const PRE_TOOL = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: "/tmp" });
const SESSION_START = JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1" });
const run = (version: string, env: Record<string, string> = {}, input = PRE_TOOL) =>
  spawnSync("node", [LAUNCHER], {
    input,
    encoding: "utf8",
    env: bareNodeEnv({ WORKIT_HOOK_NODE_VERSION: version, ...env }),
  });

test("Given Node 20 on PATH and no Node 24 anywhere, When the launcher runs, Then it answers {} with exit 0 and names both versions", () => {
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

test("Given Node 20 on PATH and a Node 24 resolved, When the hook fires, Then the launcher re-runs on it with stdin, stdout, stderr and the exit code passed through", () => {
  const node = fakeNode();
  const child = run("20.11.1", { WORKIT_NODE: node });
  expect(child.status).toBe(3);
  expect(child.stdout).toContain(`ARGV ${LAUNCHER}`);
  expect(child.stdout).toContain(PRE_TOOL);
  // The child carries the guard and a real (not the faked) version.
  expect(child.stderr).toContain("guard=1 version=unset");
  expect(child.stderr).not.toContain("hook unavailable");
});

test("Given the re-exec guard is already set, When the PATH node is still too old, Then the launcher fails open instead of looping", () => {
  const child = run("20.11.1", { WORKIT_NODE: fakeNode(), WORKIT_HOOK_REEXEC: "1" });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({});
  expect(child.stderr).toContain("needs Node >=24, found 20.11.1");
});

test("Given Node 20 and no Node 24, When SessionStart fires, Then additionalContext tells the agent the hooks are off and how to fix it", () => {
  const child = run("22.19.0", {}, SESSION_START);
  expect(child.status).toBe(0);
  const out = JSON.parse(child.stdout);
  expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(out.hookSpecificOutput.additionalContext).toContain("Workit hooks are off");
  expect(out.hookSpecificOutput.additionalContext).toContain("22.19.0");
  expect(out.hookSpecificOutput.additionalContext).toContain("workit setup");
});
