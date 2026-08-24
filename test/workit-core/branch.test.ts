import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRepoTools } from "../../packages/workit-opencode/src/tools/repo";
import { restoreFlowSnapshot, snapshotFlowState } from "../../packages/workit-core/src/core/branch";

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

// Isolate from the developer's global config: tests assume gitflow semantics
// (PRESETS.gitflow in src/core/config.ts), like CI with no global config.
// Mirrors the isolation pattern of test/workit-core/branch-policy.test.ts.
const previousXdg = process.env.XDG_CONFIG_HOME;
let isolatedConfig: string;
beforeAll(() => {
  isolatedConfig = mkdtempSync(path.join(os.tmpdir(), "wf-branch-test-config-"));
  writeFileSync(
    path.join(isolatedConfig, "config.json"),
    JSON.stringify(
      {
        locale: "en",
        localeOptions: ["en"],
        timezone: "UTC",
        branchPolicy: {
          preset: "gitflow",
          allowed: ["feature/*", "bugfix/*", "hotfix/*", "release/*"],
          protected: ["main", "develop", "master", "prod", "production"],
        },
      },
      null,
      2,
    ),
  );
  process.env.XDG_CONFIG_HOME = isolatedConfig;
});
afterAll(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  rmSync(isolatedConfig, { recursive: true, force: true });
});

const repoOnMain = ({ withDevelop }: { withDevelop: boolean }) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-branch-hardening-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "wf-branch-hardening-remote-"));
  git(remote, ["init", "-q", "--bare"]);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Workflow Test"]);
  git(root, ["config", "user.email", "workflow@example.test"]);
  writeFileSync(path.join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "base"]);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["push", "-q", "-u", "origin", "main"]);
  if (withDevelop) {
    git(root, ["branch", "develop"]);
    git(root, ["push", "-q", "origin", "develop"]);
    git(root, ["branch", "-D", "develop"]);
  }
  return { root, remote };
};

const dirtyTree = (root: string) => {
  writeFileSync(path.join(root, "README.md"), "wip change\n");
  writeFileSync(path.join(root, "notes.md"), "untracked doc\n");
};

