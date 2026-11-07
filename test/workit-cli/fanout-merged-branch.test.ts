// Retro 2026-11-07: `workit fanout worktree create` reused perf/hook-bundle-headroom,
// a branch whose PR had squash-merged ten days before, as a slice branch. A slice
// branch that already landed is refused with a free suffixed name; an unmerged
// one is still resumed. Real git repositories with a bare origin, the real CLI
// entry, no forge (git's squash and trunk checks decide).
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

setDefaultTimeout(60_000);

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-fanout-merged-config-");
});
afterAll(() => configHome.restore());

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const run = async (cwd: string, argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "lead-1" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, out: stdout + stderr };
};

const repo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-fanout-merged-"));
  dirs.push(root);
  const bare = path.join(root, "origin.git");
  const cwd = path.join(root, "app");
  const hooks = path.join(root, "hooks");
  mkdirSync(cwd);
  mkdirSync(hooks);
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(cwd, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "t"],
    ["user.email", "t@t"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", hooks],
  ])
    git(cwd, "config", key, value);
  writeFileSync(path.join(cwd, "README.md"), "# app\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "chore: base");
  git(cwd, "remote", "add", "origin", bare);
  git(cwd, "push", "-q", "-u", "origin", "main");
  return { root, cwd };
};

/** perf/x with one commit, pushed; squash-merged into main when `merged`. */
const branchX = (cwd: string, merged: boolean) => {
  git(cwd, "switch", "-q", "-c", "perf/x");
  writeFileSync(path.join(cwd, "x.ts"), "export const x = 1;\n");
  git(cwd, "add", "x.ts");
  git(cwd, "commit", "-qm", "perf: x");
  git(cwd, "push", "-q", "-u", "origin", "perf/x");
  git(cwd, "switch", "-q", "main");
  if (!merged) return;
  git(cwd, "merge", "-q", "--squash", "perf/x");
  git(cwd, "commit", "-qm", "perf: x (#543)");
  git(cwd, "push", "-q", "origin", "main");
};

const plan = async (root: string, cwd: string) => {
  const file = path.join(root, "plan.json");
  writeFileSync(
    file,
    JSON.stringify({
      name: "wave",
      trunk: "main",
      slices: [
        {
          id: "x",
          branch: "perf/x",
          tier: "mundane",
          reason: "parallel",
          scope: ["x.ts"],
          goal: "x is faster",
          acceptance: ["Given x, When it runs, Then it is faster"],
          verify: ["workit check test"],
          forbidden: ["no edits outside SCOPE"],
        },
      ],
    }),
  );
  const planned = await run(cwd, ["fanout", "plan", file, "--json"]);
  expect(planned.code, planned.out).toBe(0);
};

test("Given perf/x squash-merged and kept locally, When fanout worktree create runs for a slice on perf/x, Then it refuses and names perf/x-2", async () => {
  const { root, cwd } = repo();
  branchX(cwd, true);
  await plan(root, cwd);
  const created = await run(cwd, ["fanout", "worktree", "create", "x"]);
  expect(created.code).not.toBe(0);
  expect(created.out).toContain("perf/x-2");
  expect(git(cwd, "worktree", "list")).not.toContain("perf/x");
});

test("Given perf/x squash-merged and only on the remote, with perf/x-2 taken, When fanout worktree create runs, Then it refuses and names perf/x-3", async () => {
  const { root, cwd } = repo();
  branchX(cwd, true);
  git(cwd, "branch", "-q", "-D", "perf/x");
  git(cwd, "branch", "-q", "perf/x-2", "main");
  await plan(root, cwd);
  const created = await run(cwd, ["fanout", "worktree", "create", "x"]);
  expect(created.code).not.toBe(0);
  expect(created.out).toContain("perf/x-3");
  expect(created.out).not.toContain("perf/x-2 ");
});

test("Given perf/x with unmerged commits, When fanout worktree create runs, Then it resumes the branch", async () => {
  const { root, cwd } = repo();
  branchX(cwd, false);
  await plan(root, cwd);
  const created = await run(cwd, ["fanout", "worktree", "create", "x", "--json"]);
  expect(created.code, created.out).toBe(0);
  const data = JSON.parse(created.out).data as { mode: string; head: string };
  expect(data.mode).toBe("resume");
  expect(data.head).toBe(git(cwd, "rev-parse", "perf/x"));
});
