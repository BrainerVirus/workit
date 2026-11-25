import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";

// #907: in a linked worktree, `workit git commit -- <path>` with the path
// staged in part failed in lefthook's pre-commit stash of the unstaged rest:
// lefthook before 2.2 saves it with `git diff --output <git dir>/info/<patch> --`,
// and git reads a path outside the worktree there as `--no-index` ("Not a git
// repository", exit 129). Workit now hides the unstaged rest itself while the
// hooks run, so they see the staged content and have nothing to stash. The
// commit keeps its semantics: the staged hunks only, the rest left unstaged.

setDefaultTimeout(60_000);

const LEFTHOOK = path.resolve(import.meta.dir, "../../node_modules/.bin/lefthook");

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-git-commit-linked-");
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

const run = async (argv: string[], cwd: string) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "author-1" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr };
};

const LINES = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";

/** A repo on main with f.txt and a pre-commit hook, plus a linked worktree on feature/x. */
const linkedWorktree = (hook: string) => {
  const repo = makeRemoteRepo();
  repos.push(repo);
  repo.write("f.txt", LINES);
  repo.write(
    "lefthook.yml",
    "pre-commit:\n  jobs:\n    - name: seen\n      glob: '*.txt'\n      run: cp {staged_files} ../seen.txt\n",
  );
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "chore: f");
  const hookFile = path.join(repo.root, "hooks", "pre-commit");
  writeFileSync(hookFile, hook);
  chmodSync(hookFile, 0o755);
  const wt = path.join(repo.root, "linked");
  repo.git("worktree", "add", "-q", "-b", "feature/x", wt);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: wt });
    return result.stdout.toString().trim();
  };
  // Stage the first line's change, leave the last line's unstaged (MM).
  writeFileSync(path.join(wt, "f.txt"), LINES.replace("a\n", "A\n"));
  git("add", "f.txt");
  writeFileSync(path.join(wt, "f.txt"), LINES.replace("a\n", "A\n").replace("j\n", "J\n"));
  expect(git("status", "--porcelain")).toBe("MM f.txt");
  return { wt, git };
};

const expectStagedHunkOnly = (wt: string, git: (...args: string[]) => string) => {
  expect(git("show", "HEAD:f.txt")).toBe(LINES.replace("a\n", "A\n").trim());
  expect(readFileSync(path.join(wt, "f.txt"), "utf8")).toBe(
    LINES.replace("a\n", "A\n").replace("j\n", "J\n"),
  );
  expect(git("status", "--porcelain")).toBe("M f.txt");
};

const STAGED = LINES.replace("a\n", "A\n");

test("Given a linked worktree with lefthook <2.2's stash step in pre-commit and a partly staged path, When workit git commit -- <path>, Then it commits the staged hunk only and the hook saw the staged content", async () => {
  // lefthook 2.1's save of the unstaged rest, run only when a file is staged in part.
  const hook = [
    "#!/bin/sh",
    "set -e",
    "cp f.txt ../seen.txt",
    'if git status --porcelain -- f.txt | grep -q "^MM"; then',
    '  git diff --binary --output "$(git rev-parse --path-format=absolute --git-path info)/unstaged-all.patch" --',
    "fi",
  ].join("\n");
  const { wt, git } = linkedWorktree(`${hook}\n`);

  const result = await run(["git", "commit", "-m", "feat: x", "--", "f.txt"], wt);
  expect(result.stderr).toContain("committed only the staged part of f.txt");
  expect(result.code).toBe(0);
  expectStagedHunkOnly(wt, git);
  expect(readFileSync(path.join(wt, "../seen.txt"), "utf8")).toBe(STAGED);
});

test("Given a linked worktree with a pre-commit hook that refuses, When workit git commit -- <partly staged path>, Then the unstaged rest is back in the working tree", async () => {
  const { wt, git } = linkedWorktree("#!/bin/sh\necho 'lint failed' >&2\nexit 1\n");

  const result = await run(["git", "commit", "-m", "feat: x", "--", "f.txt"], wt);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("lint failed");
  expect(readFileSync(path.join(wt, "f.txt"), "utf8")).toBe(
    LINES.replace("a\n", "A\n").replace("j\n", "J\n"),
  );
  expect(git("status", "--porcelain")).toBe("MM f.txt");
  expect(git("show", ":f.txt")).toBe(STAGED.trim());
});

test.skipIf(!existsSync(LEFTHOOK))(
  "Given a linked worktree with lefthook's pre-commit and a partly staged path, When workit git commit -- <path>, Then it commits the staged hunk only",
  async () => {
    const { wt, git } = linkedWorktree(`#!/bin/sh\nexec '${LEFTHOOK}' run pre-commit "$@"\n`);

    const result = await run(["git", "commit", "-m", "feat: x", "--", "f.txt"], wt);
    expect(result.stderr).toContain("committed only the staged part of f.txt");
    expect(result.code).toBe(0);
    expectStagedHunkOnly(wt, git);
    expect(readFileSync(path.join(wt, "../seen.txt"), "utf8")).toBe(STAGED);
  },
);
