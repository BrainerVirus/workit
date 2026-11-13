// A verifier judging a linked worktree W of the lead's repository writes its
// probes in W/.workit-scratch, which does not exist yet when it starts: making
// it, writing in it, and a scratch git repository inside it are allowed, from
// the lead's cwd too. These tests only dispatch the hook: no command below is
// ever run against the fixture except git's own setup.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { fixture } from "./hook-fixtures";

setDefaultTimeout(60_000);

let configHome: ConfigHome;
let root: string;
let lead: string;
let wt: string;
let other: string;
const stateBefore = process.env.WORKIT_STATE_DIR;

const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

beforeAll(() => {
  configHome = useConfigHome("wk-judge-scratch-config-");
  root = mkdtempSync(path.join(os.tmpdir(), "wk-judge-scratch-"));
  process.env.WORKIT_STATE_DIR = path.join(root, "state");
  lead = path.join(root, "app");
  mkdirSync(lead, { recursive: true });
  git(lead, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "t"],
    ["user.email", "t@t"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", path.join(root, "no-hooks")],
  ])
    git(lead, "config", key, value);
  writeFileSync(path.join(lead, "a.ts"), "export const a = 1;\n");
  git(lead, "add", "-A");
  git(lead, "commit", "-qm", "chore: base");
  // A linked worktree away from the checkout, as `workit fanout worktree create` makes them.
  wt = path.join(root, "worktrees", "slice");
  git(lead, "worktree", "add", "-q", "-b", "feature/slice", wt);
  other = path.join(root, "other");
  mkdirSync(path.join(other, ".workit-scratch"), { recursive: true });
  git(other, "init", "-q", "-b", "main");
});

