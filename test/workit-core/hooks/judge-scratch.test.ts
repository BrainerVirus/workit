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
    `git -C ${rt} config include.path ${path.join(mainGit, "config")}`,
    'GIT_DIR="$X" git commit -qm x',
  ])
    expect(bash(command), command).toBe("deny");
  for (const command of [
    `git -C ${rt} commit -qm x`,
    `git -C ${rt} config user.name t`,
    `git --git-dir=${path.join(rt, ".git")} --work-tree=${rt} commit -qm x`,
  ])
    expect(bash(command), command).toBeUndefined();
  expect(bash(`GIT_DIR=${path.join(rt, ".git")} git -C ${rt} commit -qm x`)).toBe("deny");
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

test("Given a judge's git, When it sets or inherits config, env or flags that run a command (aliases, hooks, pagers, editors, drivers, filters, helpers, exec path, templates), Then it is denied", () => {
  const scratch = path.join(wt, ".workit-scratch");
  const rt = path.join(scratch, "run");
  git(wt, "init", "-q", "-b", "main", rt);
  for (const command of [
    `git -C ${rt} -c alias.x='!touch /tmp/y' x`,
    `git -C ${rt} config alias.x '!touch /tmp/y'`,
    `git -C ${rt} config set alias.x '!touch /tmp/y'`,
    `git -C ${rt} config core.hooksPath /tmp/h`,
    `git -C ${rt} config core.fsmonitor /tmp/f`,
    `git -C ${rt} config core.pager /tmp/p`,
    `git -C ${rt} config core.sshCommand /tmp/s`,
    `git -C ${rt} config core.editor /tmp/e`,
    `git -C ${rt} config diff.ext.command /tmp/d`,
    `git -C ${rt} config diff.external /tmp/d`,
    `git -C ${rt} config merge.m.driver /tmp/m`,
    `git -C ${rt} config filter.f.clean /tmp/c`,
    `git -C ${rt} config credential.helper /tmp/h`,
    `git -C ${rt} --config-env=core.pager=X log`,
    `git -C ${rt} --exec-path=/tmp/x status`,
    `GIT_EXTERNAL_DIFF=/tmp/d git -C ${rt} diff`,
    `GIT_PAGER=/tmp/p git -C ${rt} log`,
    `GIT_EDITOR=/tmp/e git -C ${rt} commit`,
    `GIT_SSH=/tmp/s git -C ${rt} fetch`,
    `GIT_SSH_COMMAND=/tmp/s git -C ${rt} fetch`,
    `GIT_ASKPASS=/tmp/a git -C ${rt} fetch`,
    `GIT_EXEC_PATH=/tmp/x git -C ${rt} status`,
    `git init --template=/tmp/t ${path.join(scratch, "tpl")}`,
    `git clone -c core.hooksPath=/tmp/h ${rt} ${path.join(scratch, "cl")}`,
    `HOME=${scratch} git -C ${rt} commit -qm x`,
    `XDG_CONFIG_HOME=${scratch} git -C ${rt} commit -qm x`,
    `GIT_CONFIG_GLOBAL=${path.join(scratch, "g")} git -C ${rt} commit -qm x`,
    `GIT_CONFIG_NOSYSTEM=1 git -C ${rt} commit -qm x`,
    `export HOME=${scratch}; git -C ${rt} commit -qm x`,
  ])
    expect(bash(command), command).toBe("deny");
  // A scratch repository whose config already runs a command.
  for (const [key, value] of [
    ["alias.x", "!true"],
    ["core.hooksPath", "/tmp/h"],
    ["filter.f.smudge", "/tmp/s"],
  ]) {
    const armed = path.join(scratch, `armed-${key.replaceAll(".", "-")}`);
    git(wt, "init", "-q", "-b", "main", armed);
    git(armed, "config", key, value);
    expect(bash(`git -C ${armed} commit -qm x`), key).toBe("deny");
  }
  for (const file of [path.join(rt, ".git", "hooks", "pre-commit")]) {
    expect(write(file)).toBe("deny");
    expect(bash(`printf x > ${file}`)).toBe("deny");
  }
});

