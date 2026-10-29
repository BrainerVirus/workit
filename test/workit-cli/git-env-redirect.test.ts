// #545: grants resolve from the working directory, git follows GIT_DIR and
// friends. A grant-gated verb run with one of them set could act on a
// repository whose grants were never read, so it is refused before it loads;
// read-only verbs keep working (dotfile repositories use GIT_DIR daily).
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { GIT_REDIRECT_ENV } from "@/packages/workit-core/src/git/env-redirect";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

setDefaultTimeout(60_000);

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-git-env-config-");
});
afterAll(() => configHome.restore());

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configHome.configDir, name), { force: true });
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const run = async (argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...env, WORKIT_SESSION_ID: "author-1" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr };
};

/** Run with `vars` in the process environment too: the git children inherit it. */
const withProcessEnv = async <T>(vars: Record<string, string>, fn: () => Promise<T>) => {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
};

const plainFolder = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-git-env-plain-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A git-flow checkout on develop, one commit ahead of origin/develop. */
const strictRepo = (): RemoteRepo => {
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "gitflow" } }),
  );
  const repo = makeRemoteRepo();
  cleanups.push(repo.cleanup);
  repo.git("switch", "-q", "-c", "develop");
  repo.write("develop.txt", "develop\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore: develop");
  repo.git("push", "-q", "origin", "develop");
  repo.write("ahead.txt", "ahead\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore: ahead");
  return repo;
};

test("Given a strict repository and a plain folder under a permissive workspace, When workit git push --release develop runs from the folder with GIT_DIR and GIT_WORK_TREE naming the repository, Then it is refused naming the variables and the unblock, and develop does not move", async () => {
  const repo = strictRepo();
  const plain = plainFolder();
  const glob = (dir: string) => `${dir.replaceAll("\\", "/")}/**`;
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        { name: "strict", glob: glob(repo.root), autonomy: { release: false } },
        { name: "open", glob: glob(plain), autonomy: { release: true, push: true } },
      ],
    }),
  );
  const before = repo.remoteTip("develop");
  // Inside the checkout the grant refuses it.
  const inside = await run(["git", "push", "--release", "develop", "--json"], repo.cwd);
  expect(inside.code, inside.stdout + inside.stderr).toBe(3);
  expect(inside.stdout).toContain("grant_required");
  const vars = { GIT_DIR: path.join(repo.cwd, ".git"), GIT_WORK_TREE: repo.cwd };
  const redirected = await withProcessEnv(vars, () =>
    run(["git", "push", "--release", "develop", "--json"], plain),
  );
  expect(redirected.code, redirected.stdout + redirected.stderr).toBe(3);
  const envelope = JSON.parse(redirected.stdout) as { error: string; unblock: string };
  expect(envelope.error).toContain("git_env_redirect: GIT_DIR, GIT_WORK_TREE are set");
  expect(envelope.unblock).toBe(
    "unset GIT_DIR GIT_WORK_TREE, or cd into the repository and run workit git push there",
  );
  expect(repo.remoteTip("develop")).toBe(before);
});

const GATED: ReadonlyArray<readonly string[]> = [
  ["git", "push"],
  ["git", "push", "--release", "develop"],
  ["release", "start", "1.0.0"],
  ["release", "finish"],
  ["release", "publish"],
  ["pr", "create", "--fill"],
  ["pr", "merge"],
  ["pr", "ready"],
  ["pr", "edit", "--title", "t"],
  ["stack", "land"],
  ["stack", "sync"],
  ["stack", "restack"],
  ["ci", "rerun"],
];

test("Given each redirecting git variable, When any grant-gated verb runs, Then it is refused before it loads", async () => {
  const cwd = plainFolder();
  for (const name of GIT_REDIRECT_ENV)
    for (const argv of GATED) {
      const result = await run([...argv, "--json"], cwd, { ...process.env, [name]: "/elsewhere" });
      const label = `${name} ${argv.join(" ")}`;
      expect(result.code, label).toBe(3);
      const envelope = JSON.parse(result.stdout) as { error: string; unblock: string };
      expect(envelope.error, label).toStartWith(`git_env_redirect: ${name} is set`);
      expect(envelope.unblock, label).toStartWith(`unset ${name}, or cd into the repository`);
    }
});

test("Given a gated verb's help, When it runs with GIT_DIR set, Then help still answers", async () => {
  const result = await run(["git", "push", "--help"], plainFolder(), {
    ...process.env,
    GIT_DIR: "/elsewhere",
  });
  expect(result.code).toBe(0);
  expect(result.stdout + result.stderr).not.toContain("git_env_redirect");
});