test("failed base resolution after stash leaves tree intact (no stranded stash)", async () => {
  // CA-02 regression: origin lacks develop, so base resolution must fail
  // BEFORE any mutation — never after the stash push has already emptied the
  // tree (the late failure that stranded a stash and lost visible work).
  const { root, remote } = repoOnMain({ withDevelop: false });
  try {
    dirtyTree(root);
    const raw = await createRepoTools().workit_branch_setup.execute(
      {
        confirmed: true,
        target_branch: "bugfix/x",
        stash: "yes",
      },
      { directory: root, worktree: root } as never,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("origin/develop missing");
    expect(git(root, ["stash", "list"]).stdout.trim()).toBe("");
    expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe("wip change\n");
    expect(existsSync(path.join(root, "notes.md"))).toBe(true);
    expect(git(root, ["branch", "--show-current"]).stdout.trim()).toBe("main");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("policy/base resolution runs before any stash push", async () => {
  // CA-01 regression: base resolution succeeds here but a later step fails
  // after the stash push (local branch `bugfix` blocks creating `refs/heads/
  // bugfix/x`), so the error path must pop the stash back before returning —
  // the tree ends up exactly as it was left, with no stranded stash entry.
  const { root, remote } = repoOnMain({ withDevelop: true });
  try {
    git(root, ["branch", "bugfix"]);
    dirtyTree(root);
    const raw = await createRepoTools().workit_branch_setup.execute(
      {
        confirmed: true,
        target_branch: "bugfix/x",
        stash: "yes",
      },
      { directory: root, worktree: root } as never,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(false);
    expect(git(root, ["stash", "list"]).stdout.trim()).toBe("");
    expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe("wip change\n");
    expect(existsSync(path.join(root, "notes.md"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("manifest write failure after checkout restores stash and reports error", async () => {
  // Regression: a throw in the post-checkout manifest section stranded the
  // stash — the error path must pop it back before returning.
  const { root, remote } = repoOnMain({ withDevelop: true });
  try {
    mkdirSync(path.join(root, "docs"), { recursive: true });
    chmodSync(path.join(root, "docs"), 0o500); // writeFileSync will EACCES
    dirtyTree(root);
    const raw = await createRepoTools().workit_branch_setup.execute(
      {
        confirmed: true,
        target_branch: "bugfix/x",
        stash: "yes",
      },
      { directory: root, worktree: root } as never,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("manifest update failed");
    expect(String(result.error)).not.toContain("changes preserved in stash");
    expect(git(root, ["stash", "list"]).stdout.trim()).toBe("");
    expect(git(root, ["branch", "--show-current"]).stdout.trim()).toBe("bugfix/x");
    expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe("wip change\n");
    expect(existsSync(path.join(root, "notes.md"))).toBe(true);
  } finally {
    chmodSync(path.join(root, "docs"), 0o700);
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("snapshot captures every docs/*/sdd/flow.json outside the repository", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wf-flow-snap-"));
  let snap: string | undefined;
  try {
    const alpha = Buffer.from('{"slug":"alpha","status":"approved"}\n');
    const beta = Buffer.from('{"slug":"beta","status":"approved"}\n');
    mkdirSync(path.join(cwd, "docs", "alpha", "sdd"), { recursive: true });
    mkdirSync(path.join(cwd, "docs", "beta", "sdd"), { recursive: true });
    mkdirSync(path.join(cwd, "docs", "gamma", "sdd"), { recursive: true });
    writeFileSync(path.join(cwd, "docs", "alpha", "sdd", "flow.json"), alpha);
    writeFileSync(path.join(cwd, "docs", "beta", "sdd", "flow.json"), beta);
    writeFileSync(path.join(cwd, "docs", "gamma", "sdd", "other.json"), "{}\n");

    snap = snapshotFlowState(cwd);

    expect(snap.startsWith(os.tmpdir())).toBe(true);
    expect(snap.includes("workit-flow-guard-")).toBe(true);
    expect(snap.startsWith(cwd)).toBe(false);
    expect(readFileSync(path.join(snap, "docs", "alpha", "sdd", "flow.json"))).toEqual(alpha);
    expect(readFileSync(path.join(snap, "docs", "beta", "sdd", "flow.json"))).toEqual(beta);
    expect(existsSync(path.join(snap, "docs", "gamma"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    if (snap) rmSync(snap, { recursive: true, force: true });
  }
});

test("restore recreates missing flow.json byte-identical and never overwrites newer files", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wf-flow-restore-"));
  try {
    const alphaBytes = Buffer.from('{"rev":1}\n');
    mkdirSync(path.join(cwd, "docs", "alpha", "sdd"), { recursive: true });
    mkdirSync(path.join(cwd, "docs", "beta", "sdd"), { recursive: true });
    writeFileSync(path.join(cwd, "docs", "alpha", "sdd", "flow.json"), alphaBytes);
    writeFileSync(path.join(cwd, "docs", "beta", "sdd", "flow.json"), '{"rev":1}\n');

    const snap = snapshotFlowState(cwd);
    rmSync(path.join(cwd, "docs", "alpha"), { recursive: true, force: true });
    writeFileSync(path.join(cwd, "docs", "beta", "sdd", "flow.json"), '{"rev":2,"newer":true}\n');

    restoreFlowSnapshot(snap, cwd);

    expect(readFileSync(path.join(cwd, "docs", "alpha", "sdd", "flow.json"))).toEqual(alphaBytes);
    expect(readFileSync(path.join(cwd, "docs", "beta", "sdd", "flow.json"), "utf8")).toContain(
      '"newer":true',
    );
    expect(existsSync(snap)).toBe(false);
    expect(
      readdirSync(path.join(cwd, "docs", "alpha", "sdd")).filter((f) => f.includes(".tmp-")),
    ).toEqual([]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("restore failure retains the snapshot root and reports a warning", () => {
  if (process.getuid?.() === 0) return; // chmod injection ineffective as root
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wf-flow-retain-"));
  mkdirSync(path.join(cwd, "docs", "alpha", "sdd"), { recursive: true });
  writeFileSync(path.join(cwd, "docs", "alpha", "sdd", "flow.json"), '{"rev":1}\n');
  const snap = snapshotFlowState(cwd);
  try {
    rmSync(path.join(cwd, "docs", "alpha", "sdd"), { recursive: true, force: true });
    chmodSync(path.join(cwd, "docs", "alpha"), 0o500);

    expect(restoreFlowSnapshot(snap, cwd)).toContain("flow state snapshot restore failed");
    expect(existsSync(snap)).toBe(true);
  } finally {
    chmodSync(path.join(cwd, "docs", "alpha"), 0o700);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(snap, { recursive: true, force: true });
  }
});

test("setup(stash=yes) keeps flow.json byte-identical and leaves no snapshot behind", async () => {
  const { root, remote } = repoOnMain({ withDevelop: false });
  const guardsBefore = new Set(
    readdirSync(os.tmpdir()).filter((d) => d.startsWith("workit-flow-guard-")),
  );
  try {
    writeFileSync(path.join(root, ".gitignore"), "docs/*/sdd/\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-q", "-m", "ignore sdd runtime state"]);
    git(root, ["branch", "develop"]);
    git(root, ["push", "-q", "origin", "develop"]);
    git(root, ["branch", "-D", "develop"]);

    const flowPath = path.join(root, "docs", "hardening", "sdd", "flow.json");
    mkdirSync(path.dirname(flowPath), { recursive: true });
    const flowBytes = Buffer.from('{"status":"approved"}\n');
    writeFileSync(flowPath, flowBytes);
    writeFileSync(path.join(root, "docs", "hardening", "spec.md"), "# spec\n");
    dirtyTree(root);

    const raw = await createRepoTools().workit_branch_setup.execute(
      {
        confirmed: true,
        target_branch: "bugfix/hardening",
        stash: "yes",
      },
      { directory: root, worktree: root } as never,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(true);
    expect(result.data.stash_ref).not.toBeNull();
    expect(result.data.warnings).toBeUndefined();
    expect(git(root, ["branch", "--show-current"]).stdout.trim()).toBe("bugfix/hardening");
    expect(readFileSync(flowPath)).toEqual(flowBytes);

    // CA-04/CA-05: snapshot cleaned from its hashed tempdir location.
    const expectedRoot = path.join(
      os.tmpdir(),
      `workit-flow-guard-${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16)}`,
    );
    expect(existsSync(expectedRoot)).toBe(false);
    const newGuards = readdirSync(os.tmpdir())
      .filter((d) => d.startsWith("workit-flow-guard-"))
      .filter((d) => !guardsBefore.has(d));
    expect(newGuards).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("failed setup restores flow.json deleted mid-window and leaves no guard root", async () => {
  // Late-base-failure fixture (local branch `bugfix` blocks refs/heads/
  // bugfix/x) plus a hostile mid-window actor: a post-checkout hook deletes
  // docs/*/sdd/flow.json during ensureBaseBranch's checkout of develop —
  // a deterministic injection at a real seam inside the snapshot/stash
  // window, after snapshotFlowState has run (no spy needed). The error
  // return must leave flow.json byte-identical and remove the snapshot root
  // (a retained root would be destroyed by the next run's stale-root
  // rmSync). Honest note: the pathspec exclusion does not keep untracked
  // sdd files out of the stash, so when the consolidated guard's pop
  // succeeds it incidentally restores flow.json too; pre-fix this test
  // fails on the retained guard root, which is the regression fixed here.
  const { root, remote } = repoOnMain({ withDevelop: true });
  try {
    git(root, ["branch", "bugfix"]);
    const flowPath = path.join(root, "docs", "hardening", "sdd", "flow.json");
    mkdirSync(path.dirname(flowPath), { recursive: true });
    const flowBytes = Buffer.from('{"status":"approved"}\n');
    writeFileSync(flowPath, flowBytes);
    const hookPath = path.join(root, ".git", "hooks", "post-checkout");
    writeFileSync(hookPath, `#!/bin/sh\nrm -rf '${flowPath}'\n`);
    chmodSync(hookPath, 0o755);
    dirtyTree(root);
    const raw = await createRepoTools().workit_branch_setup.execute(
      {
        confirmed: true,
        target_branch: "bugfix/x",
        stash: "yes",
      },
      { directory: root, worktree: root } as never,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(false);
    // Consolidated guard still pops the stash back before restoring.
    expect(git(root, ["stash", "list"]).stdout.trim()).toBe("");
    expect(readFileSync(flowPath)).toEqual(flowBytes);
    const expectedRoot = path.join(
      os.tmpdir(),
      `workit-flow-guard-${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16)}`,
    );
    expect(existsSync(expectedRoot)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("failed best-effort stash pop points at the stash in the error", async () => {
  // Diverge develop's README so the stashed README edit conflicts on pop;
  // combined with an unwritable manifest dir this reaches the restore path
  // where the pop itself fails — the error must say where the work lives.
  const { root, remote } = repoOnMain({ withDevelop: true });
  try {
    git(root, ["checkout", "-q", "develop"]);
    writeFileSync(path.join(root, "README.md"), "develop version\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-q", "-m", "diverge"]);
    git(root, ["checkout", "-q", "main"]);
    mkdirSync(path.join(root, "docs"), { recursive: true });
    chmodSync(path.join(root, "docs"), 0o500);
    dirtyTree(root);
    const raw = await createRepoTools().workit_branch_setup.execute(
      {
        confirmed: true,
        target_branch: "bugfix/x",
        stash: "yes",
      },
      { directory: root, worktree: root } as never,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("manifest update failed");
    expect(String(result.error)).toContain("changes preserved in stash");
    expect(git(root, ["stash", "list"]).stdout.trim()).not.toBe("");
    // Pop conflicts (README diverged): work stays in the stash, target tree
    // keeps its own content under conflict markers.
    expect(readFileSync(path.join(root, "README.md"), "utf8")).toContain("develop version");
  } finally {
    chmodSync(path.join(root, "docs"), 0o700);
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});
