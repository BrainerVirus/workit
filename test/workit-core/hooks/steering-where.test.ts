// The per-turn task context names where the agent is in one line: cwd, the
// checkout it is in and its branch, and the branch kinds it may create (#431).
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { whereLine } from "@/packages/workit-core/src/hooks/context";
import { tempRoot, withProtectedMain } from "./hook-fixtures";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

test("G a checkout on feature/x, W the where line is built from a subdirectory, T it names cwd, checkout, branch and kinds", async () => {
  await withProtectedMain(() => {
    const root = tempRoot("workit-where-");
    roots.push(root);
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    git("checkout", "-q", "-b", "feature/x");
    const sub = path.join(root, "src");
    mkdirSync(sub);
    const line = whereLine(sub) ?? "";
    expect(line).toStartWith(`cwd ${sub} in ${root} on feature/x; branch kinds: `);
    expect(line).toContain("feature");
    expect(line.split("\n")).toHaveLength(1);
    expect(whereLine(root)).toStartWith(`cwd ${root} on feature/x;`);
  });
});
