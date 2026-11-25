import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";

// #907: while the hooks of `workit git commit -- <path>` run, a path staged in
// part holds its staged content on disk and gets its exact original back
// afterwards. Each kind of working-tree change, through a real commit with a
// pre-commit hook in a linked worktree: a symlink, a binary file, a file
// deleted from the working tree and an executable bit. The hook records the
// status it sees: the path staged in full, nothing unstaged.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-git-hide-kinds-");
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
});
afterAll(() => configHome.restore());

const repos: RemoteRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

const commit = async (cwd: string, file: string) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "author-1" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(["git", "commit", "-m", "feat: x", "--", file], io);
  return { code, stdout, stderr };
};

/**
 * A linked worktree on feature/x whose `name` was committed by `base` on main,
 * with a pre-commit hook writing `git status --porcelain` to ../seen.txt.
 */
const linked = (name: string, base: (cwd: string) => void) => {
  const repo = makeRemoteRepo();
  repos.push(repo);
  base(repo.cwd);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", `chore: ${name}`);
  const hookFile = path.join(repo.root, "hooks", "pre-commit");
  writeFileSync(hookFile, "#!/bin/sh\ngit status --porcelain > ../seen.txt\n");
  chmodSync(hookFile, 0o755);
  const wt = path.join(repo.root, "linked");
  repo.git("worktree", "add", "-q", "-b", "feature/x", wt);
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: wt })
      .stdout.toString()
      .trim();
  const seen = () => readFileSync(path.join(repo.root, "seen.txt"), "utf8").trim();
  const leftovers = () => {
    const store = path.join(repo.cwd, ".git", "worktrees", "linked", "workit");
    return existsSync(store) ? readdirSync(store).filter((n) => n.startsWith("unstaged-")) : [];
  };
  return { wt, git, seen, leftovers, file: path.join(wt, name) };
};

test("Given a symlink staged at one target with another target unstaged, When committed by path, Then HEAD has the staged target and the working tree the unstaged one", async () => {
  const w = linked("link", (cwd) => symlinkSync("a.txt", path.join(cwd, "link")));
  rmSync(w.file);
  symlinkSync("b.txt", w.file);
  w.git("add", "link");
  rmSync(w.file);
  symlinkSync("c.txt", w.file);
  expect(w.git("status", "--porcelain")).toBe("MM link");

  const result = await commit(w.wt, "link");
  expect(result.code).toBe(0);
  expect(w.seen()).toBe("M  link");
  expect(w.git("cat-file", "-p", "HEAD:link")).toBe("b.txt");
  expect(lstatSync(w.file).isSymbolicLink()).toBe(true);
  expect(readlinkSync(w.file)).toBe("c.txt");
  expect(w.git("status", "--porcelain")).toBe("M link");
  expect(w.leftovers()).toEqual([]);
});

test("Given a binary file staged at one version with another unstaged, When committed by path, Then the working tree gets its exact bytes back", async () => {
  const bytes = (n: number) => Buffer.from([0, 255, 1, n, 0, 10, 13, 200, n, 0]);
  const w = linked("blob.bin", (cwd) => writeFileSync(path.join(cwd, "blob.bin"), bytes(1)));
  writeFileSync(w.file, bytes(2));
  w.git("add", "blob.bin");
  writeFileSync(w.file, bytes(3));
  expect(w.git("status", "--porcelain")).toBe("MM blob.bin");

  const result = await commit(w.wt, "blob.bin");
  expect(result.code).toBe(0);
  expect(w.seen()).toBe("M  blob.bin");
  const head = Bun.spawnSync(["git", "show", "HEAD:blob.bin"], { cwd: w.wt }).stdout;
  expect(Buffer.from(head).equals(bytes(2))).toBe(true);
  expect(readFileSync(w.file).equals(bytes(3))).toBe(true);
  expect(w.leftovers()).toEqual([]);
});

test("Given a file staged modified and then deleted from the working tree, When committed by path, Then HEAD has the staged content and the file stays deleted", async () => {
  const w = linked("gone.txt", (cwd) => writeFileSync(path.join(cwd, "gone.txt"), "one\n"));
  writeFileSync(w.file, "two\n");
  w.git("add", "gone.txt");
  rmSync(w.file);
  expect(w.git("status", "--porcelain")).toBe("MD gone.txt");

  const result = await commit(w.wt, "gone.txt");
  expect(result.code).toBe(0);
  expect(w.seen()).toBe("M  gone.txt");
  expect(w.git("show", "HEAD:gone.txt")).toBe("two");
  expect(existsSync(w.file)).toBe(false);
  expect(w.git("status", "--porcelain")).toBe("D gone.txt");
  expect(w.leftovers()).toEqual([]);
});

test.skipIf(process.platform === "win32")(
  "Given a content change staged and an executable bit unstaged, When committed by path, Then HEAD keeps mode 100644 and the working tree stays executable",
  async () => {
    const w = linked("run.sh", (cwd) => writeFileSync(path.join(cwd, "run.sh"), "echo 1\n"));
    chmodSync(w.file, 0o644);
    writeFileSync(w.file, "echo 2\n");
    w.git("add", "run.sh");
    chmodSync(w.file, 0o755);
    expect(w.git("status", "--porcelain")).toBe("MM run.sh");

    const result = await commit(w.wt, "run.sh");
    expect(result.code).toBe(0);
    expect(w.seen()).toBe("M  run.sh");
    expect(w.git("ls-tree", "HEAD", "run.sh")).toStartWith("100644 ");
    expect(w.git("show", "HEAD:run.sh")).toBe("echo 2");
    expect(lstatSync(w.file).mode & 0o777).toBe(0o755);
    expect(readFileSync(w.file, "utf8")).toBe("echo 2\n");
    expect(w.leftovers()).toEqual([]);
  },
);