test("Given a judge's git init or clone with --separate-git-dir, When the git dir is outside scratch, Then it is denied; inside scratch it is allowed", () => {
  const scratch = path.join(wt, ".workit-scratch");
  expect(
    bash(`git init --separate-git-dir=${path.join(root, "sep")} ${path.join(scratch, "sg")}`),
  ).toBe("deny");
  expect(
    bash(`git init --separate-git-dir ${path.join(root, "sep")} ${path.join(scratch, "sg")}`),
  ).toBe("deny");
  expect(
    bash(`git init --separate-git-dir=${path.join(scratch, "sep")} ${path.join(scratch, "sg")}`),
  ).toBeUndefined();
});

test("Given a new dir under scratch, a config key named only as text, or a bare scratch repository, When a judge runs git, Then it is allowed", () => {
  const scratch = path.join(wt, ".workit-scratch");
  const rt = path.join(scratch, "allowed");
  git(wt, "init", "-q", "-b", "main", rt);
  mkdirSync(path.join(scratch, "ni2"), { recursive: true });
  mkdirSync(path.join(scratch, "ni3"), { recursive: true });
  const bare = path.join(scratch, "b.git");
  git(wt, "init", "-q", "--bare", bare);
  for (const command of [
    `mkdir ${path.join(scratch, "ni")} && git -C ${path.join(scratch, "ni")} init`,
    `git -C ${path.join(scratch, "ni2")} init`,
    `cd ${path.join(scratch, "ni3")} && git init`,
    `git -C ${rt} grep core.worktree`,
    `git -C ${rt} log --grep include.path`,
    `git -C ${rt} config --get core.worktree`,
    `git -C ${bare} fetch ${rt}`,
  ])
    expect(bash(command), command).toBeUndefined();
  expect(bash(`git -C ${rt} config core.bare true`)).toBe("deny");
});

test("Given a judge's git, When it uses a verb, option, transport or env outside the allowlist, Then it is denied naming what is allowed", () => {
  const scratch = path.join(wt, ".workit-scratch");
  const rt = path.join(scratch, "allow-rt");
  git(wt, "init", "-q", "-b", "main", rt);
  const remoteOut = path.join(scratch, "remote-out");
  git(wt, "init", "-q", "-b", "main", remoteOut);
  git(remoteOut, "config", "remote.o.url", path.join(root, "elsewhere"));
  const trailer = path.join(scratch, "trailer");
  git(wt, "init", "-q", "-b", "main", trailer);
  git(trailer, "config", "trailer.t.cmd", "touch /tmp/y");
  for (const command of [
    `git -C ${rt} rebase -x 'touch /tmp/y' HEAD~1`,
    `git -C ${rt} bisect run /tmp/x`,
    `git -C ${rt} filter-branch --tree-filter 'touch /tmp/y' HEAD`,
    `git -C ${rt} submodule foreach 'touch /tmp/y'`,
    `git -C ${rt} difftool --extcmd=/tmp/x`,
    `git -C ${rt} fetch --upload-pack=/tmp/x ${wt}`,
    `git clone --upload-pack /tmp/x ${wt} ${path.join(scratch, "c2")}`,
    `git ls-remote --upload-pack=/tmp/x ${wt}`,
    `git -C ${wt} grep -O x`,
    `git -C ${wt} grep --open-files-in-pager=vi x`,
    `git -C ${rt} fetch 'ext::sh -c touch% /tmp/y'`,
    `GIT_ALLOW_PROTOCOL=ext git -C ${rt} fetch x`,
    `git -C ${rt} config submodule.s.update '!touch /tmp/y'`,
    `git -C ${rt} config trailer.t.cmd x`,
    `git -C ${rt} config remote.o.vcs x`,
    `PATH=${scratch}:/usr/bin git -C ${rt} status`,
    `GIT_TRACE=/tmp/t git -C ${rt} status`,
    `git -C ${rt} -c trace2.eventTarget=/tmp/t status`,
    `git -C ${rt} checkout-index --prefix=/tmp/x/ -a`,
    `git -C ${rt} fast-export --export-marks=/tmp/m HEAD`,
    `git -C ${rt} index-pack -o /tmp/x p.pack`,
    `git -C ${wt} log --output=/tmp/x`,
    `git -C ${wt} diff --ext-diff`,
    `git -C ${rt} merge -s custom HEAD`,
    `git clone https://example.invalid/r ${path.join(scratch, "c3")}`,
    `git -C ${rt} fetch ${path.join(root, "elsewhere")}`,
    `git -C ${remoteOut} fetch o`,
    `git -C ${trailer} commit -qm x`,
    `export FOO=1; git -C ${wt} log`,
  ]) {
    const out = verifier("Bash", { command: posix(command) });
    expect(out, command).toBe("deny");
  }
});

