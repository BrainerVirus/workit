// Git spawn budgets (#284 N6). Each git process costs 10-30x more on Windows
// than on Linux, and the ledger gates asked git the same fixed facts again and
// again. These budgets fail when a change adds git calls to a hot path; when a
// change removes some, lower the budget to the new count.
//
// A `git` shim first on PATH counts every call, then runs the real git.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkVerdicts } from "@/packages/workit-core/src/ledger";
import { defaultBase } from "@/packages/workit-core/src/git/default-base";
import { forgetGitDirs } from "@/packages/workit-core/src/git/facts";

const BUDGET = {
  /** A first gate check on a branch (12 before #284 N6's first slice). */
  gateFirst: 11,
  /** The same gate again in the same process: the fixed facts come from the cache (was 11). */
  gateAgain: 9,
  /** defaultBase: one `git for-each-ref` whatever the candidates, plus the two reads of the track lookup (was 4, more with fewer candidates). */
  defaultBase: 3,
};

const dirs: string[] = [];
// The default base reads the workspace config (release tracks): an empty one
// of its own, so the machine's config cannot change the count.
const config = mkdtempSync(path.join(os.tmpdir(), "wk-budget-config-"));
const priorConfig = process.env.WORKIT_CONFIG;
beforeAll(() => {
  process.env.WORKIT_CONFIG = config;
});
afterAll(() => {
  if (priorConfig === undefined) delete process.env.WORKIT_CONFIG;
  else process.env.WORKIT_CONFIG = priorConfig;
  for (const dir of [...dirs, config]) rmSync(dir, { recursive: true, force: true });
});

const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync(realGit, args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
};

const fixture = (): { root: string; log: string; bin: string } => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-budget-")));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.test");
  git(root, "config", "user.name", "t");
  writeFileSync(path.join(root, "f"), "1\n");
  git(root, "add", "f");
  git(root, "commit", "-q", "-m", "one");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "switch", "-q", "-c", "feature/x");
  writeFileSync(path.join(root, "f"), "2\n");
  git(root, "commit", "-q", "-am", "two");
  const bin = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-budget-bin-")));
  dirs.push(bin);
  const log = path.join(bin, "calls");
  writeFileSync(log, "");
  const shim = path.join(bin, "git");
  writeFileSync(shim, `#!/bin/sh\necho "$*" >> '${log}'\nexec '${realGit}' "$@"\n`);
  chmodSync(shim, 0o755);
  return { root, log, bin };
};

const counted = (log: string, bin: string, run: () => void): string[] => {
  writeFileSync(log, "");
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved ?? ""}`;
  try {
    run();
  } finally {
    process.env.PATH = saved;
  }
  return readFileSync(log, "utf8").split("\n").filter(Boolean);
};

test.skipIf(process.platform === "win32")(
  "Given a branch with a base, When its verdict gate is checked twice and its base is read, Then git is spawned within budget",
  () => {
    const { root, log, bin } = fixture();
    forgetGitDirs();
    const first = counted(log, bin, () => checkVerdicts(root, "feature/x", []));
    const again = counted(log, bin, () => checkVerdicts(root, "feature/x", []));
    const base = counted(log, bin, () => defaultBase(root));
    const spent = { gateFirst: first.length, gateAgain: again.length, defaultBase: base.length };
    // Over budget: the calls, so the new one is easy to find.
    if (JSON.stringify(spent) !== JSON.stringify(BUDGET))
      console.error(JSON.stringify({ first, again, base }, null, 1));
    expect({
      gateFirst: first.length,
      gateAgain: again.length,
      defaultBase: base.length,
    }).toEqual(BUDGET);
  },
);
