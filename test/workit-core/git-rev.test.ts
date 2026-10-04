import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deriveForge,
  forgeConflict,
  headSha,
  mergeBase,
  networkGitInvocation,
  parseRemoteUrl,
  patchId,
  pushForge,
  pushRemoteName,
  redactRemote,
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
  const headTree = git(root, "rev-parse", "HEAD^{tree}");
  expect(clean).toEqual({ tree: headTree, key: headTree, dirty: false, skipped: [] });

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
  expect(remoteTip(root, "origin", "main")).toEqual({ ok: true, sha });
  expect(remoteTip(root, "origin", "missing")).toEqual({ ok: true, sha: null });
  expect(remoteTip(root, "--upload-pack=x", "main")).toMatchObject({
    ok: false,
    code: "invalid_input",
  });

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
  const config = readSshConfig(home);
  expect(resolveSshHost("github-work.com", config).hostname).toBe("github.com");
  expect(resolveSshHost("x", config).hostname).toBe("x.example");
  expect(readSshConfig(tmp("wk-rev-empty-")).text).toBe("");
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

test("given trunk moved and the branch was not rebased, patchId is unchanged", () => {
  // Kills the `base..head` mutant: a two-dot diff would include the reverse
  // of trunk's new commit and change the id.
  const root = repo();
  commit(root, "a.txt", "a\n", "base");
  git(root, "checkout", "-qb", "feature/y");
  commit(root, "feature.txt", "feature\n", "feature work");
  const before = patchId(root, "main", "feature/y");
  git(root, "checkout", "-q", "main");
  commit(root, "trunk.txt", "trunk only\n", "trunk moves");
  expect(patchId(root, "main", "feature/y")).toBe(before);
});

test("worktreeTree sees a same-size rewrite that only git's racy-entry check can catch", () => {
  // Racy git: an index entry whose mtime is not older than the index file is
  // re-hashed, because the stat data cannot prove it unchanged. Git builds
  // without nanosecond timestamps (macOS) hit this whenever a file is
  // rewritten within the second it was committed. Pin that case: only
  // second-granular mtime and size are compared, and the file, its index
  // entry and the index all share one timestamp. Without the fix, the
  // temporary index copy got a fresh mtime and the edit read as clean.
  const root = repo();
  git(root, "config", "core.checkStat", "minimal");
  const file = path.join(root, "a.ts");
  const stamp = new Date("2020-01-01T00:00:00Z");
  writeFileSync(file, "export const a = 1;\n");
  utimesSync(file, stamp, stamp);
  git(root, "add", "a.ts");
  git(root, "commit", "-qm", "base");
  const index = path.join(root, ".git", "index");
  utimesSync(index, stamp, stamp);
  const clean = worktreeTree(root)!;
  expect(clean.dirty).toBe(false);

  writeFileSync(file, "export const a = 2;\n"); // same size
  utimesSync(file, stamp, stamp); // same whole-second mtime
  utimesSync(index, stamp, stamp); // unchanged by worktreeTree; pinned for clarity
  const edited = worktreeTree(root)!;
  expect(edited.dirty).toBe(true);
  expect(edited.tree).not.toBe(clean.tree);
});

test("worktreeTree records oversized untracked files by stat instead of hashing them", () => {
  const root = repo();
  commit(root, "a.txt", "a\n", "base");
  writeFileSync(path.join(root, "big.bin"), Buffer.alloc(2048, 1));
  writeFileSync(path.join(root, "small.txt"), "small\n");
  const capped = worktreeTree(root, { maxUntrackedBytes: 1024 })!;
  expect(capped.skipped).toEqual([{ path: "big.bin", size: 2048, mtimeMs: expect.any(Number) }]);
  expect(capped.key).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(capped.dirty).toBe(true);
  // The big file is not in the tree (and was not written as a blob).
  expect(git(root, "ls-tree", "--name-only", capped.tree)).toBe("a.txt\nsmall.txt");
  const blob = spawnSync("git", ["hash-object", "big.bin"], { cwd: root, encoding: "utf8" });
  const exists = spawnSync("git", ["cat-file", "-e", blob.stdout.trim()], { cwd: root });
  expect(exists.status).not.toBe(0);
  // Same stat, same key; a size change moves the key, not the tree.
  expect(worktreeTree(root, { maxUntrackedBytes: 1024 })!.key).toBe(capped.key);
  writeFileSync(path.join(root, "big.bin"), Buffer.alloc(4096, 1));
  const grown = worktreeTree(root, { maxUntrackedBytes: 1024 })!;
  expect(grown.tree).toBe(capped.tree);
  expect(grown.key).not.toBe(capped.key);
  // Under the default cap the file is hashed normally.
  const hashed = worktreeTree(root)!;
  expect(hashed.skipped).toEqual([]);
  expect(hashed.key).toBe(hashed.tree);
});

