import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRepoTools } from "@/packages/workit-opencode/src/tools/repo";
import { branchSetup } from "@/packages/workit-core/src/core/branch";

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

const seedReadOnlySddDir = (root: string) => {
  const sddDir = path.join(root, "docs", "sdd");
  const seedOn = (branch: string) => {
    git(root, ["checkout", "-q", branch]);
    mkdirSync(sddDir, { recursive: true });
    writeFileSync(path.join(sddDir, ".gitkeep"), "keep\n");
    git(root, ["add", "docs/sdd/.gitkeep"]);
    git(root, ["commit", "-q", "-m", "seed sdd dir"]);
  };
  git(root, ["fetch", "origin", "develop:develop"]);
  seedOn("develop");
  git(root, ["push", "-q", "origin", "develop"]);
  seedOn("main");
  git(root, ["push", "-q", "origin", "main"]);
  chmodSync(sddDir, 0o555);
};

// Shared branch-setup journal fixture: repo with develop on origin.
const journalRepo = () => repoOnMain({ withDevelop: true });

test(
  "CA-01: journal emits ordered checkpoints when a logger is injected",
  async () => {
    const { root, remote } = journalRepo();
    git(root, ["branch", "bugfix/journal"]);
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
      for (const line of lines) expect(line.startsWith("branch-setup: ")).toBe(true);
      const indexOf = (needle: string) => lines.findIndex((l) => l.includes(needle));
      const entry = indexOf("entry:");
      const push = indexOf("stash push:");
      const postCheckout = indexOf("post-checkout");
      for (const idx of [entry, push, postCheckout]) expect(idx).toBeGreaterThanOrEqual(0);
      expect(push).toBeGreaterThan(entry);
      expect(postCheckout).toBeGreaterThan(push);
    } finally {
      const sddDir = path.join(root, "docs", "sdd");
      if (existsSync(sddDir)) chmodSync(sddDir, 0o755);
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "CA-03: journal checkpoints bracket checkout on an existing branch",
  () => {
    const { root, remote } = journalRepo();
    git(root, ["branch", "bugfix/pin"]);
    const lines: string[] = [];
    try {
      dirtyTree(root);
      const result = branchSetup({
        target_branch: "bugfix/pin",
        stash: "yes",
        workspace_root: root,
        log: (m) => lines.push(m),
      });
      expect((result as { ok?: boolean }).ok).toBe(true);
      const push = lines.findIndex((l) => l.includes("stash push:"));
      const checkout = lines.findIndex((l) => l.includes("post-checkout"));
      expect(push).toBeGreaterThan(-1);
      expect(checkout).toBeGreaterThan(push);
    } finally {
      const sddDir = path.join(root, "docs", "sdd");
      if (existsSync(sddDir)) chmodSync(sddDir, 0o755);
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "failed base resolution fails before any stash and leaves tree intact",
  async () => {
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
      const sddDir = path.join(root, "docs", "sdd");
      if (existsSync(sddDir)) chmodSync(sddDir, 0o755);
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "policy/base resolution runs before any stash push",
  async () => {
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
      const sddDir = path.join(root, "docs", "sdd");
      if (existsSync(sddDir)) chmodSync(sddDir, 0o755);
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "manifest write failure after checkout restores stash and returns to previous branch",
  async () => {
    // Regression: a throw in the post-checkout manifest section stranded the
    // stash — the error path must pop it back before returning. The setup must
    // also not leave HEAD on the half-created target: after the pop succeeds,
    // checkout returns to the originating branch (best-effort).
    // Skipped on win32: dir mode bits are not enforced on Windows, so the
    // chmod-0500 EACCES injection never fires there. Still runs on ubuntu/macos.
    if (process.platform === "win32") return; // chmod is not advisory on win32
    const { root, remote } = repoOnMain({ withDevelop: true });
    try {
      seedReadOnlySddDir(root);
      dirtyTree(root);
      const raw = await createRepoTools().workit_branch_setup.execute(
        {
          confirmed: true,
          target_branch: "bugfix/x",
          stash: "yes",
          sdd_dir: "docs/sdd",
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
      const sddDir = path.join(root, "docs", "sdd");
      if (existsSync(sddDir)) chmodSync(sddDir, 0o755);
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "failed best-effort stash pop points at the stash in the error",
  async () => {
    // Diverge develop's README so the stashed README edit conflicts on pop;
    // combined with an unwritable manifest dir this reaches the restore path
    // where the pop itself fails — the error must say where the work lives.
    // Skipped on win32: dir mode bits are not enforced on Windows, so the
    // chmod-0500 EACCES injection never fires there. Still runs on ubuntu/macos.
    if (process.platform === "win32") return; // chmod is not advisory on win32
    const { root, remote } = repoOnMain({ withDevelop: true });
    try {
      seedReadOnlySddDir(root);
      git(root, ["checkout", "-q", "develop"]);
      writeFileSync(path.join(root, "README.md"), "develop version\n");
      git(root, ["add", "README.md"]);
      git(root, ["commit", "-q", "-m", "diverge"]);
      git(root, ["checkout", "-q", "main"]);
      chmodSync(path.join(root, "docs", "sdd"), 0o555);
      dirtyTree(root);
      const raw = await createRepoTools().workit_branch_setup.execute(
        {
          confirmed: true,
          target_branch: "bugfix/x",
          stash: "yes",
          sdd_dir: "docs/sdd",
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
      const sddDir = path.join(root, "docs", "sdd");
      if (existsSync(sddDir)) chmodSync(sddDir, 0o755);
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);
