import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deriveForge,
  forgeConflict,
  headSha,
  mergeBase,
  parseRemoteUrl,
  patchId,
  pushForge,
  pushRemoteName,
  readSshConfig,
  remoteTip,
  resolveSshHost,
  worktreeTree,
} from "@/packages/workit-core/src/git/rev";

// S9a core/git/rev (design §2.0, §2.2; D16): code-state keys for evidence and
// verdicts, and forge derivation from the push remote host.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const repo = (): string => {
  const root = tmp("wk-rev-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
  return root;
};

const commit = (root: string, file: string, content: string, message: string): string => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
  git(root, "add", "--", file);
  git(root, "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
};

const refs = (root: string): string =>
  git(root, "for-each-ref", "--format=%(refname) %(objectname)");

test("given a dirty worktree, worktreeTree changes when a file changes and HEAD and the refs stay untouched", () => {
  const root = repo();
  commit(root, ".gitignore", "ignored.log\n", "ignore");
  commit(root, "src/a.ts", "export const a = 1;\n", "base");
  const head = headSha(root);
  expect(head).toBe(git(root, "rev-parse", "HEAD"));

  const clean = worktreeTree(root);
  expect(clean).toEqual({ tree: git(root, "rev-parse", "HEAD^{tree}"), dirty: false });

  const indexPath = path.join(root, ".git", "index");
  const indexBefore = readFileSync(indexPath);
  const refsBefore = refs(root);

  writeFileSync(path.join(root, "src/a.ts"), "export const a = 2;\n");
  const edited = worktreeTree(root)!;
  expect(edited.dirty).toBe(true);
  expect(edited.tree).not.toBe(clean!.tree);

  writeFileSync(path.join(root, "src/new.ts"), "export {};\n");
  const untracked = worktreeTree(root)!;
  expect(untracked.tree).not.toBe(edited.tree);

  writeFileSync(path.join(root, "ignored.log"), "noise\n");
  expect(worktreeTree(root)!.tree).toBe(untracked.tree);

  // Same content, same tree: the key is content-addressed, not time-based.
  expect(worktreeTree(root)!.tree).toBe(untracked.tree);

  expect(headSha(root)).toBe(head);
  expect(refs(root)).toBe(refsBefore);
  expect(readFileSync(indexPath).equals(indexBefore)).toBe(true);
  expect(git(root, "diff", "--cached", "--name-only")).toBe("");
});

test("worktreeTree and headSha handle an unborn branch", () => {
  const root = repo();
  expect(headSha(root)).toBeNull();
  expect(worktreeTree(root)!.dirty).toBe(false);
  writeFileSync(path.join(root, "a.txt"), "a\n");
  expect(worktreeTree(root)!.dirty).toBe(true);
  expect(headSha(tmp("wk-rev-nogit-"))).toBeNull();
});

test("given a rebase that changes only the base, patchId is equal", () => {
  const root = repo();
  commit(root, "a.txt", "a\n", "base");
  git(root, "checkout", "-qb", "feature/x");
  commit(root, "feature.txt", "feature\n", "feature work");
  const before = patchId(root, "main", "feature/x");
  const headBefore = headSha(root);
  expect(before).toMatch(/^[0-9a-f]{40,64}$/u);

  git(root, "checkout", "-q", "main");
  commit(root, "other.txt", "unrelated\n", "trunk moves");
  git(root, "checkout", "-q", "feature/x");
  git(root, "rebase", "-q", "main");

  expect(headSha(root)).not.toBe(headBefore);
  expect(patchId(root, "main", "feature/x")).toBe(before);
  expect(mergeBase(root, "main", "feature/x")).toBe(git(root, "rev-parse", "main"));

  // A content change is a different patch.
  commit(root, "feature.txt", "feature v2\n", "change the change");
  expect(patchId(root, "main", "feature/x")).not.toBe(before);

  // Empty range and option-shaped revisions resolve to null.
  expect(patchId(root, "feature/x", "feature/x")).toBeNull();
  expect(patchId(root, "--output=x", "feature/x")).toBeNull();
});