// Wall-clock bounds prove "returned instead of hanging", not speed. Starting
// the watchdog runtime and killing a process tree (taskkill on Windows) can
// take seconds on a busy CI runner, so the bound is the configured timeout
// plus generous per-platform slack. That is still far below the 30-60 s the
// fake hangs (or ssh's own connect retries) would take. Whether the timer
// fired is asserted through the error text, which does not depend on the runner.
const HANG_SLACK_MS = process.platform === "win32" ? 20_000 : 10_000;
const expectReturnedWithin = (started: number, timeoutMs: number): void => {
  expect(Date.now() - started).toBeLessThan(timeoutMs + HANG_SLACK_MS);
};

test("remoteTip on an unreachable SSH host returns unavailable within the timeout", () => {
  const root = repo();
  // Windows: killing git on timeout orphans its ssh child, which keeps the
  // repo dir open for a while; that dir is removed best-effort, not by afterEach.
  dirs.splice(dirs.indexOf(root), 1);
  try {
    // 10.255.255.1 is unroutable (blackholed); some networks reject it fast,
    // either way the call must end as `unavailable` well before a hang.
    git(root, "remote", "add", "dead", "ssh://git@10.255.255.1:22/o/r.git");
    const started = Date.now();
    const tip = remoteTip(root, "dead", "main", { timeoutMs: 2_000 });
    expectReturnedWithin(started, 2_000);
    expect(tip).toMatchObject({ ok: false, code: "unavailable" });
    if (!tip.ok) expect(tip.error).toContain("dead");
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // EBUSY on Windows while the orphaned ssh is still connecting.
    }
  }
}, 45_000);

