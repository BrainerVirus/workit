// #835: `workit ledger decision … --keep <branch:|worktree:|proc:>` records
// the user's keep. A proc: keep marks the registry row with the decision id
// (core/procs.ts keepProc); one naming no registered process is refused
// before anything is recorded.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { openProcs } from "@/packages/workit-core/src/core/procs";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { readProc, upsertProc } from "@/packages/workit-core/src/store/threads/procs";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const world = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-ledger-keep-"));
  dirs.push(root);
  const repo = path.join(root, "repo");
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKIT_STATE_DIR: path.join(root, "state"),
    WORKIT_SESSION_ID: "lead-1",
  };
  return { repo, env };
};

const run = async (cwd: string, env: NodeJS.ProcessEnv, argv: string[]) => {
  let stdout = "";
  const code = await main(argv, {
    cwd,
    env,
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  });
  return { code, stdout, json: () => JSON.parse(stdout) };
};

const decisions = (cwd: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === "decision");
};

test("Given --keep for a branch, a worktree and a registered process, Then the decision lists them and the process row is kept by that decision", async () => {
  const { repo, env } = world();
  const store = openProcs(env);
  try {
    upsertProc(store, "pk0001", () => ({
      cwd: repo,
      cmd: "bun run dev",
      kind: "server",
      startedAt: new Date().toISOString(),
    }));
  } finally {
    store.close();
  }
  const result = await run(repo, env, [
    "ledger",
    "decision",
    "keep the demo",
    "--why",
    "the user: keep the demo up until Friday",
    "--keep",
    "branch:feature/demo",
    "--keep",
    "worktree:../demo-wt",
    "--keep",
    "proc:pk0001",
  ]);
  expect(result.code, result.stdout).toBe(0);
  const [row] = decisions(repo);
  expect(row.keep).toEqual([
    "branch:feature/demo",
    `worktree:${path.resolve(repo, "../demo-wt")}`,
    "proc:pk0001",
  ]);
  expect(result.stdout).toContain(`keep proc:pk0001: cleanup leaves it (decision ${row.id})`);
  const after = openProcs(env);
  try {
    expect(readProc(after, "pk0001")).toMatchObject({ keep: true, keepRef: `decision ${row.id}` });
  } finally {
    after.close();
  }
  const listed = await run(repo, env, ["ledger", "list", "--type", "decision"]);
  expect(listed.stdout).toContain("keep: branch:feature/demo");
});

test("Given --keep naming no registered process, Then the decision is refused and nothing is recorded", async () => {
  const { repo, env } = world();
  const result = await run(repo, env, [
    "ledger",
    "decision",
    "keep it",
    "--why",
    "the user said so",
    "--keep",
    "proc:nope",
    "--json",
  ]);
  expect(result.code).not.toBe(0);
  expect(result.json().error).toBe("--keep proc:nope: no such registered process");
  expect(decisions(repo)).toEqual([]);
});
