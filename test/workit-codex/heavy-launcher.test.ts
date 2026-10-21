// #325 B1: the Codex hook entry's quiet path answers before the runtime loads
// for commands that cannot matter; a heavy command must reach the gate. Both
// entries: the source launcher under bun and the split dist entry under node.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const LAUNCHER = path.resolve(import.meta.dir, "../../packages/workit-codex/hooks/launcher.ts");
const dirs: string[] = [];
let dist: string;
let env: NodeJS.ProcessEnv;
let root: string;

beforeAll(() => {
  const out = mkdtempSync(path.join(tmpdir(), "wk-codex-heavy-dist-"));
  const bin = mkdtempSync(path.join(tmpdir(), "wk-codex-heavy-bin-"));
  const home = mkdtempSync(path.join(tmpdir(), "wk-codex-heavy-home-"));
  root = mkdtempSync(path.join(tmpdir(), "wk-codex-heavy-repo-"));
  dirs.push(out, bin, home, root);
  spawnSync("git", ["init", "-q", "-b", "feature/x"], { cwd: root });
  const built = spawnSync(
    process.execPath,
    [
      "build",
      LAUNCHER,
      "--splitting",
      "--outdir",
      out,
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
  dist = path.join(out, "workit-hook.js");
  writeFileSync(path.join(bin, "workit"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "workit"), 0o755);
  env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    CODEX_HOME: path.join(home, ".codex"),
    WORKFLOW_TOOLKIT_STATE: path.join(home, "state"),
  };
});
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const run = (entry: "source" | "dist", command: string) => {
  const payload = JSON.stringify({
    session_id: "session-1",
    cwd: root,
    model: "gpt-5",
    permission_mode: "default",
    transcript_path: null,
    hook_event_name: "PreToolUse",
    turn_id: "turn-1",
    tool_use_id: "tool-1",
    tool_name: "bash",
    tool_input: { command },
  });
  const child =
    entry === "source"
      ? spawnSync(process.execPath, [LAUNCHER], { input: payload, encoding: "utf8", env })
      : spawnSync("node", [dist], { input: payload, encoding: "utf8", env });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as {
    hookSpecificOutput: {
      hookEventName?: string;
      permissionDecision?: string;
      permissionDecisionReason?: string;
    };
  };
};

for (const entry of ["source", "dist"] as const)
  test(`[${entry}] Given make test, npx jest and docker build, When the Codex hook runs, Then each is denied with the exact rewrite; ls stays quiet`, () => {
    for (const command of ["make test", "npx jest", "docker build -t app ."]) {
      const output = run(entry, command).hookSpecificOutput;
      expect(output.permissionDecision, command).toBe("deny");
      expect(output.permissionDecisionReason).toContain(
        `Run exactly: workit check --heavy -- ${command}`,
      );
    }
    expect(run(entry, "ls -la")).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse" } });
  }, 60_000);