test("Given ordinary verifier flows, When a judge runs them, Then each is allowed", () => {
  const scratch = path.join(wt, ".workit-scratch");
  const flow = path.join(scratch, "flow");
  expect(bash(`git init ${flow}`)).toBeUndefined();
  git(wt, "init", "-q", "-b", "main", flow);
  for (const command of [
    `git -C ${flow} add -A`,
    `git -C ${flow} commit -qm x`,
    `git -C ${flow} branch feature/x`,
    `git -C ${flow} config user.name t`,
    `git -C ${flow} config user.email t@t`,
    `git -C ${wt} log --oneline -5`,
    `git -C ${wt} diff HEAD --stat`,
    `git -C ${wt} show HEAD`,
    `git -C ${wt} grep -n core`,
    `git --no-optional-locks -C ${wt} status --short`,
    `GIT_PAGER=cat git -C ${wt} log`,
    `PAGER=cat git -C ${wt} log`,
    `LC_ALL=C git -C ${wt} log`,
    `git --no-pager -C ${wt} log`,
    `git -C ${wt} branch --list`,
    `git -C ${wt} branch -a`,
    `git -C ${wt} worktree list`,
    `git -C ${wt} remote -v`,
    `git -C ${wt} config --get user.name`,
    `git -C ${flow} fetch ${wt} HEAD`,
    `git -C ${flow} worktree add ${path.join(scratch, "flow-wt")} FETCH_HEAD`,
    `git clone ${wt} ${path.join(scratch, "cl2")}`,
  ])
    expect(bash(command), command).toBeUndefined();
});

test("Given a judge's git, When an option is abbreviated, bundled, glued or not in the verb's list, Then it is denied", () => {
  const scratch = path.join(wt, ".workit-scratch");
  const rt = path.join(scratch, "opts");
  git(wt, "init", "-q", "-b", "main", rt);
  for (const command of [
    `git -C ${rt} fetch --upl=/tmp/x ${wt}`,
    `git -C ${wt} grep --open-files-in-p=vi x`,
    `git init --templ=/tmp/t ${path.join(scratch, "t2")}`,
    `git -C ${rt} merge --strat=custom HEAD`,
    `git -C ${wt} grep -Ovi x`,
    `git -C ${wt} grep -nO x`,
    `git clone -u/tmp/x ${wt} ${path.join(scratch, "c4")}`,
    `git -C ${rt} commit --conf=x -qm x`,
    `git -C ${rt} apply --unsafe-paths p.diff`,
    `git -C ${rt} apply --directory=x p.diff`,
    `git -C ${rt} am --directory=x m.mbox`,
    `git -C ${rt} fetch --depth 1 ${path.join(root, "elsewhere")}`,
  ])
    expect(bash(command), command).toBe("deny");
  for (const command of [
    `git clone --depth 1 ${wt} ${path.join(scratch, "c5")}`,
    `git -C ${rt} apply p.diff`,
    `git -C ${wt} log --oneline --stat -n 5 -- a.ts`,
    `git -C ${wt} grep -n -e core -- '*.ts'`,
  ])
    expect(bash(command), command).toBeUndefined();
});

test("Given a judge's git behind an assignment or a wrapper, When only the allowed ones are used, Then it runs; otherwise it is denied", () => {
  const scratch = path.join(wt, ".workit-scratch");
  const rt = path.join(scratch, "wrap");
  git(wt, "init", "-q", "-b", "main", rt);
  for (const command of [
    `FOO=1 timeout 5 git -C ${wt} log`,
    `env FOO=1 git -C ${wt} log`,
    `env git -C ${wt} log`,
    `nohup git -C ${wt} log`,
    `xargs git -C ${rt} commit -qm x`,
    `sudo git -C ${wt} log`,
    `stdbuf -o0 git -C ${wt} log`,
    `find ${rt} -exec git -C ${rt} commit -qm x \\;`,
    `timeout FOO=1 git -C ${wt} log`,
  ])
    expect(bash(command), command).toBe("deny");
  for (const command of [
    `timeout 60 git -C ${wt} log`,
    `nice -n 5 git -C ${wt} log`,
    `time git -C ${wt} log`,
    `command git -C ${wt} log`,
    `GIT_OPTIONAL_LOCKS=0 git -C ${wt} status`,
    `grep -rn git ${path.join(wt, "a.ts")}`,
    `if git -C ${wt} diff --quiet; then echo same; fi`,
  ])
    expect(bash(command), command).toBeUndefined();
});