afterAll(() => {
  if (stateBefore === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = stateBefore;
  configHome.restore();
  rmSync(root, { recursive: true, force: true });
});

type Specific = {
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};

/** A Claude Code PreToolUse from a Workit verifier whose hook cwd is the lead's checkout. */
const verifier = (tool: string, toolInput: Record<string, unknown>) => {
  const payload = fixture("claude-code", "pre-tool-use-write", lead, {
    tool_name: tool,
    tool_input: toolInput,
  });
  payload.agent_id = "ver-scratch";
  payload.agent_type = "workit:verifier";
  return (dispatchHook(claudeCodeAdapter, payload, {}).json as Specific).hookSpecificOutput
    ?.permissionDecision;
};
const posix = (command: string) => command.replaceAll("\\", "/");
const bash = (command: string) => verifier("Bash", { command: posix(command) });
const write = (file: string) => verifier("Write", { file_path: file, content: "x" });

test("Given a judge in the lead's checkout and a candidate linked worktree with no .workit-scratch yet, When it makes the scratch dir and writes a probe in it, Then both are allowed", () => {
  const repo = path.join(wt, ".workit-scratch", "r");
  rmSync(path.join(wt, ".workit-scratch"), { recursive: true, force: true });
  expect(bash(`mkdir -p ${repo}`)).toBeUndefined();
  expect(write(path.join(repo, "a.txt"))).toBeUndefined();
  expect(bash(`printf x > ${path.join(repo, "a.txt")}`)).toBeUndefined();
});

test("Given a scratch git repository inside the candidate's .workit-scratch, When the judge inits it, commits and adds a worktree in it, Then each is allowed; a commit in the candidate itself is still denied", () => {
  const repo = path.join(wt, ".workit-scratch", "r");
  rmSync(path.join(wt, ".workit-scratch"), { recursive: true, force: true });
  expect(bash(`git init ${repo}`)).toBeUndefined();
  // Once the scratch repository exists, its files sit in a checkout of their own.
  git(wt, "init", "-q", "-b", "main", repo);
  expect(write(path.join(repo, "a.txt"))).toBeUndefined();
  expect(bash(`git -C ${repo} add -A`)).toBeUndefined();
  expect(bash(`git -C ${repo} commit -qm probe`)).toBeUndefined();
  expect(
    bash(`git -C ${repo} worktree add ${path.join(wt, ".workit-scratch", "r2")}`),
  ).toBeUndefined();
  expect(bash(`git -C ${wt} commit -qm x`)).toBe("deny");
  expect(write(path.join(wt, "a.ts"))).toBe("deny");
  // A scratch repository's own .workit-scratch does not open the candidate's tree.
  expect(bash(`git -C ${repo} worktree add ${path.join(wt, "escape")}`)).toBe("deny");
  expect(bash(`git -C ${repo} worktree add -b x ${path.join(root, "escape")}`)).toBe("deny");
  expect(bash(`git init ${path.join(wt, "escape")}`)).toBe("deny");
});

test("Given a target under a not-yet-existing directory whose parent is a symlink, When judged, Then it resolves through the link: into scratch is allowed, out of scratch is denied", () => {
  const scratch = path.join(wt, ".workit-scratch");
  mkdirSync(path.join(scratch, "real"), { recursive: true });
  const linkType = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(path.join(scratch, "real"), path.join(lead, "in-link"), linkType);
  symlinkSync(path.join(wt, "src"), path.join(scratch, "out-link"), linkType);
  // A link whose target does not exist yet: the write lands at the target.
  symlinkSync(path.join(root, "nowhere"), path.join(scratch, "dangling"), linkType);
  expect(write(path.join(lead, "in-link", "new", "a.txt"))).toBeUndefined();
  expect(bash(`mkdir -p ${path.join(lead, "in-link", "new", "deeper")}`)).toBeUndefined();
  expect(write(path.join(scratch, "out-link", "new", "a.txt"))).toBe("deny");
  expect(write(path.join(scratch, "dangling", "new", "a.txt"))).toBe("deny");
  expect(bash(`mkdir -p ${path.join(scratch, "dangling", "x")}`)).toBe("deny");
});

test("Given another repository's .workit-scratch or a variable-built path, When judged, Then each is denied as before", () => {
  expect(write(path.join(other, ".workit-scratch", "a.txt"))).toBe("deny");
  expect(bash(`mkdir -p ${path.join(other, ".workit-scratch", "n", "m")}`)).toBe("deny");
  expect(bash('touch "$UNSET_DIR/x"')).toBe("deny");
  expect(bash(`touch "$(ls ${wt})/.workit-scratch/x"`)).toBe("deny");
});

test("Given a judge, When it adds a worktree of the judged repository into scratch, Then it is denied (it writes the repository's worktree list and branch); a scratch repository's own worktree add stays allowed", () => {
  const into = path.join(wt, ".workit-scratch", "x");
  mkdirSync(path.join(wt, ".workit-scratch"), { recursive: true });
  expect(bash(`git -C ${wt} worktree add -b feature/y ${into}`)).toBe("deny");
  expect(bash(`git -C ${wt} worktree add ${into}`)).toBe("deny");
  expect(bash(`git worktree add --detach ${into}`)).toBe("deny");
  expect(bash(`cd ${wt} && git worktree add ${into}`)).toBe("deny");
  // Run from inside scratch, git still finds and writes the judged repository.
  const scratch = path.join(wt, ".workit-scratch");
  expect(bash(`git -C ${scratch} worktree add -b feature/y ${into}`)).toBe("deny");
  expect(bash(`cd ${scratch} && git worktree add ${into}`)).toBe("deny");
  expect(bash(`git -C ${scratch} commit -qm x`)).toBe("deny");
  expect(bash(`cd ${scratch} && git branch -D feature/slice`)).toBe("deny");
  const repo = path.join(wt, ".workit-scratch", "own");
  git(wt, "init", "-q", "-b", "main", repo);
  expect(
    bash(`git -C ${repo} worktree add -b feature/y ${path.join(wt, ".workit-scratch", "own2")}`),
  ).toBeUndefined();
});

test("Given a symlink in scratch that points outside it, When a judge writes through link/.. , Then the target is judged where the shell lands (outside) and denied", () => {
  const scratch = path.join(wt, ".workit-scratch");
  const outsideDir = path.join(root, "outside", "deep");
  mkdirSync(outsideDir, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  symlinkSync(
    outsideDir,
    path.join(scratch, "up-link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(bash(`touch ${path.join(scratch, "up-link")}/../y`)).toBe("deny");
  expect(write(`${path.join(scratch, "up-link")}/../new/y`)).toBe("deny");
  expect(bash(`cd ${scratch} && touch up-link/../y`)).toBe("deny");
  expect(bash(`touch ${path.join(scratch, "sub")}/../y`)).toBeUndefined();
  expect(write(`${path.join(scratch, "sub")}/../y`)).toBeUndefined();
});

test("Given a scratch repository retargeted at another git dir (a .git file, --git-dir, --work-tree, GIT_* env, -c core.worktree, git config core.worktree|core.bare), When a judge runs git there, Then it is denied; the plain scratch repository stays allowed", () => {
  const scratch = path.join(wt, ".workit-scratch");
  const rt = path.join(scratch, "rt");
  git(wt, "init", "-q", "-b", "main", rt);
  const mainGit = path.join(lead, ".git");
  // A .git file naming the judged repository's git dir.
  const fake = path.join(scratch, "fake");
  mkdirSync(fake, { recursive: true });
  writeFileSync(path.join(fake, ".git"), `gitdir: ${mainGit}\n`);
  // A .git file Workit cannot read as one.
  const garbled = path.join(scratch, "garbled");
  mkdirSync(garbled, { recursive: true });
  writeFileSync(path.join(garbled, ".git"), "not a gitdir line\n");
  // A scratch repository whose config moves its work tree to the candidate.
  const moved = path.join(scratch, "moved");
  git(wt, "init", "-q", "-b", "main", moved);
  git(moved, "config", "core.worktree", wt);
  for (const command of [
    `git -C ${fake} commit -qm x`,
    `git -C ${garbled} commit -qm x`,
    `git -C ${moved} commit -qm x`,
    `git --git-dir=${mainGit} -C ${rt} commit -qm x`,
    `git -C ${rt} --git-dir ${mainGit} commit -qm x`,
    `git --work-tree=${wt} -C ${rt} checkout -- .`,
    `GIT_DIR=${mainGit} git -C ${rt} commit -qm x`,
    `export GIT_WORK_TREE=${wt}; git -C ${rt} add -A`,
    `GIT_COMMON_DIR=${mainGit} git -C ${rt} commit -qm x`,
    `GIT_INDEX_FILE=${path.join(mainGit, "index")} git -C ${rt} add -A`,
    `git -c core.worktree=${wt} -C ${rt} commit -qm x`,
    `git -C ${rt} config core.worktree ${wt}`,
    `git -C ${rt} config core.bare true`,
    `git -C ${rt} config include.path ${path.join(mainGit, "config")}`,
    'GIT_DIR="$X" git commit -qm x',
  ])
    expect(bash(command), command).toBe("deny");
  for (const command of [
    `git -C ${rt} commit -qm x`,
    `git -C ${rt} config user.name t`,
    `git --git-dir=${path.join(rt, ".git")} --work-tree=${rt} commit -qm x`,
    `GIT_DIR=${path.join(rt, ".git")} git -C ${rt} commit -qm x`,
  ])
    expect(bash(command), command).toBeUndefined();
});

test("Given a judge, When it writes a .git file or into a .git dir inside scratch, Then it is denied", () => {
  const scratch = path.join(wt, ".workit-scratch");
  const rt = path.join(scratch, "rt-write");
  git(wt, "init", "-q", "-b", "main", rt);
  expect(write(path.join(scratch, "new-repo", ".git"))).toBe("deny");
  expect(write(path.join(rt, ".git", "config"))).toBe("deny");
  expect(
    bash(`printf 'gitdir: ${path.join(lead, ".git")}' > ${path.join(scratch, "new2", ".git")}`),
  ).toBe("deny");
  expect(bash(`ln -s ${path.join(lead, ".git")} ${path.join(scratch, "new3", ".git")}`)).toBe(
    "deny",
  );
  expect(bash(`echo x >> ${path.join(rt, ".git", "config")}`)).toBe("deny");
});

test("Given files in scratch named like Workit's placeholders, When a judge writes them, Then they are real files and allowed", () => {
  const scratch = path.join(wt, ".workit-scratch");
  mkdirSync(scratch, { recursive: true });
  for (const name of [".workit-runs-git", ".workit-live-target"]) {
    expect(write(path.join(scratch, name)), name).toBeUndefined();
    expect(bash(`touch ${path.join(scratch, name)}`), name).toBeUndefined();
    expect(bash(`printf x > ${path.join(scratch, name)}`), name).toBeUndefined();
  }
});

test("Given a path through more than 40 symlinks, each a short chain, When judged, Then each link resolves and a scratch target is allowed", () => {
  const scratch = path.join(wt, ".workit-scratch", "hops");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  let dir = scratch;
  const dirs: string[] = [];
  for (let index = 0; index < 45; index++) {
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    dir = path.join(scratch, `r${index + 1}`);
  }
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < 45; index++)
    symlinkSync(dirs[index + 1], path.join(dirs[index], "n"), linkType);
  symlinkSync(scratch, path.join(lead, "hops-link"), linkType);
  const target = path.join(lead, "hops-link", ...Array(45).fill("n"), "a.txt");
  expect(write(target)).toBeUndefined();
});
