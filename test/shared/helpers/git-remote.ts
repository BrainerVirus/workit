// A checkout with a real local bare remote (fetch and push), for the S11 git
// verbs: real `git push`, `ls-remote` and `fetch`, no network. Commits use a
// repo-local identity, no signing and an empty hooks directory, so the user's
// global git config cannot change the outcome.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const runGit = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

export type RemoteRepo = {
  root: string;
  /** The working checkout (on main, which is pushed). */
  cwd: string;
  /** The bare remote, configured as `origin`. */
  bare: string;
  git: (...args: string[]) => string;
  /** Tip of `branch` on the bare remote, or null. */
  remoteTip: (branch: string) => string | null;
  /** A second clone that pushes `branch` with one more commit (someone else). */
  pushFromElsewhere: (branch: string, file?: string) => string;
  write: (file: string, text: string) => void;
  cleanup: () => void;
};

const configure = (cwd: string, hooks: string) => {
  runGit(cwd, "config", "user.name", "t");
  runGit(cwd, "config", "user.email", "t@t");
  runGit(cwd, "config", "commit.gpgsign", "false");
  runGit(cwd, "config", "tag.gpgsign", "false");
  runGit(cwd, "config", "core.hooksPath", hooks);
};

export function makeRemoteRepo(subjects: readonly string[] = ["chore: base"]): RemoteRepo {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-git-"));
  const bare = path.join(root, "remote.git");
  const cwd = path.join(root, "work");
  const hooks = path.join(root, "hooks");
  mkdirSync(cwd);
  mkdirSync(hooks);
  runGit(root, "init", "-q", "--bare", "-b", "main", bare);
  runGit(cwd, "init", "-q", "-b", "main");
  configure(cwd, hooks);
  subjects.forEach((subject, index) => {
    writeFileSync(path.join(cwd, `base-${index}.txt`), `${index}\n`);
    runGit(cwd, "add", "-A");
    runGit(cwd, "commit", "-q", "-m", subject);
  });
  runGit(cwd, "remote", "add", "origin", bare);
  runGit(cwd, "push", "-q", "-u", "origin", "main");
  let others = 0;
  return {
    root,
    cwd,
    bare,
    git: (...args) => runGit(cwd, ...args),
    remoteTip: (branch) => {
      const result = spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], {
        cwd: bare,
        encoding: "utf8",
      });
      return result.status === 0 ? result.stdout.trim() : null;
    },
    pushFromElsewhere: (branch, file = "other.txt") => {
      others += 1;
      const other = path.join(root, `other-${others}`);
      runGit(root, "clone", "-q", bare, other);
      configure(other, hooks);
      const exists = spawnSync("git", ["rev-parse", "--verify", "-q", `origin/${branch}`], {
        cwd: other,
      });
      runGit(other, "switch", "-q", ...(exists.status === 0 ? [branch] : ["-c", branch]));
      writeFileSync(path.join(other, file), `${others}\n`);
      runGit(other, "add", "-A");
      runGit(other, "commit", "-q", "-m", `chore: elsewhere ${others}`);
      runGit(other, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
      return runGit(other, "rev-parse", "HEAD");
    },
    write: (file, text) => {
      const target = path.join(cwd, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Point the push URL at an ssh forge address (`git@github.com:o/r.git`) whose
 * transport is a fake ssh (core.sshCommand) serving the local bare repo: the
 * forge is derived from a real forge URL while every push stays offline.
 * POSIX only (a shell script). Pair with `withHome` so ~/.ssh/config aliases
 * of the machine running the tests cannot change the derived host.
 */
export function sshForgeRemote(repo: RemoteRepo, url: string): void {
  const ssh = path.join(repo.root, "fake-ssh");
  writeFileSync(
    ssh,
    `#!/bin/sh\nfor last; do :; done\ncase "$last" in\n  git-receive-pack*) exec git receive-pack '${repo.bare}' ;;\n  git-upload-pack*) exec git upload-pack '${repo.bare}' ;;\nesac\necho "fake ssh: unexpected $last" >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  runGit(repo.cwd, "config", "core.sshCommand", ssh);
  runGit(repo.cwd, "remote", "set-url", "--push", "origin", url);
}

/** Run `fn` with HOME at `home` (an empty ~/.ssh/config), restoring it after. */
export async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}
