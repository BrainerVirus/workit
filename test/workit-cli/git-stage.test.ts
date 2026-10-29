import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// `workit git commit` keeps partial staging (a path staged in part commits its
// staged hunks only; --whole, --staged) and `workit git stage|unstage`, against
// real git in temp repositories.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-git-stage-");
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "github-flow" },
      commitPolicy: { preset: "conventional" },
    }),
  );
});
afterAll(() => configHome.restore());

const repos: RemoteRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

const SESSION = { ...process.env, WORKIT_SESSION_ID: "author-1" };

const run = async (argv: string[], cwd: string) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: SESSION,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const gitIn = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

/** Twenty numbered lines; `edits` replaces line n (1-based) with `n changed`. */
const body = (...edits: number[]) =>
  Array.from({ length: 20 }, (_, index) =>
    edits.includes(index + 1) ? `${index + 1} changed\n` : `${index + 1}\n`,
  ).join("");

/** `git diff -- file` cut to its first hunk: the change at line 2, not line 19. */
const firstHunk = (cwd: string, file: string) => {
  const diff = gitIn(cwd, "diff", "--", file);
  const hunks = diff.split(/(?=^@@ )/mu);
  expect(hunks).toHaveLength(3);
  return hunks[0] + hunks[1];
};

/** A repo on feature/a where each named file is committed as body() and then edited at lines 2 and 19. */
const twoHunkRepo = (...files: string[]) => {
  const repo = makeRemoteRepo();
  repos.push(repo);
  repo.git("switch", "-q", "-c", "feature/a");
  for (const file of files) repo.write(file, body());
  if (files.length) {
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "chore: seed");
  }
  for (const file of files) repo.write(file, body(2, 19));
  return repo;
};

/** Stage only the line-2 hunk of `file`, as `git add -p` would. */
const stageFirstHunk = (cwd: string, file: string) =>
  spawnSync("git", ["apply", "--cached", "-"], { cwd, input: firstHunk(cwd, file) });

const indexState = (cwd: string) => {
  const names = (...args: string[]) =>
    gitIn(cwd, "diff", "--name-only", ...args)
      .split("\n")
      .filter(Boolean)
      .toSorted();
  return { staged: names("--cached"), unstaged: names() };
};

const leftoverIndexes = (cwd: string) => {
  const gitDir = path.resolve(cwd, gitIn(cwd, "rev-parse", "--git-dir").trim());
  return readdirSync(gitDir).filter((name) => name.startsWith("workit-commit-"));
};

test("git commit -- <path>: a path staged in part commits its staged hunk only; the rest stays unstaged", async () => {
  const repo = twoHunkRepo("f.txt");
  stageFirstHunk(repo.cwd, "f.txt");
  repo.write("other.md", "someone else's staged change\n");
  repo.git("add", "other.md");

  const result = await run(
    ["git", "commit", "--json", "-m", "feat: line two", "--", "f.txt"],
    repo.cwd,
  );
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({ files: ["f.txt"], keptPartial: ["f.txt"] });
  expect(gitIn(repo.cwd, "show", "HEAD:f.txt")).toBe(body(2));
  expect(readFileSync(path.join(repo.cwd, "f.txt"), "utf8")).toBe(body(2, 19));
  // f.txt: index == HEAD, the line-19 hunk unstaged; other.md is still staged, uncommitted.
  expect(indexState(repo.cwd)).toEqual({ staged: ["other.md"], unstaged: ["f.txt"] });
  expect(gitIn(repo.cwd, "diff", "--", "f.txt")).toContain("+19 changed");
  const notes = result.stderr.split("\n").filter((line) => line.startsWith("note: committed only"));
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("f.txt");
  expect(notes[0]).toContain("--whole");
  expect(leftoverIndexes(repo.cwd)).toEqual([]);
});

test("git commit -- <path>: a private index a killed commit left behind is swept; a live commit's is kept", async () => {
  const repo = twoHunkRepo("f.txt");
  stageFirstHunk(repo.cwd, "f.txt");
  const gitDir = path.resolve(repo.cwd, gitIn(repo.cwd, "rev-parse", "--git-dir").trim());
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
  try {
    const now = Date.now();
    const kept = `workit-commit-${live.pid}-${now}.index`;
    for (const name of [
      `workit-commit-${dead}-${now}.index`,
      `workit-commit-${dead}-${now}.index.lock`,
      `workit-commit-${live.pid}-${now - 2 * 60 * 60_000}.index`,
      kept,
    ])
      writeFileSync(path.join(gitDir, name), "stale");
    const result = await run(["git", "commit", "-m", "feat: line two", "--", "f.txt"], repo.cwd);
    expect(result.code).toBe(0);
    expect(leftoverIndexes(repo.cwd)).toEqual([kept]);
  } finally {
    live.kill();
  }
});

