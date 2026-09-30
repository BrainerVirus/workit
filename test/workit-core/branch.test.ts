import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { branchSetup } from "@/packages/workit-core/src/core/branch";
import { resolveExternalActionRequest } from "@/packages/workit-core/src/core/external-action-effects";
import { externalActionDescriptor } from "@/packages/workit-core/src/core/external-action";
import { actionProposalQuestion } from "@/packages/workit-core/src/core/external-action-effects";
import { externalActionRequest } from "@/packages/workit-core/src/core/external-action";

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
  "setup without target_branch fails preflight and creates nothing",
  () => {
    const { root, remote } = repoOnMain({ withDevelop: true });
    try {
      const result = branchSetup({ workspace_root: root, sdd_dir: "docs/sdd" });
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.phase).toBe("preflight");
      expect(result.error).toContain("target_branch");
      expect(existsSync(path.join(root, "docs"))).toBe(false);
      expect(git(root, ["branch", "--show-current"]).stdout.trim()).toBe("main");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "dirty preflight rejection leaves HEAD, stash, and manifest untouched",
  () => {
    const { root, remote } = repoOnMain({ withDevelop: true });
    try {
      git(root, ["branch", "feature/exists"]);
      dirtyTree(root);
      const before = git(root, ["rev-parse", "HEAD"]).stdout.trim();
      const result = branchSetup({
        target_branch: "feature/exists",
        stash: "no",
        workspace_root: root,
        sdd_dir: "docs/sdd",
      });
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.phase).toBe("preflight");
      expect(result.error).toContain("dirty working tree");
      expect(existsSync(path.join(root, "docs"))).toBe(false);
      expect(git(root, ["rev-parse", "HEAD"]).stdout.trim()).toBe(before);
      expect(git(root, ["stash", "list"]).stdout.trim()).toBe("");
      expect(git(root, ["branch", "--show-current"]).stdout.trim()).toBe("main");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "branch setup resolution requires the working branch and binds its base baseline",
  () => {
    const { root, remote } = repoOnMain({ withDevelop: true });
    try {
      git(root, ["checkout", "-q", "-b", "develop", "origin/develop"]);
      writeFileSync(path.join(root, "local-base.txt"), "local base\n");
      git(root, ["add", "local-base.txt"]);
      git(root, ["commit", "-qm", "local base"]);
      const localBase = git(root, ["rev-parse", "HEAD"]).stdout.trim();
      git(root, ["checkout", "-q", "main"]);
      const missing = externalActionRequest({
        operation: "git.branch_setup",
        payload: { action: "setup" },
      });
      expect(missing.ok).toBe(true);
      if (!missing.ok) return;
      const unresolved = resolveExternalActionRequest(root, missing.data);
      expect(unresolved.ok).toBe(false);
      if (!unresolved.ok) {
        expect(unresolved.code).toBe("invalid_input");
        expect((unresolved.details as { outcome?: string } | undefined)?.outcome).toBe(
          "not_started",
        );
      }
      const request = externalActionRequest({
        operation: "git.branch_setup",
        payload: { action: "setup", target_branch: "feature/delta" },
      });
      expect(request.ok).toBe(true);
      if (!request.ok) return;
      const resolved = resolveExternalActionRequest(root, request.data);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        const payload = resolved.data.descriptorPayload as {
          resolved?: Record<string, unknown>;
        };
        expect(payload.resolved?.base_branch).toBe("develop");
        expect(payload.resolved?.target_exists).toBe(false);
        expect(payload.resolved?.local_base).toBe(localBase);
        const remoteBase = String(payload.resolved?.remote_base);
        expect(remoteBase).toMatch(/^[0-9a-f]{40}$/);
        expect(payload.resolved?.dirty).toBe(false);
        const proposal = actionProposalQuestion(
          resolved.data.request,
          resolved.data.descriptorPayload,
        );
        expect(proposal.presented).toContain(remoteBase.slice(0, 8));
        expect(proposal.presented).toContain(localBase.slice(0, 8));
      }
      const reapply = externalActionRequest({
        operation: "git.branch_setup",
        payload: { action: "reapply_stash" },
      });
      expect(reapply.ok).toBe(true);
      if (!reapply.ok) return;
      const resolvedReapply = resolveExternalActionRequest(root, reapply.data);
      expect(resolvedReapply.ok).toBe(true);
      if (resolvedReapply.ok) {
        const question = actionProposalQuestion(
          resolvedReapply.data.request,
          resolvedReapply.data.descriptorPayload,
        );
        expect(question.presented).toContain("Reapply the pre-checkout stash");
        expect(question.presented).not.toContain("Create branch");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test("branch setup binds the remote base so a remote advance changes the descriptor", () => {
  const { root, remote } = repoOnMain({ withDevelop: true });
  try {
    const request = externalActionRequest({
      operation: "git.branch_setup",
      payload: { action: "setup", target_branch: "feature/delta" },
    });
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    const before = resolveExternalActionRequest(root, request.data);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const descriptorBefore = externalActionDescriptor(
      before.data.request.operation,
      before.data.descriptorPayload,
    );
    git(root, ["fetch", "-q", "origin", "develop:develop"]);
    git(root, ["checkout", "-q", "develop"]);
    writeFileSync(path.join(root, "advance.txt"), "advance\n");
    git(root, ["add", "advance.txt"]);
    git(root, ["commit", "-qm", "advance"]);
    git(root, ["push", "-q", "origin", "develop"]);
    git(root, ["checkout", "-q", "main"]);
    const after = resolveExternalActionRequest(root, request.data);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const descriptorAfter = externalActionDescriptor(
      after.data.request.operation,
      after.data.descriptorPayload,
    );
    expect(descriptorAfter).not.toBe(descriptorBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("branch setup refuses a fetched base newer than the approved remote SHA", () => {
  const { root, remote } = repoOnMain({ withDevelop: true });
  try {
    const approvedBase = git(root, ["rev-parse", "refs/remotes/origin/develop"]).stdout.trim();
    git(root, ["checkout", "-q", "-b", "develop", "origin/develop"]);
    writeFileSync(path.join(root, "advance.txt"), "advance\n");
    git(root, ["add", "advance.txt"]);
    git(root, ["commit", "-qm", "advance develop"]);
    git(root, ["push", "-q", "origin", "develop"]);
    git(root, ["update-ref", "-d", "refs/remotes/origin/develop"]);
    git(root, ["checkout", "-q", "main"]);

    const result = branchSetup({
      target_branch: "feature/pinned-base",
      workspace_root: root,
      expected_remote_base: approvedBase,
    });
    expect(result).toMatchObject({
      error: expect.stringContaining("approved remote base changed"),
      phase: "preflight",
    });
    expect(git(root, ["branch", "--show-current"]).stdout.trim()).toBe("main");
    expect(git(root, ["show-ref", "--verify", "refs/heads/feature/pinned-base"]).status).not.toBe(
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});