test("Given more read and scratch-only verbs, When a judge runs them, Then reads pass anywhere and writes only in a scratch repository", () => {
  const scratch = path.join(wt, ".workit-scratch");
  const rt = path.join(scratch, "verbs");
  git(wt, "init", "-q", "-b", "main", rt);
  for (const command of [
    `git -C ${wt} reflog`,
    `git -C ${wt} reflog show`,
    `git -C ${wt} diff-tree -r HEAD`,
    `git -C ${wt} diff-index HEAD`,
    `git -C ${wt} count-objects -v`,
    `git -C ${wt} check-ignore x`,
    `git -C ${wt} var -l`,
    "git version",
    "git --version",
    `git ls-remote ${wt}`,
    `git -C ${rt} remote show ${wt}`,
    `git -C ${rt} cherry-pick HEAD`,
    `git -C ${rt} revert HEAD`,
    `git -C ${rt} rebase main`,
    `git -C ${rt} clean -fd`,
    `git -C ${rt} bisect start`,
    `git -C ${rt} bisect good`,
    `git -C ${rt} reflog expire --all`,
    `git --no-optional-locks -C ${wt} status`,
    `git -C ${rt} status`,
  ])
    expect(bash(command), command).toBeUndefined();
  for (const command of [
    `git -C ${wt} reflog expire --all`,
    `git -C ${wt} cherry-pick HEAD`,
    `git -C ${wt} clean -fd`,
    `git -C ${rt} rebase -x true main`,
    `git -C ${rt} rebase --exec=true main`,
    `git -C ${rt} rebase -s custom main`,
    `git -C ${rt} rebase -i main`,
    `git -C ${rt} bisect run true`,
    "git ls-remote https://example.invalid/r",
    `git -C ${rt} remote show origin`,
    `git -C ${wt} status`,
  ])
    expect(bash(command), command).toBe("deny");
});

test("Given a scratch repository whose config sets init.templateDir, When a judge commits there, Then it is denied; init.defaultBranch is allowed", () => {
  const scratch = path.join(wt, ".workit-scratch");
  const tpl = path.join(scratch, "tpl-cfg");
  git(wt, "init", "-q", "-b", "main", tpl);
  git(tpl, "config", "init.templateDir", "/tmp/t");
  expect(bash(`git -C ${tpl} commit -qm x`)).toBe("deny");
  const ok = path.join(scratch, "default-branch");
  git(wt, "init", "-q", "-b", "main", ok);
  git(ok, "config", "init.defaultBranch", "main");
  expect(bash(`git -C ${ok} commit -qm x`)).toBeUndefined();
});

test("Given a judge's git whose words the shell expands (variables, substitutions, globs, braces, tilde, process substitution), When judged, Then it is denied; single-quoted literals pass", () => {
  const scratch = path.join(wt, ".workit-scratch");
  const rt = path.join(scratch, "expand");
  git(wt, "init", "-q", "-b", "main", rt);
  const out = path.join(root, "out.txt");
  for (const command of [
    `for o in --output=${out}; do git -C ${wt} log $o; done`,
    `git -C ${wt} log $(printf -- --output=${out})`,
    `git -C ${wt} log {--output=x,}`,
    `git -C ${rt} grep -e foo *`,
    `git -C ${wt} log -- "$X"`,
    `git -C ${wt} log \`printf x\``,
    `git -C ${wt} diff ~/x`,
    `git -C ${wt} diff <(echo x)`,
    `git -C ${wt} log a?`,
    `git -C ${wt} log [ab]`,
    `LC_ALL=$X git -C ${wt} log`,
    `f() { git -C ${wt} log "$@"; }; f --output=${out}`,
    `numactl git -C ${wt} log`,
    `{git,log} -C ${wt} --output=x`,
    `g?t -C ${wt} log`,
    `timeout 60 git -C ${wt} -c core.pager=sh log`,
    `nice -n 5 git -C ${wt} log $X`,
    `fakeroot git -C ${wt} log`,
    `unshare git -C ${wt} log`,
    `systemd-run git -C ${wt} log`,
    `chroot / git -C ${wt} log`,
    `ionice git -C ${wt} log`,
    `setpriv git -C ${wt} log`,
    `/usr/bin/numactl /usr/bin/git -C ${wt} log`,
    `hash -p ${path.join(scratch, "evil")} git; git -C ${wt} log`,
    `alias git='sh -c x'; git -C ${wt} log`,
  ])
    expect(bash(command), command).toBe("deny");
  for (const command of [
    `git -C ${wt} log --format='%H %s'`,
    `git -C ${wt} grep -e 'foo*' -- 'src/*.ts'`,
    `grep -rn git ${path.join(wt, "a.ts")}`,
    `echo git`,
  ])
    expect(bash(command), command).toBeUndefined();
});

