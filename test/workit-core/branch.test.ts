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
import {
  restoreFlowSnapshot,
  snapshotFlowState,
  branchSetup,
} from "../../packages/workit-core/src/core/branch";
import { readEffectiveFlowState } from "../../packages/workit-core/src/core/flow-state";

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
  // Preserve written bytes verbatim on all platforms: CI Windows runners set
  // core.autocrlf=true globally, which would rewrite LF fixtures to CRLF.
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["config", "core.safecrlf", "false"]);
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

// Shared flow-guard journal fixture: repo with develop on origin, sdd ignored
// so flow.json survives the stash window as an untracked-ignored file.
const journalRepo = () => {
  const { root, remote } = repoOnMain({ withDevelop: true });
  writeFileSync(path.join(root, ".gitignore"), "docs/*/sdd/\n");
  git(root, ["add", ".gitignore"]);
  git(root, ["commit", "-q", "-m", "ignore sdd runtime state"]);
  const flowPath = path.join(root, "docs", "hardening", "sdd", "flow.json");
  mkdirSync(path.dirname(flowPath), { recursive: true });
  const flowBytes = Buffer.from('{"status":"approved"}\n');
  writeFileSync(flowPath, flowBytes);
  return { root, remote, flowPath, flowBytes };
};

test("failed base resolution fails before any stash and leaves tree intact", async () => {
  // CA-02 regression: origin lacks develop, so origin/base validation must
  // fail BEFORE any mutation — no snapshot, no stash push, no checkout.
  // The tree ends up exactly as it was left, with no stranded stash entry.
  // Honest note: since the consolidated-guard fix these final-state
  // assertions also passed via pop-back restoration; the pre-stash split
  // removes the transient stash/snapshot window itself.
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
    // Stash pop rewrites the file via git; tolerate CRLF checkout.
    expect(readFileSync(path.join(root, "README.md"), "utf8").replace(/\r\n/g, "\n")).toBe(
      "wip change\n",
    );
    expect(existsSync(path.join(root, "notes.md"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("manifest write failure after checkout restores stash and returns to previous branch", async () => {
  // Regression: a throw in the post-checkout manifest section stranded the
  // stash — the error path must pop it back before returning. The setup must
  // also not leave HEAD on the half-created target: after the pop succeeds,
  // checkout returns to the originating branch (best-effort).
  // Skipped on win32: dir mode bits are not enforced on Windows, so the
  // chmod-0500 EACCES injection never fires there. Still runs on ubuntu/macos.
  if (process.platform === "win32") return; // chmod is not advisory on win32
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
    expect(git(root, ["branch", "--show-current"]).stdout.trim()).toBe("main");
    expect(readFileSync(path.join(root, "README.md"), "utf8").replace(/\r\n/g, "\n")).toBe(
      "wip change\n",
    );
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
  if (process.platform === "win32") return; // dir mode bits are not enforced on Windows
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wf-flow-retain-"));
  mkdirSync(path.join(cwd, "docs", "alpha", "sdd"), { recursive: true });
  writeFileSync(path.join(cwd, "docs", "alpha", "sdd", "flow.json"), '{"rev":1}\n');
  const snap = snapshotFlowState(cwd);
  try {
    rmSync(path.join(cwd, "docs", "alpha", "sdd"), { recursive: true, force: true });
    chmodSync(path.join(cwd, "docs", "alpha"), 0o500);

    expect(restoreFlowSnapshot(snap, cwd).warning).toContain("flow state snapshot restore failed");
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
  // Skipped on win32: dir mode bits are not enforced on Windows, so the
  // chmod-0500 EACCES injection never fires there. Still runs on ubuntu/macos.
  if (process.platform === "win32") return; // chmod is not advisory on win32
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
    // keeps its own content under conflict markers. Pop rewrites via git;
    // tolerate CRLF checkout.
    expect(readFileSync(path.join(root, "README.md"), "utf8").replace(/\r\n/g, "\n")).toContain(
      "develop version",
    );
  } finally {
    chmodSync(path.join(root, "docs"), 0o700);
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("CA-01: journal emits ordered checkpoints when a logger is injected", async () => {
  const { root, remote, flowBytes } = journalRepo();
  const lines: string[] = [];
  try {
    dirtyTree(root);
    const result = branchSetup({
      target_branch: "bugfix/journal",
      stash: "yes",
      workspace_root: root,
      log: (m) => lines.push(m),
    });
    expect((result as { ok?: boolean }).ok).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.startsWith("flow-guard: ")).toBe(true);
    const indexOf = (needle: string) => lines.findIndex((l) => l.includes(needle));
    const entry = indexOf("entry:");
    const snapshot = indexOf("snapshot:");
    const push = indexOf("stash push:");
    const postCreate = indexOf("post-create:");
    const restore = indexOf("restore:");
    for (const idx of [entry, snapshot, push, postCreate, restore])
      expect(idx).toBeGreaterThanOrEqual(0);
    // Ordered checkpoints bracket the whole mutation window.
    expect(snapshot).toBeGreaterThan(entry);
    expect(push).toBeGreaterThan(snapshot);
    expect(postCreate).toBeGreaterThan(push);
    expect(restore).toBeGreaterThan(postCreate);
    // Per-file short hash at capture time.
    expect(
      lines.some((l) =>
        /^flow-guard: snapshot: docs\/hardening\/sdd\/flow\.json sha=[0-9a-f]{8}$/.test(l),
      ),
    ).toBe(true);
    expect(lines.some((l) => l.includes("post-create: docs/hardening/sdd/flow.json present"))).toBe(
      true,
    );
    // Nothing was wiped mid-window: the one captured file was skipped by restore.
    expect(lines[restore]).toContain("restored=0");
    expect(lines[restore]).toContain("skipped=1");
    expect(readFileSync(path.join(root, "docs", "hardening", "sdd", "flow.json"))).toEqual(
      flowBytes,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("CA-03: mid-window deletion is pinpointable between two adjacent checkpoints", () => {
  // Reuses the post-checkout hook deletion pattern: the hook wipes flow.json
  // during checkout of the existing target. The journal must show the bytes
  // were captured (sha line) BEFORE a presence re-stat reports MISSING, and
  // the following restore checkpoint must report restored=1 — adjacent
  // checkpoints pinpoint exactly where the wipe happened.
  const { root, remote, flowPath, flowBytes } = journalRepo();
  git(root, ["branch", "bugfix/pin"]);
  const lines: string[] = [];
  try {
    const hookPath = path.join(root, ".git", "hooks", "post-checkout");
    writeFileSync(hookPath, `#!/bin/sh\nrm -rf '${flowPath}'\n`);
    chmodSync(hookPath, 0o755);
    dirtyTree(root);
    const result = branchSetup({
      target_branch: "bugfix/pin",
      stash: "yes",
      workspace_root: root,
      log: (m) => lines.push(m),
    });
    expect((result as { ok?: boolean }).ok).toBe(true);
    const shaIdx = lines.findIndex((l) => l.includes("snapshot:") && l.includes("sha="));
    const missingIdx = lines.findIndex(
      (l) => l.includes("post-checkout:") && l.includes("MISSING"),
    );
    expect(shaIdx).toBeGreaterThan(-1); // present-before: bytes captured
    expect(missingIdx).toBeGreaterThan(shaIdx); // missing-after: deleted in between
    const restoreIdx = lines.findIndex((l, i) => i > missingIdx && l.includes("restore:"));
    expect(restoreIdx).toBeGreaterThan(missingIdx);
    expect(lines[restoreIdx]).toContain("restored=1");
    expect(readFileSync(flowPath)).toEqual(flowBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("absent logger preserves today's exact return values and side effects", async () => {
  const a = journalRepo();
  const b = journalRepo();
  const lines: string[] = [];
  try {
    dirtyTree(a.root);
    dirtyTree(b.root);
    const withLog = branchSetup({
      target_branch: "bugfix/twin",
      stash: "yes",
      workspace_root: a.root,
      log: (m) => lines.push(m),
    });
    const withoutLog = branchSetup({
      target_branch: "bugfix/twin",
      stash: "yes",
      workspace_root: b.root,
    });
    // Identical results modulo per-repo absolute path and wall-clock stamp.
    const strip = (r: unknown) => {
      const copy = { ...(r as Record<string, unknown>) };
      delete copy.manifest;
      delete copy.stash_created_at;
      return copy;
    };
    expect(strip(withLog)).toEqual(strip(withoutLog));
    for (const line of lines) expect(line.startsWith("flow-guard: ")).toBe(true);
    // Absent-logger side effects match today's contract.
    expect(git(b.root, ["branch", "--show-current"]).stdout.trim()).toBe("bugfix/twin");
    expect(git(b.root, ["stash", "list"]).stdout.split("\n").filter(Boolean).length).toBe(1);
    expect(readFileSync(path.join(b.root, "docs", "hardening", "sdd", "flow.json"))).toEqual(
      b.flowBytes,
    );
    const expectedRoot = path.join(
      os.tmpdir(),
      `workit-flow-guard-${createHash("sha256").update(path.resolve(b.root)).digest("hex").slice(0, 16)}`,
    );
    expect(existsSync(expectedRoot)).toBe(false);
  } finally {
    rmSync(a.root, { recursive: true, force: true });
    rmSync(a.remote, { recursive: true, force: true });
    rmSync(b.root, { recursive: true, force: true });
    rmSync(b.remote, { recursive: true, force: true });
  }
});

test("snapshot captures docs/<slug>/spec.md and plan.md beside flow.json", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wf-doc-snap-"));
  let snap: string | undefined;
  try {
    const flow = Buffer.from('{"status":"approved"}\n');
    const alphaSpec = Buffer.from("# alpha spec\n");
    const alphaPlan = Buffer.from("# alpha plan\n");
    const betaSpec = Buffer.from("# beta spec\n");
    mkdirSync(path.join(cwd, "docs", "alpha", "sdd"), { recursive: true });
    mkdirSync(path.join(cwd, "docs", "beta"), { recursive: true });
    writeFileSync(path.join(cwd, "docs", "alpha", "sdd", "flow.json"), flow);
    writeFileSync(path.join(cwd, "docs", "alpha", "spec.md"), alphaSpec);
    writeFileSync(path.join(cwd, "docs", "alpha", "plan.md"), alphaPlan);
    writeFileSync(path.join(cwd, "docs", "alpha", "notes.md"), "not gated\n");
    writeFileSync(path.join(cwd, "docs", "beta", "spec.md"), betaSpec);

    snap = snapshotFlowState(cwd);

    const walk = (from: string, rel: string): string[] =>
      readdirSync(from, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(path.join(from, entry.name), path.join(rel, entry.name))
          : [path.join(rel, entry.name)],
      );
    expect(walk(snap, "").sort()).toEqual([
      "docs/alpha/plan.md",
      "docs/alpha/sdd/flow.json",
      "docs/alpha/spec.md",
      "docs/beta/spec.md",
    ]);
    expect(readFileSync(path.join(snap, "docs", "alpha", "sdd", "flow.json"))).toEqual(flow);
    expect(readFileSync(path.join(snap, "docs", "alpha", "spec.md"))).toEqual(alphaSpec);
    expect(readFileSync(path.join(snap, "docs", "alpha", "plan.md"))).toEqual(alphaPlan);
    expect(readFileSync(path.join(snap, "docs", "beta", "spec.md"))).toEqual(betaSpec);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    if (snap) rmSync(snap, { recursive: true, force: true });
  }
});

test("incident regression: untracked approved spec/plan survive setup(stash=yes) and a following read does not reset", async () => {
  // THE INCIDENT: setup(stash=yes) strands untracked docs/<slug>/spec.md and
  // plan.md inside the recorded stash (the ':!docs/*/sdd' pathspec only
  // protects flow.json). Any subsequent readEffectiveFlowState — a mere
  // status/gate read — saw spec missing, classified document_missing drift,
  // and PERSISTED a full approval-chain wipe into flow.json. The guard now
  // snapshots the doc pair too, so restore-if-missing puts them back before
  // the next read. Honest note on shape: a read invoked literally mid-window
  // (between stash push and the closing restore) would still observe the
  // stashed-away pair, because restore-if-missing runs only at window close;
  // this fix makes the stranded-after-setup window — where production reads
  // actually happened — safe. So the incident is reproduced at the seam right
  // after setup returns, plus a unit test above proving the snapshot captures
  // the pair.
  const { root, remote } = repoOnMain({ withDevelop: true });
  const guardsBefore = new Set(
    readdirSync(os.tmpdir()).filter((d) => d.startsWith("workit-flow-guard-")),
  );
  try {
    writeFileSync(path.join(root, ".gitignore"), "docs/*/sdd/\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-q", "-m", "ignore sdd runtime state"]);

    const slug = "hardening";
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const specBytes = Buffer.from("# spec\n\n**Branch:** bugfix/hardening\n");
    const planBytes = Buffer.from("# plan\n\n**Branch:** bugfix/hardening\n");
    const flowBytes = Buffer.from(
      JSON.stringify(
        {
          slug,
          activated: true,
          spec: {
            path: `docs/${slug}/spec.md`,
            status: "approved",
            evidence: null,
            approved_digest: digest(specBytes),
          },
          plan: {
            path: `docs/${slug}/plan.md`,
            status: "approved",
            evidence: null,
            approved_digest: digest(planBytes),
          },
          menu: { presented: false, chosen: "", evidence: null },
          execution: {
            status: "pending",
            mode: null,
            evidence: null,
            coordinator_session_id: null,
          },
          handoff_destination: false,
          updated_at: 1700000000000,
        },
        null,
        2,
      ) + "\n",
    );
    const specPath = path.join(root, "docs", slug, "spec.md");
    const planPath = path.join(root, "docs", slug, "plan.md");
    const flowPath = path.join(root, "docs", slug, "sdd", "flow.json");
    mkdirSync(path.dirname(flowPath), { recursive: true });
    writeFileSync(flowPath, flowBytes);
    writeFileSync(specPath, specBytes);
    writeFileSync(planPath, planBytes);
    // No dirtyTree helper here on purpose: the stash must hold ONLY the doc
    // pair so the guard's restore fully covers it and setup drops the
    // redundant stash (mixed WIP keeps the stash — partial overlap must stay
    // reappliable).

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
    // Round-1 fallout fix: the stash held the same doc pair the guard just
    // restored, so every successful setup stranded a stash_ref whose later
    // reapply_stash pop refused ("untracked working tree files would be
    // overwritten"). Full coverage ⇒ setup drops the stash itself.
    expect(result.data.stash_ref).toBeNull();

    // The very next gate/status read (the concurrent reader from the incident)
    // must not phantom-reset the approval chain.
    const read = readEffectiveFlowState(root, slug);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.state.spec.status).toBe("approved");
      expect(read.state.plan.status).toBe("approved");
      expect(read.drift).toEqual([]);
    }

    // All three files survived byte-identical; no guard root remains.
    expect(readFileSync(flowPath)).toEqual(flowBytes);
    expect(readFileSync(specPath)).toEqual(specBytes);
    expect(readFileSync(planPath)).toEqual(planBytes);
    const expectedRoot = path.join(
      os.tmpdir(),
      `workit-flow-guard-${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16)}`,
    );
    expect(existsSync(expectedRoot)).toBe(false);
    const newGuards = readdirSync(os.tmpdir())
      .filter((d) => d.startsWith("workit-flow-guard-"))
      .filter((d) => !guardsBefore.has(d));
    expect(newGuards).toEqual([]);

    // No stranded stash: the ref is gone from the stash and the manifest.
    expect(git(root, ["stash", "list"]).stdout.trim()).toBe("");
    const manifest = JSON.parse(readFileSync(path.join(root, "docs", "manifest.json"), "utf8"));
    expect(manifest.stash_ref).toBeUndefined();
    expect(manifest.stash_created_at).toBeUndefined();

    // A subsequent reapply_stash is a harmless structured error, not a
    // conflicting pop.
    const reapplyRaw = await createRepoTools().workit_branch_setup.execute(
      { confirmed: true, action: "reapply_stash" },
      { directory: root, worktree: root } as never,
    );
    const reapply = JSON.parse(reapplyRaw as string);
    expect(reapply.ok).toBe(false);
    expect(String(reapply.error)).toContain("no stash_ref");

    // Harmless: all three files still byte-identical after the refused reapply.
    expect(readFileSync(flowPath)).toEqual(flowBytes);
    expect(readFileSync(specPath)).toEqual(specBytes);
    expect(readFileSync(planPath)).toEqual(planBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("tracked-modified spec.md keeps the stash: present-at-restore is not covered", () => {
  // Round-2 finding: restore-if-missing SKIPS files already present. A
  // tracked-and-modified spec.md survives the stash push (reverted to HEAD
  // bytes, file stays), so at restore time it is present → skipped → never
  // actually restored. Counting every snapshot entry as covered made setup
  // drop a stash that was the only copy of the user's uncommitted edit.
  const { root, remote } = repoOnMain({ withDevelop: true });
  const lines: string[] = [];
  try {
    writeFileSync(path.join(root, ".gitignore"), "docs/*/sdd/\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-q", "-m", "ignore sdd runtime state"]);

    const slug = "hardening";
    const specPath = path.join(root, "docs", slug, "spec.md");
    // Track spec.md on main AND develop so it stays present across checkout.
    mkdirSync(path.dirname(specPath), { recursive: true });
    writeFileSync(specPath, "# spec\n\nv1\n");
    git(root, ["add", "docs"]);
    git(root, ["commit", "-q", "-m", "spec"]);
    git(root, ["push", "-q", "origin", "main:develop"]);
    // TRACKED modification after commit: the stash push takes this edit and
    // reverts the file to v1 in the working tree.
    const modifiedBytes = Buffer.from("# spec WIP\n\nv2\n");
    writeFileSync(specPath, modifiedBytes);

    const result = branchSetup({
      target_branch: `bugfix/${slug}`,
      stash: "yes",
      workspace_root: root,
      log: (m) => lines.push(m),
    });
    expect((result as { ok?: boolean }).ok).toBe(true);
    // The stash holds the ONLY copy of the modification; the guard skipped
    // spec.md at restore time (present), so coverage must NOT hold.
    expect((result as { stash_ref?: string | null }).stash_ref).not.toBeNull();
    expect(git(root, ["stash", "list"]).stdout.trim()).not.toBe("");
    expect(lines.join("\n")).toContain("kept stash ref");
    expect(lines.join("\n")).not.toContain("dropped redundant stash");

    // reapply_stash restores the user's modification intact.
    const manifestBefore = JSON.parse(
      readFileSync(path.join(root, "docs", "manifest.json"), "utf8"),
    );
    expect(manifestBefore.stash_ref).not.toBeUndefined();
    const reapply = branchSetup({ action: "reapply_stash", workspace_root: root });
    expect((reapply as { ok?: boolean }).ok).toBe(true);
    expect(readFileSync(specPath)).toEqual(modifiedBytes);
    expect(git(root, ["stash", "list"]).stdout.trim()).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});
