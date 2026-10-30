// #424: the Codex hook entry fails open on a Node below the package's own
// engines minimum, before the Workit runtime loads (source and split dist).
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bareNodeEnv, fakeNode } from "../shared/helpers/hook-node";

const LAUNCHER = path.resolve(import.meta.dir, "../../packages/workit-codex/hooks/launcher.ts");
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const payload = JSON.stringify({
  hook_event_name: "PreToolUse",
  session_id: "s",
  cwd: "/tmp",
  tool_name: "bash",
  tool_input: { command: "ls" },
});

const builtDist = () => {
  const pkg = mkdtempSync(path.join(tmpdir(), "wk-codex-floor-"));
  dirs.push(pkg);
  writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ type: "module", engines: { node: ">=24" } }),
  );
  mkdirSync(path.join(pkg, "dist"));
  const built = spawnSync(
    process.execPath,
    [
      "build",
      LAUNCHER,
      "--splitting",
      "--outdir",
      path.join(pkg, "dist"),
      "--entry-naming",
      "workit-hook.js",
      "--chunk-naming",
      "workit-hook-[hash].js",
      "--target",
      "node",
      "--format",
      "esm",
    ],
    { encoding: "utf8" },
  );
  if (built.status !== 0) throw new Error(built.stderr || built.stdout);
  return path.join(pkg, "dist", "workit-hook.js");
};

for (const entry of ["source", "dist"] as const)
  test(`[${entry}] Given Node 20, When the Codex hook runs, Then it answers {} and names both versions`, () => {
    const env = bareNodeEnv({ WORKIT_HOOK_NODE_VERSION: "20.11.1" });
    const child =
      entry === "source"
        ? spawnSync(process.execPath, [LAUNCHER], { input: payload, encoding: "utf8", env })
        : spawnSync("node", [builtDist()], { input: payload, encoding: "utf8", env });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({});
    expect(child.stderr.trim()).toBe(
      "[workit] Codex hook unavailable: needs Node >=24, found 20.11.1",
    );
  }, 60_000);

const SESSION_START = JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1" });
const runSource = (env: Record<string, string>, input = payload) =>
  spawnSync(process.execPath, [LAUNCHER], {
    input,
    encoding: "utf8",
    env: bareNodeEnv({ WORKIT_HOOK_NODE_VERSION: "20.11.1", ...env }),
  });

test("Given Node 20 on PATH and a Node 24 resolved, When the Codex hook fires, Then it re-runs on it with stdin, stdout, stderr and the exit code passed through", () => {
  const child = runSource({ WORKIT_NODE: fakeNode() });
  expect(child.status).toBe(3);
  expect(child.stdout).toContain(`ARGV ${LAUNCHER}`);
  expect(child.stdout).toContain(payload);
  expect(child.stderr).toContain("guard=1 version=unset");
});

test("Given the re-exec guard is set, When the PATH node is still too old, Then the Codex hook fails open instead of looping", () => {
  const child = runSource({ WORKIT_NODE: fakeNode(), WORKIT_HOOK_REEXEC: "1" });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({});
});

test("Given no Node 24, When Codex fires SessionStart, Then the hook output tells the agent the hooks are off", () => {
  const child = runSource({}, SESSION_START);
  expect(child.status).toBe(0);
  const out = JSON.parse(child.stdout);
  expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(out.hookSpecificOutput.additionalContext).toContain("Workit hooks are off");
});