test("remote URLs are redacted everywhere they are echoed", () => {
  const secret = "tok3n-s3cret";
  for (const url of [
    `https://user:${secret}@github.com/o/r.git`,
    `git+https://user:${secret}@code.example/o/r.git`,
    `ftp://user:${secret}@code.example/o/r.git`,
    `https://code.example/o/r.git?private_token=${secret}`,
    `ssh://git:${secret}@code.example/o/r.git`,
    `user:${secret}@code.example:o/r.git`,
  ]) {
    expect(redactRemote(url), url).not.toContain(secret);
    const root = repo();
    git(root, "remote", "add", "origin", url);
    const result = pushForge(root, { sshConfig: "" });
    expect(JSON.stringify(result), url).not.toContain(secret);
    // Same credentials against a closed local port: fails fast, no network.
    const offline = url.replace(/github\.com|code\.example/u, "127.0.0.1:9");
    const tip = remoteTip(root, offline, "main", { timeoutMs: 5_000 });
    expect(tip.ok, offline).toBe(false);
    expect(JSON.stringify(tip), url).not.toContain(secret);
  }
  expect(redactRemote("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
  expect(redactRemote("ssh://git@host:22/o/r")).toBe("ssh://git@host:22/o/r");
  expect(redactRemote("")).toBe("<unparseable remote>");
  // git's <transport>::<address> form can carry a whole command line.
  expect(redactRemote(`ext::ssh -i key user:${secret}@host %S repo`)).toBe("<unparseable remote>");
  expect(redactRemote("fd::17")).toBe("<unparseable remote>");
  expect(parseRemoteUrl("ext::sh -c x")).toBeNull();
  // A successful derivation reports the redacted URL too.
  const root = repo();
  git(root, "remote", "add", "origin", `https://user:${secret}@github.com/o/r.git`);
  const ok = pushForge(root, { sshConfig: "" });
  expect(ok).toMatchObject({ ok: true, url: "https://github.com/o/r.git" });
}, 60_000);

test("SSH aliases keep their case: patterns match case-insensitively, %h keeps the spelling", () => {
  const config = "Host GitHub-Work\n  HostName %h.example\n";
  expect(resolveSshHost("github-work", config).hostname).toBe("github-work.example");
  expect(resolveSshHost("GitHub-Work", config).hostname).toBe("GitHub-Work.example");
  expect(parseRemoteUrl("git@GitHub-Work:o/r.git")?.host).toBe("GitHub-Work");
  expect(
    deriveForge("git@GitHub-Work:o/r.git", {
      sshConfig: "Host github-work\n HostName GitHub.com\n",
    }),
  ).toMatchObject({ kind: "github", host: "GitHub-Work", hostname: "github.com" });
});

test("SSH Include applies only inside a matching block and the block continues after it", () => {
  const home = tmp("wk-rev-inc-");
  mkdirSync(path.join(home, ".ssh"), { recursive: true });
  writeFileSync(
    path.join(home, ".ssh", "extra"),
    "Port 2200\nHost other\n  HostName other.example\n",
  );
  writeFileSync(
    path.join(home, ".ssh", "inactive"),
    "HostName wrong.example\nHost *\n  HostName wrong2.example\n",
  );
  const text = [
    "Host work",
    "  Include extra",
    "  HostName github.com",
    "Host personal",
    "  Include inactive",
    "Host *",
    "  HostName fallback.example",
  ].join("\n");
  const config = { text, home };
  // The included Port applies; the enclosing block's HostName after the Include still does.
  expect(resolveSshHost("work", config)).toEqual({ hostname: "github.com", port: "2200" });
  // An Include inside a non-matching block contributes nothing, even `Host *` inside it.
  expect(resolveSshHost("unrelated", config)).toEqual({
    hostname: "fallback.example",
    port: null,
  });
  // Host lines inside an included file still work for their own aliases.
  expect(resolveSshHost("other", { text: "Include extra\n", home }).hostname).toBe("other.example");
});

// ---------------------------------------------------------------------------
// Network safety: no prompts, ssh batch mode, a hard timeout, and nothing
// (git, ssh, git-remote-https holding the URL) left running afterwards.

const posix = process.platform !== "win32";

test("networkGitInvocation never prompts and bounds ssh and HTTP stalls", () => {
  const saved = { ...process.env };
  try {
    delete process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH;
    process.env.GIT_ASKPASS = "/usr/bin/ksshaskpass";
    const plain = networkGitInvocation(repo(), ["ls-remote", "origin"], 7_500);
    expect(plain.args).toEqual([
      "-c",
      "http.lowSpeedLimit=1",
      "-c",
      "http.lowSpeedTime=8",
      "ls-remote",
      "origin",
    ]);
    expect(plain.env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      SSH_ASKPASS_REQUIRE: "never",
      GCM_INTERACTIVE: "never",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=8",
    });
    // A user ssh command is kept and only extended; the connect timeout caps at 10 s.
    process.env.GIT_SSH_COMMAND = "ssh -i ~/.ssh/id_work";
    expect(networkGitInvocation(repo(), [], 60_000).env.GIT_SSH_COMMAND).toBe(
      "ssh -i ~/.ssh/id_work -o BatchMode=yes -o ConnectTimeout=10",
    );
    const configured = repo();
    delete process.env.GIT_SSH_COMMAND;
    git(configured, "config", "core.sshCommand", "ssh -F /dev/null");
    expect(networkGitInvocation(configured, [], 3_000).env.GIT_SSH_COMMAND).toBe(
      "ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=3",
    );
    // A bare GIT_SSH program may not accept -o: left alone.
    process.env.GIT_SSH = "plink";
    expect(networkGitInvocation(repo(), [], 3_000).env.GIT_SSH_COMMAND).toBeUndefined();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

const withEnv = async <T>(vars: Record<string, string>, run: () => T | Promise<T>): Promise<T> => {
  const saved = { ...process.env };
  Object.assign(process.env, vars);
  try {
    return await run();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
};

// Hermetic git: no user/system config (credential helpers, insteadOf).
const HERMETIC = { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" };

const script = (dir: string, name: string, body: string): string => {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const startServer = async (mode: "stall" | "401") => {
  const dir = tmp("wk-rev-srv-");
  const file = path.join(dir, "server.mjs");
  writeFileSync(
    file,
    `import http from "node:http"; import net from "node:net";
const server = ${
      mode === "stall"
        ? "net.createServer(() => {})"
        : `http.createServer((_q, r) => { r.writeHead(401, { "WWW-Authenticate": 'Basic realm="x"' }); r.end(); })`
    };
server.listen(0, "127.0.0.1", () => console.log(server.address().port));`,
  );
  const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())));
    child.once("exit", () => reject(new Error("server exited")));
  });
  return { port, stop: () => child.kill("SIGKILL") };
};

test.skipIf(!posix)(
  "ssh runs in batch mode with a connect timeout (a fake ssh that would block otherwise)",
  async () => {
    const bin = tmp("wk-rev-ssh-");
    const fake = script(
      bin,
      "fake-ssh",
      `case "$*" in *BatchMode=yes*ConnectTimeout=*) echo "fake ssh: denied" >&2; exit 255;; esac\nsleep 30`,
    );
    const root = repo();
    git(root, "remote", "add", "origin", "ssh://git@example.invalid/o/r.git");
    const started = Date.now();
    const tip = await withEnv({ ...HERMETIC, GIT_SSH_COMMAND: fake }, () =>
      remoteTip(root, "origin", "main", { timeoutMs: 8_000 }),
    );
    expectReturnedWithin(started, 8_000);
    expect(tip).toMatchObject({ ok: false, code: "unavailable" });
    // Ended by ssh's own refusal, not by the watchdog timer.
    if (!tip.ok) expect(tip.error).not.toContain("timed out");
  },
  45_000,
);

test.skipIf(!posix)(
  "credentials are never prompted for (a fake askpass that would block)",
  async () => {
    const server = await startServer("401");
    try {
      const bin = tmp("wk-rev-askpass-");
      const asked = path.join(bin, "asked");
      const askpass = script(bin, "askpass", `touch "${asked}"\nsleep 30`);
      const root = repo();
      const started = Date.now();
      const tip = await withEnv(
        { ...HERMETIC, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "1" },
        () =>
          remoteTip(root, `http://127.0.0.1:${server.port}/o/r.git`, "main", { timeoutMs: 8_000 }),
      );
      expectReturnedWithin(started, 8_000);
      expect(tip).toMatchObject({ ok: false, code: "unavailable" });
      // Failed on the 401 without asking, not by the watchdog timer.
      if (!tip.ok) expect(tip.error).not.toContain("timed out");
      expect(existsSync(asked)).toBe(false);
    } finally {
      server.stop();
    }
  },
  45_000,
);

test.skipIf(!posix)(
  "a timed-out call kills git's whole process tree (ssh and git-remote-https included)",
  async () => {
    const bin = tmp("wk-rev-hang-");
    const pidFile = path.join(bin, "ssh.pid");
    // Ignores every option, so only the watchdog's timeout can end it.
    const fake = script(bin, "hang-ssh", `echo $$ > "${pidFile}"\nexec sleep 60`);
    const root = repo();
    git(root, "remote", "add", "origin", "ssh://git@example.invalid/o/r.git");
    const started = Date.now();
    const tip = await withEnv({ ...HERMETIC, GIT_SSH_COMMAND: fake }, () =>
      remoteTip(root, "origin", "main", { timeoutMs: 1_500 }),
    );
    expectReturnedWithin(started, 1_500);
    expect(tip).toMatchObject({ ok: false, code: "unavailable" });
    if (!tip.ok) expect(tip.error).toContain("timed out after 1500 ms");
    const sshPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(sshPid).toBeGreaterThan(0);
    expect(alive(sshPid)).toBe(false);

    // HTTPS to a server that accepts and never answers: git-remote-https has
    // the credential URL in its argv and must not survive the timeout.
    const server = await startServer("stall");
    try {
      const token = `tok-${process.pid}-${Date.now()}`;
      const stalled = await withEnv(HERMETIC, () =>
        remoteTip(root, `https://user:${token}@127.0.0.1:${server.port}/o/r.git`, "main", {
          timeoutMs: 1_500,
        }),
      );
      expect(stalled).toMatchObject({ ok: false, code: "unavailable" });
      expect(JSON.stringify(stalled)).not.toContain(token);
      // `ps` (not pgrep) lists every process with its full argv on Linux and macOS.
      const listing = spawnSync("ps", ["-eo", "args="], { encoding: "utf8" });
      expect(listing.status).toBe(0);
      const left = {
        stdout: listing.stdout
          .split("\n")
          .filter((row) => row.includes(token))
          .join("\n"),
      };
      expect(left.stdout.trim()).toBe("");
    } finally {
      server.stop();
    }
  },
  60_000,
);
