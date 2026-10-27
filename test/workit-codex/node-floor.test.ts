// #424: the Codex hook entry fails open on a Node below the package's own
// engines minimum, before the Workit runtime loads (source and split dist).
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
    const env = { ...process.env, WORKIT_HOOK_NODE_VERSION: "20.11.1" };
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