test("git commit -- <paths>: partial, unstaged and staged paths mixed, from a subdirectory", async () => {
  const repo = twoHunkRepo("src/p.txt", "src/q.txt", "g.txt", "h.txt");
  stageFirstHunk(repo.cwd, "src/p.txt");
  repo.git("add", "h.txt");
  const src = path.join(repo.cwd, "src");

  const result = await run(
    ["git", "commit", "--json", "-m", "feat: mixed", "--", ".", "../g.txt", "../h.txt"],
    src,
  );
  expect(result.code).toBe(0);
  const data = result.json().data;
  expect(data.keptPartial).toEqual(["src/p.txt"]);
  expect(data.files.toSorted()).toEqual(["g.txt", "h.txt", "src/p.txt", "src/q.txt"]);
  expect(gitIn(repo.cwd, "show", "HEAD:src/p.txt")).toBe(body(2));
  for (const whole of ["src/q.txt", "g.txt", "h.txt"])
    expect(gitIn(repo.cwd, "show", `HEAD:${whole}`)).toBe(body(2, 19));
  expect(indexState(repo.cwd)).toEqual({ staged: [], unstaged: ["src/p.txt"] });
  expect(result.stderr).toContain("note: committed only the staged part of src/p.txt");
});

test("git commit --whole -- <path>: the whole working tree of a path staged in part", async () => {
  const repo = twoHunkRepo("f.txt");
  stageFirstHunk(repo.cwd, "f.txt");
  const result = await run(
    ["git", "commit", "--json", "--whole", "-m", "feat: all", "--", "f.txt"],
    repo.cwd,
  );
  expect(result.code).toBe(0);
  expect(result.json().data.keptPartial).toEqual([]);
  expect(gitIn(repo.cwd, "show", "HEAD:f.txt")).toBe(body(2, 19));
  expect(indexState(repo.cwd)).toEqual({ staged: [], unstaged: [] });
  expect(result.stderr).not.toContain("note: committed only");
});