test("remoteTip reads the remote branch and pushRemoteName follows git's precedence", () => {
  const bare = tmp("wk-rev-bare-");
  git(bare, "init", "-q", "--bare");
  const root = repo();
  const sha = commit(root, "a.txt", "a\n", "base");
  git(root, "remote", "add", "origin", bare);
  git(root, "push", "-q", "origin", "main");
  expect(remoteTip(root, "origin", "main")).toBe(sha);
  expect(remoteTip(root, "origin", "missing")).toBeNull();

  expect(pushRemoteName(root)).toBe("origin");
  git(root, "remote", "add", "fork", bare);
  git(root, "config", "branch.main.remote", "fork");
  expect(pushRemoteName(root)).toBe("fork");
  git(root, "config", "remote.pushDefault", "origin");
  expect(pushRemoteName(root)).toBe("origin");
  git(root, "config", "branch.main.pushRemote", "fork");
  expect(pushRemoteName(root)).toBe("fork");
  expect(pushRemoteName(repo())).toBeNull();
});

test("parseRemoteUrl handles scp-like, ssh://, https and local remotes", () => {
  expect(parseRemoteUrl("git@github.com:o/r.git")).toEqual({
    protocol: "ssh",
    user: "git",
    host: "github.com",
    port: null,
    path: "o/r",
  });
  expect(parseRemoteUrl("ssh://git@ssh.github.com:443/o/r.git")).toMatchObject({
    protocol: "ssh",
    host: "ssh.github.com",
    port: "443",
    path: "o/r",
  });
  expect(parseRemoteUrl("https://user:token@GitLab.com/g/sub/p.git/")).toEqual({
    protocol: "https",
    user: null,
    host: "gitlab.com",
    port: null,
    path: "g/sub/p",
  });
  expect(parseRemoteUrl("C:\\repos\\x")?.protocol).toBe("file");
  expect(parseRemoteUrl("/srv/git/x.git")?.protocol).toBe("file");
  expect(parseRemoteUrl("")).toBeNull();
});

const SSH_CONFIG = `
# personal default
Host github-work.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_work

Host gl-*  !gl-skip
  HostName %h.internal.example
  Port 2222

Match host something
  HostName never.example

Host *
  Port 22
  HostName ignored-because-first-wins-per-alias-only-if-unset
`;

test("resolveSshHost honors aliases, wildcards, negation, %h and first-value-wins", () => {
  expect(resolveSshHost("github-work.com", SSH_CONFIG)).toEqual({
    hostname: "github.com",
    port: "22",
  });
  expect(resolveSshHost("gl-corp", SSH_CONFIG)).toEqual({
    hostname: "gl-corp.internal.example",
    port: "2222",
  });
  expect(resolveSshHost("gl-skip", SSH_CONFIG).hostname).toBe(
    "ignored-because-first-wins-per-alias-only-if-unset",
  );
  expect(resolveSshHost("github.com", "")).toEqual({ hostname: "github.com", port: null });
});

test("readSshConfig expands Include relative to ~/.ssh", () => {
  const home = tmp("wk-rev-home-");
  mkdirSync(path.join(home, ".ssh", "conf.d"), { recursive: true });
  writeFileSync(
    path.join(home, ".ssh", "config"),
    "Include conf.d/*.conf\nHost x\n  HostName x.example\n",
  );
  writeFileSync(
    path.join(home, ".ssh", "conf.d", "work.conf"),
    "Host github-work.com\n  HostName github.com\n",
  );
  const text = readSshConfig(home);
  expect(resolveSshHost("github-work.com", text).hostname).toBe("github.com");
  expect(resolveSshHost("x", text).hostname).toBe("x.example");
  expect(readSshConfig(tmp("wk-rev-empty-"))).toBe("");
});

