import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GRANT_KINDS, requireGrant, resolveAutonomy } from "@/packages/workit-core/src/autonomy";

// #540 fix round: a submodule inside a linked worktree is capped through its
// superproject's chain, and a git probe that fails caps at nothing granted
// (fail closed) instead of reading as "not a worktree".

let configHome: ConfigHome;
let root = "";
const savedPath = process.env.PATH;
const savedName = process.env.WORKFLOW_WORKSPACE_NAME;
const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...args],
    { cwd, encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
};
const init = (at: string) => {
  mkdirSync(at, { recursive: true });
  git(at, "init", "-q");
  git(at, "commit", "-q", "--allow-empty", "-m", "i");
};
const unix = process.platform !== "win32";

beforeAll(() => {
  delete process.env.WORKFLOW_WORKSPACE_NAME;
  configHome = useConfigHome("wk-wt-probe-config-");
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-wt-probe-"))).replaceAll("\\", "/");
  // A superproject under brasil with a submodule, and a linked worktree of it under work.
  init(`${root}/src/lib`);
  const sup = `${root}/work/clients/brasil/super`;
  init(sup);
  git(sup, "submodule", "add", "-q", `${root}/src/lib`, "lib");
  git(sup, "commit", "-q", "-m", "sub");
  git(sup, "worktree", "add", "-q", "-b", "swt", `${root}/work/swt`);
  git(`${root}/work/swt`, "submodule", "update", "-q", "--init");
  // Worktrees of a checkout under work, for the failing-probe cases.
  const main = `${root}/work/main`;
  init(main);
  for (const name of ["shim", "nogit"])
    git(main, "worktree", "add", "-q", "-b", name, `${root}/work/${name}`);
  // A .git file pointing nowhere.
  mkdirSync(`${root}/work/broken`, { recursive: true });
  writeFileSync(`${root}/work/broken/.git`, "gitdir: /nonexistent/x\n");
  // A git that fails only --git-common-dir.
  mkdirSync(`${root}/shim`, { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(
    `${root}/shim/git`,
    `#!/bin/sh\nfor a in "$@"; do [ "$a" = --git-common-dir ] && exit 1; done\nexec ${real} "$@"\n`,
  );
  if (unix) chmodSync(`${root}/shim/git`, 0o755);
  mkdirSync(`${root}/empty`, { recursive: true });
});
afterAll(() => {
  configHome.restore();
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  process.env.PATH = savedPath;
  if (savedName === undefined) delete process.env.WORKFLOW_WORKSPACE_NAME;
  else process.env.WORKFLOW_WORKSPACE_NAME = savedName;
});

const write = (workspaces: Record<string, unknown>[]) =>
  writeFileSync(path.join(configHome.configDir, "workspaces.json"), JSON.stringify({ workspaces }));
const account = { provider: "github", account: "me" };
const permissive = () => ({
  name: "work",
  glob: `${root}/work/**`,
  vcs: account,
  autonomy: { merge: true, release: true },
  defaultEndpoint: "merged",
  verification: "self",
});
const nothingGranted = (cwd: string) => {
  const autonomy = resolveAutonomy(cwd);
  for (const kind of GRANT_KINDS)
    expect({ kind, value: autonomy.grants[kind] }).toEqual({ kind, value: false });
  expect(autonomy.effectiveEndpoint).toBe("commit");
  expect(autonomy.verification).toBe("independent");
  return autonomy;
};

test("a submodule inside a linked worktree is capped at the worktree's main checkout", () => {
  write([
    permissive(),
    {
      name: "brasil",
      glob: `${root}/work/clients/brasil/**`,
      vcs: account,
      autonomy: { merge: false },
      verification: "independent",
    },
  ]);
  const lib = `${root}/work/swt/lib`;
  const autonomy = resolveAutonomy(lib);
  expect(autonomy.workspace).toBe("work");
  expect(autonomy.grants.merge).toBe(false);
  expect(autonomy.grants.release).toBe(false);
  expect(autonomy.effectiveEndpoint).toBe("commit");
  expect(autonomy.verification).toBe("independent");
  const decision = requireGrant(lib, "merge");
  if (decision.allowed) throw new Error("expected a refusal");
  expect(decision.unblock).toContain("workit grant set brasil merge=verified");
});

test.skipIf(!unix)(
  "a git that fails --git-common-dir caps at nothing, and the failure is not cached",
  () => {
    write([permissive()]);
    const cwd = `${root}/work/shim`;
    process.env.PATH = `${root}/shim${path.delimiter}${savedPath}`;
    const autonomy = nothingGranted(cwd);
    expect(autonomy.note).toContain("git");
    const decision = requireGrant(cwd, "merge");
    if (decision.allowed) throw new Error("expected a refusal");
    expect(decision.unblock).toContain("git");
    process.env.PATH = savedPath;
    expect(resolveAutonomy(cwd).grants.merge).toBe(true);
  },
);

test("a .git file pointing at a missing gitdir caps at nothing", () => {
  write([permissive()]);
  expect(nothingGranted(`${root}/work/broken`).note).toContain("git");
});

test("no git on PATH caps a checkout at nothing", () => {
  write([permissive()]);
  process.env.PATH = `${root}/empty`;
  expect(nothingGranted(`${root}/work/nogit`).note).toContain("git");
});

test("a folder in no repository needs no git and is not capped", () => {
  write([permissive()]);
  mkdirSync(`${root}/work/plain`, { recursive: true });
  process.env.PATH = `${root}/empty`;
  expect(resolveAutonomy(`${root}/work/plain`).grants.merge).toBe(true);
});

test("#548: a checkout whose git directory no checkout owns (--separate-git-dir) caps at nothing; its own .git directory does not", () => {
  write([permissive()]);
  const sep = `${root}/work/sep`;
  mkdirSync(sep, { recursive: true });
  git(sep, "init", "-q", "--separate-git-dir", `${root}/sep.git`);
  expect(nothingGranted(sep).note).toContain("owned by no checkout");
  expect(resolveAutonomy(`${root}/work/main`).grants.merge).toBe(true);
});