test("git commit --staged: exactly the index; refused when nothing is staged or mixed with --all, --whole, paths", async () => {
  const repo = twoHunkRepo("f.txt", "g.txt");
  const empty = await run(["git", "commit", "--json", "--staged", "-m", "feat: x"], repo.cwd);
  expect(empty.code).toBe(3);
  expect(empty.json().error).toContain(
    "nothing_staged: --staged commits the index, and nothing is staged",
  );
  expect(empty.json().unblock).toContain("workit git stage --patch");

  for (const extra of [["--all"], ["--whole"], ["--", "f.txt"]]) {
    const mixed = await run(["git", "commit", "--staged", "-m", "feat: x", ...extra], repo.cwd);
    expect(mixed.code).toBe(2);
    expect(mixed.stderr).toContain("--staged commits the index as is");
  }
  const whole = await run(["git", "commit", "--whole", "-m", "feat: x"], repo.cwd);
  expect(whole.code).toBe(2);
  expect(whole.stderr).toContain("--whole applies to named paths");

  stageFirstHunk(repo.cwd, "f.txt");
  const result = await run(["git", "commit", "--json", "--staged", "-m", "feat: hunk"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.json().data.files).toEqual(["f.txt"]);
  expect(gitIn(repo.cwd, "show", "HEAD:f.txt")).toBe(body(2));
  expect(gitIn(repo.cwd, "show", "HEAD:g.txt")).toBe(body());
  expect(indexState(repo.cwd)).toEqual({ staged: [], unstaged: ["f.txt", "g.txt"] });
});

test("git stage --patch: selected hunks reach the index only; a patch that does not apply is refused", async () => {
  const repo = twoHunkRepo("f.txt");
  const patch = path.join(repo.root, "hunk.patch");
  writeFileSync(patch, firstHunk(repo.cwd, "f.txt"));

  const staged = await run(["git", "stage", "--json", "--patch", patch], repo.cwd);
  expect(staged.code).toBe(0);
  expect(staged.json().data.staged).toEqual(["f.txt"]);
  expect(gitIn(repo.cwd, "show", ":f.txt")).toBe(body(2));
  expect(readFileSync(path.join(repo.cwd, "f.txt"), "utf8")).toBe(body(2, 19));

  // The same hunk again no longer applies: the index already has it.
  const again = await run(["git", "stage", "--json", "--patch", patch], repo.cwd);
  expect(again.code).toBe(1);
  expect(again.json().error).toContain("patch_does_not_apply");
  expect(again.json().error).toContain("patch does not apply");
  expect(gitIn(repo.cwd, "show", ":f.txt")).toBe(body(2));

  const missing = await run(
    ["git", "stage", "--patch", path.join(repo.root, "none.patch")],
    repo.cwd,
  );
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain("cannot read --patch");
  const both = await run(["git", "stage", "--patch", patch, "f.txt"], repo.cwd);
  expect(both.code).toBe(2);
  expect((await run(["git", "stage"], repo.cwd)).code).toBe(2);

  // Then a focused commit of what is staged.
  const committed = await run(["git", "commit", "--staged", "-m", "feat: line two"], repo.cwd);
  expect(committed.code).toBe(0);
  expect(gitIn(repo.cwd, "show", "HEAD:f.txt")).toBe(body(2));
  expect(indexState(repo.cwd)).toEqual({ staged: [], unstaged: ["f.txt"] });
});

test("git stage -- <paths> and git unstage -- <paths>: whole paths, the working tree untouched", async () => {
  const repo = twoHunkRepo("f.txt", "g.txt");
  repo.write("new.txt", "new\n");
  const staged = await run(["git", "stage", "--json", "--", "f.txt", "new.txt"], repo.cwd);
  expect(staged.code).toBe(0);
  expect(staged.json().data.staged).toEqual(["f.txt", "new.txt"]);
  const unstaged = await run(["git", "unstage", "--json", "--", "f.txt", "new.txt"], repo.cwd);
  expect(unstaged.code).toBe(0);
  expect(unstaged.json().data.staged).toEqual([]);
  expect(readFileSync(path.join(repo.cwd, "f.txt"), "utf8")).toBe(body(2, 19));
  expect(indexState(repo.cwd)).toEqual({ staged: [], unstaged: ["f.txt", "g.txt"] });
  expect((await run(["git", "unstage"], repo.cwd)).code).toBe(2);
});

// An auto-fix pre-commit hook (lint-staged, lefthook stage_fixed) that
// upper-cases each staged *.txt file and re-adds it to the index git hands it.
const AUTOFIX_HOOK = `#!/bin/sh
git diff --cached --name-only --diff-filter=ACM -- '*.txt' | while read -r f; do
  tr a-z A-Z < "$f" > "$f.fix" && mv "$f.fix" "$f" && git add -- "$f"
done
`;

test.skipIf(process.platform === "win32")(
  "git commit -- <paths>: an auto-fix hook leaves fixed paths clean and a partial path's rest unstaged",
  async () => {
    const repo = twoHunkRepo("notes.md");
    writeFileSync(path.join(repo.git("config", "core.hooksPath"), "pre-commit"), AUTOFIX_HOOK, {
      mode: 0o755,
    });
    stageFirstHunk(repo.cwd, "notes.md");
    repo.write("a.txt", "hello\n");
    const result = await run(
      ["git", "commit", "--json", "-m", "feat: fixed", "--", "a.txt", "notes.md"],
      repo.cwd,
    );
    expect(result.code).toBe(0);
    expect(result.json().data.keptPartial).toEqual(["notes.md"]);
    expect(gitIn(repo.cwd, "show", "HEAD:a.txt")).toBe("HELLO\n");
    expect(gitIn(repo.cwd, "show", ":a.txt")).toBe("HELLO\n");
    expect(gitIn(repo.cwd, "show", "HEAD:notes.md")).toBe(body(2));
    expect(gitIn(repo.cwd, "show", ":notes.md")).toBe(body(2));
    expect(indexState(repo.cwd)).toEqual({ staged: [], unstaged: ["notes.md"] });
  },
);

test.skipIf(process.platform === "win32")(
  "git commit -- <path>: partial staging in a linked worktree uses that worktree's index",
  async () => {
    const repo = twoHunkRepo();
    repo.write("f.txt", body());
    repo.git("add", "f.txt");
    repo.git("commit", "-q", "-m", "chore: seed");
    const linked = path.join(repo.root, "linked");
    repo.git("worktree", "add", "-q", "-b", "feature/b", linked);
    writeFileSync(path.join(linked, "f.txt"), body(2, 19));
    stageFirstHunk(linked, "f.txt");
    repo.write("main-only.txt", "staged in the main checkout\n");
    repo.git("add", "main-only.txt");

    const result = await run(
      ["git", "commit", "--json", "-m", "feat: linked", "--", "f.txt"],
      linked,
    );
    expect(result.code).toBe(0);
    expect(result.json().data).toMatchObject({ branch: "feature/b", keptPartial: ["f.txt"] });
    expect(gitIn(linked, "show", "HEAD:f.txt")).toBe(body(2));
    expect(indexState(linked)).toEqual({ staged: [], unstaged: ["f.txt"] });
    expect(indexState(repo.cwd)).toEqual({ staged: ["main-only.txt"], unstaged: [] });
    expect(leftoverIndexes(linked)).toEqual([]);
  },
);