test("deriveForge: github-work.com style SSH alias resolves to GitHub at github.com", () => {
  expect(
    deriveForge("git@github-work.com:EnghouseGlobal/ui-kit.git", { sshConfig: SSH_CONFIG }),
  ).toEqual({
    kind: "github",
    host: "github-work.com",
    hostname: "github.com",
    apiHost: "github.com",
    repo: "EnghouseGlobal/ui-kit",
    via: "known_host",
  });
  // Without the alias mapping the host is not guessed from its name.
  expect(
    deriveForge("git@github-work.com:EnghouseGlobal/ui-kit.git", { sshConfig: "" }),
  ).toBeNull();
  // An HTTPS remote never goes through SSH aliases.
  expect(deriveForge("https://github-work.com/o/r.git", { sshConfig: SSH_CONFIG })).toBeNull();
});

test("deriveForge: GitLab public, subgroups, SSH-over-443 and self-hosted", () => {
  expect(deriveForge("git@gitlab.com:group/sub/project.git", { sshConfig: "" })).toMatchObject({
    kind: "gitlab",
    apiHost: "gitlab.com",
    repo: "group/sub/project",
  });
  expect(
    deriveForge("ssh://git@altssh.gitlab.com:443/group/project.git", { sshConfig: "" }),
  ).toMatchObject({ kind: "gitlab", apiHost: "gitlab.com", repo: "group/project" });
  expect(deriveForge("https://gitlab.example.com/team/app", { sshConfig: "" })).toMatchObject({
    kind: "gitlab",
    apiHost: "gitlab.example.com",
    via: "host_name",
  });
  expect(
    deriveForge("git@code.corp.example:team/app.git", {
      sshConfig: "",
      hosts: { gitlab: ["https://code.corp.example/"] },
    }),
  ).toMatchObject({ kind: "gitlab", apiHost: "code.corp.example", via: "configured_host" });
  expect(
    deriveForge("https://ghe.corp.example:8443/o/r.git", {
      sshConfig: "",
      hosts: { github: ["ghe.corp.example:8443"] },
    }),
  ).toMatchObject({ kind: "github", apiHost: "ghe.corp.example:8443" });
  expect(deriveForge("git@github.com:only-owner.git", { sshConfig: "" })).toBeNull();
  expect(deriveForge("/srv/git/x.git", { sshConfig: "" })).toBeNull();
});

test("pushForge derives the forge from the push remote, not the configured provider", () => {
  const root = repo();
  commit(root, "a.txt", "a\n", "base");
  expect(pushForge(root, { sshConfig: "" })).toMatchObject({ ok: false, code: "not_found" });

  git(root, "remote", "add", "origin", "git@gitlab.com:group/project.git");
  git(
    root,
    "remote",
    "set-url",
    "--push",
    "origin",
    "git@github-work.com:EnghouseGlobal/project.git",
  );
  const derived = pushForge(root, { sshConfig: SSH_CONFIG });
  expect(derived).toMatchObject({
    ok: true,
    remote: "origin",
    url: "git@github-work.com:EnghouseGlobal/project.git",
    forge: { kind: "github", apiHost: "github.com", repo: "EnghouseGlobal/project" },
  });

  const unknown = pushForge(root, { sshConfig: "" });
  expect(unknown).toMatchObject({ ok: false, code: "unavailable" });
  if (!unknown.ok) expect(unknown.unblock).toContain("Host github-work.com");

  // D16: a disagreeing workspace provider is blocked with the exact fix.
  if (!derived.ok) throw new Error("expected a forge");
  expect(forgeConflict(derived.forge, "github")).toBeNull();
  expect(forgeConflict(derived.forge, undefined)).toBeNull();
  const conflict = forgeConflict(derived.forge, "GitLab");
  expect(conflict?.code).toBe("blocked");
  expect(conflict?.unblock).toContain('vcs.provider to "github"');
});