test("Given a dotfile-style GIT_DIR, When read-only verbs run, Then none is refused for it", async () => {
  const repo = strictRepo();
  const env = {
    ...process.env,
    GIT_DIR: path.join(repo.cwd, ".git"),
    GIT_WORK_TREE: repo.cwd,
  };
  for (const argv of [
    ["git", "trailers"],
    ["grant", "show"],
    ["stack", "status"],
    ["stack", "plan"],
  ]) {
    const result = await run([...argv, "--json"], repo.cwd, env);
    expect(result.stdout + result.stderr, argv.join(" ")).not.toContain("git_env_redirect");
  }
  const trailers = await run(["git", "trailers"], repo.cwd, env);
  expect(trailers.code, trailers.stdout + trailers.stderr).toBe(0);
});

// #548 fix round: no variable needed when the folder's own `.git` is a
// pointer (a `gitdir:` file or a symlink) into another checkout's repository.
for (const kind of ["gitdir file", "symlink"] as const)
  test.skipIf(kind === "symlink" && process.platform === "win32")(
    `Given a folder under a permissive workspace whose .git is a ${kind} to a strict repository, When workit git push runs there, Then it is capped at the strict repository and origin does not move`,
    async () => {
      const repo = strictRepo();
      const open = plainFolder();
      const glob = (dir: string) => `${dir.replaceAll("\\", "/")}/**`;
      writeFileSync(
        path.join(configHome.configDir, "workspaces.json"),
        JSON.stringify({
          workspaces: [
            { name: "strict", glob: glob(repo.root), autonomy: { release: false, push: false } },
            { name: "open", glob: glob(open), autonomy: { release: true, push: true } },
          ],
        }),
      );
      const folder = path.join(open, "pointer");
      mkdirSync(folder);
      const gitDir = path.join(repo.cwd, ".git");
      if (kind === "symlink") symlinkSync(gitDir, path.join(folder, ".git"));
      else writeFileSync(path.join(folder, ".git"), `gitdir: ${gitDir}\n`);
      const develop = repo.remoteTip("develop");
      const release = await run(["git", "push", "--release", "develop", "--json"], folder);
      expect(release.code, release.stdout + release.stderr).toBe(3);
      expect(release.stdout).toContain("grant_required");
      expect(repo.remoteTip("develop")).toBe(develop);
      repo.git("switch", "-q", "-c", "feature/x");
      const push = await run(["git", "push", "--json"], folder);
      expect(push.code, push.stdout + push.stderr).toBe(3);
      expect(push.stdout).toContain("grant_required");
      expect(repo.remoteTip("feature/x")).toBeNull();
    },
  );

// #552: no pointer at all. The folder's git directory is its own on disk, but
// its refs, objects and config are symlinks into a strict repository: a
// bare-style folder (no .git entry) or a real .git directory.
for (const shape of ["bare-style folder", "real .git directory"] as const)
  test.skipIf(process.platform === "win32")(
    `Given a ${shape} under a permissive workspace that borrows a strict repository's refs, objects and config, When workit git push runs there, Then it is refused and origin does not move`,
    async () => {
      const repo = strictRepo();
      const open = plainFolder();
      const glob = (dir: string) => `${dir.replaceAll("\\", "/")}/**`;
      writeFileSync(
        path.join(configHome.configDir, "workspaces.json"),
        JSON.stringify({
          workspaces: [
            { name: "strict", glob: glob(repo.root), autonomy: { release: false, push: false } },
            { name: "open", glob: glob(open), autonomy: { release: true, push: true } },
          ],
        }),
      );
      const folder = path.join(open, "borrower");
      const gitDir = shape === "bare-style folder" ? folder : path.join(folder, ".git");
      mkdirSync(gitDir, { recursive: true });
      const strictGit = path.join(repo.cwd, ".git");
      for (const name of ["objects", "refs", "config"])
        symlinkSync(path.join(strictGit, name), path.join(gitDir, name));
      writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/develop\n");
      const develop = repo.remoteTip("develop");
      const release = await run(["git", "push", "--release", "develop", "--json"], folder);
      expect(release.code, release.stdout + release.stderr).toBe(3);
      expect(repo.remoteTip("develop")).toBe(develop);
      repo.git("branch", "feature/x");
      writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feature/x\n");
      const push = await run(["git", "push", "--set-upstream", "--json"], folder);
      expect(push.code, push.stdout + push.stderr).toBe(3);
      expect(repo.remoteTip("feature/x")).toBeNull();
    },
  );