test("Given git config, remote and bisect reads, When a judge runs them, Then reads pass, a full listing only in a scratch repo, and remotes resolve by their url", () => {
  const scratch = path.join(wt, ".workit-scratch");
  const rt = path.join(scratch, "cfg-read");
  git(wt, "init", "-q", "-b", "main", rt);
  git(rt, "remote", "add", "cand", wt);
  const away = path.join(scratch, "cfg-away");
  git(wt, "init", "-q", "-b", "main", away);
  git(away, "remote", "add", "far", path.join(root, "elsewhere"));
  for (const command of [
    `git -C ${wt} config user.name`,
    `git -C ${rt} config --local --list`,
    `git -C ${rt} remote show cand`,
    `git -C ${rt} ls-remote cand`,
    `git -C ${rt} fetch cand`,
    `git -C ${wt} bisect log`,
    `git -C ${wt} bisect terms`,
    `git -C ${wt} diff --diff-algorithm=histogram --ignore-space-at-eol --word-diff=color --word-diff-regex=. --color-words`,
    `git -C ${wt} blame --contents=${path.join(scratch, "a.ts")} a.ts`,
  ])
    expect(bash(command), command).toBeUndefined();
  for (const command of [
    `git -C ${wt} config --list`,
    `git -C ${wt} config -l`,
    `git -C ${wt} config --local --list`,
    `git -C ${rt} config --list --show-origin`,
    `git -C ${rt} config --global --list`,
    `git -C ${rt} config --system --list`,
    `git -C ${away} remote show far`,
    `git -C ${away} ls-remote far`,
    `git -C ${away} fetch far`,
    `git -C ${rt} fetch nosuchremote`,
    `git -C ${rt} fetch ..`,
    `git -C ${wt} blame --contents=${path.join(root, "x.ts")} a.ts`,
  ])
    expect(bash(command), command).toBe("deny");
});

test("Given a judge's git hidden in a nested script, a shell fed from a pipe, or an executable in scratch or the candidate, When judged, Then it is denied; reading about git is allowed", () => {
  const scratch = path.join(wt, ".workit-scratch");
  mkdirSync(scratch, { recursive: true });
  for (const command of [
    `bash -c 'g=gi; \${g}t -C ${wt} commit -m x'`,
    `sh <<EOF\ng=gi; \\\${g}t -C ${wt} commit -m x\nEOF`,
    `echo $(g=gi; \${g}t -C ${wt} commit -m x)`,
    `sh -c "sh -c 'sh -c \\"sh -c true\\"'"`,
    `printf 'git -C ${wt} commit -m x' | sh`,
    `cat ${path.join(scratch, "x.sh")} | sh`,
    `./git -C ${wt} log`,
    `${path.join(scratch, "git")} -C ${wt} log`,
    `${path.join(wt, "git")} -C ${wt} log`,
    `${path.join(scratch, "tool.sh")}`,
    `timeout 5 ${path.join(scratch, "git")} -C ${wt} log`,
    `BASH_ENV=${path.join(scratch, "x.sh")} bash -c true`,
  ])
    expect(bash(command), command).toBe("deny");
  for (const command of [
    "which git",
    "command -v git",
    "command -V git",
    "type git",
    `test -x ${path.join(scratch, "git")}`,
    `[ -x ${path.join(scratch, "git")} ]`,
    `mkdir -p ${path.join(scratch, "git")}`,
    `ls ${path.join(scratch, "git")}`,
    `cd ${path.join(scratch, "git")} && ls`,
    "/usr/bin/git --version",
    `bash -c 'git -C ${wt} log --oneline'`,
  ])
    expect(bash(command), command).toBeUndefined();
});
