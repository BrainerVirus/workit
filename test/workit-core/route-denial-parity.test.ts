import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore, WorkitCore, type OperationContext } from "@/packages/workit-core/src/core";
import { taskStartRequest } from "@/test/workit-core/task-fixtures";
import { evaluateShellPermission } from "@/packages/workit-opencode/src/v2/permissions";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";
import { handleCodexHook } from "@/packages/workit-codex/hooks/workit-hook";
import { handleCursorHook } from "@/packages/workit-cursor/hooks/workit-hook";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";

// Every test runs every host's hook: over 5 s on macOS CI and on loaded
// Windows runners (#415).
setDefaultTimeout(process.platform === "win32" ? 60_000 : 30_000);

const previousEnv = {
  config: process.env.WORKFLOW_TOOLKIT_CONFIG,
  configDir: process.env.WORKFLOW_TOOLKIT_CONFIG_DIR,
  profile: process.env.WORKFLOW_PROFILE,
  workspace: process.env.WORKFLOW_WORKSPACE_NAME,
};
let configDir: string;
beforeAll(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "workit-route-policy-config-"));
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = configDir;
  delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  delete process.env.WORKFLOW_PROFILE;
  delete process.env.WORKFLOW_WORKSPACE_NAME;
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      branchPolicy: {
        preset: "custom",
        allowed: ["feature/*"],
        protected: ["main"],
      },
    }),
  );
});
afterAll(() => {
  if (previousEnv.config === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  else process.env.WORKFLOW_TOOLKIT_CONFIG = previousEnv.config;
  if (previousEnv.configDir === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
  else process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = previousEnv.configDir;
  if (previousEnv.profile === undefined) delete process.env.WORKFLOW_PROFILE;
  else process.env.WORKFLOW_PROFILE = previousEnv.profile;
  if (previousEnv.workspace === undefined) delete process.env.WORKFLOW_WORKSPACE_NAME;
  else process.env.WORKFLOW_WORKSPACE_NAME = previousEnv.workspace;
  rmSync(configDir, { recursive: true, force: true });
});

const startTask = (root: string, host: OperationContext["caller"]["host"]) => {
  const store = new TaskStore(root);
  const context: OperationContext = {
    root,
    caller: { host, actor: "test-session" },
    callerAttested: true,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  };
  const started = new WorkitCore(store, context).task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
};

// Each adapter returns its denial reason, or null when the command passes.
const opencodeDenial = async (root: string, command: string): Promise<string | null> => {
  const event = {
    action: "shell",
    resources: [command],
    effect: "allow",
    message: undefined,
  };
  evaluateShellPermission(root, event);
  return event.effect === "deny" ? String(event.message) : null;
};

const piDenial = (root: string, command: string): string | null => {
  const result = enforceToolPolicy(
    { toolName: "bash", input: { command } } as never,
    { cwd: root, isProjectTrusted: () => true } as never,
  ) as { block?: boolean; reason?: string } | undefined;
  if (result === undefined) return null;
  expect(result.block).toBe(true);
  return String(result.reason);
};

const codexResult = (root: string, command: string) => {
  const result = handleCodexHook({
    session_id: "session-1",
    cwd: root,
    model: "test",
    permission_mode: "default",
    transcript_path: null,
    hook_event_name: "PreToolUse",
    turn_id: "turn-1",
    tool_use_id: "tool-1",
    tool_name: "bash",
    tool_input: { command },
  });
  return result.hookSpecificOutput as {
    hookEventName: string;
    permissionDecision?: string;
  };
};

const codexDenies = (root: string, command: string): boolean => {
  const result = codexResult(root, command);
  return result.permissionDecision === "deny";
};

const cursorDenies = (root: string, command: string): boolean => {
  const result = handleCursorHook({
    hook_event_name: "beforeShellExecution",
    // The session the other hook-process hosts use: the live-session guard
    // (#274) sees one owner in this shared checkout, not a second session.
    conversation_id: "session-1",
    workspace_roots: [root],
    cwd: root,
    command,
  });
  return result.permission === "deny";
};

const claudeDenies = (root: string, command: string): boolean => {
  const result = dispatchHook(claudeCodeAdapter, {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    cwd: root,
    transcript_path: "/tmp/transcript.jsonl",
    permission_mode: "default",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "toolu_1",
  });
  const output = result.json.hookSpecificOutput as { permissionDecision?: string } | undefined;
  return output?.permissionDecision === "deny";
};

/** Whether each of the five hosts denies `command` run in `root`, by host. */
const denialsByHost = async (root: string, command: string) => ({
  opencode: (await opencodeDenial(root, command)) !== null,
  pi: piDenial(root, command) !== null,
  codex: codexDenies(root, command),
  cursor: cursorDenies(root, command),
  claude_code: claudeDenies(root, command),
});

const allHosts = (denied: boolean) => ({
  opencode: denied,
  pi: denied,
  codex: denied,
  cursor: denied,
  claude_code: denied,
});

/** Run git in `cwd` with a fixed identity; throws on failure. */
const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};

/**
 * A Workit workspace on feature/x with an `origin` (a local bare repository)
 * that has main and feature/x, and `backup`, a second name for origin.
 */
const workspace = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-parity-ws-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  git(root, "switch", "-q", "-c", "feature/x");
  const origin = path.join(root, ".git", "origin.git");
  git(root, "init", "-q", "--bare", origin);
  git(root, "remote", "add", "origin", origin);
  git(root, "remote", "add", "backup", origin);
  git(root, "push", "-q", "origin", "main", "feature/x");
  git(root, "fetch", "-q", "origin");
  mkdirSync(path.join(root, ".git", "workit"), { recursive: true });
  return root;
};

test("Given a Workit workspace, When gh api or glab api merges a PR/MR (any flag order, -X/--method, fields, {owner}/{repo}), Then all five hosts deny it naming workit pr merge", async () => {
  const root = workspace();
  try {
    for (const command of [
      "gh api -X PUT repos/o/r/pulls/1/merge",
      "gh api repos/o/r/pulls/1/merge -X PUT",
      "gh api --method PUT repos/{owner}/{repo}/pulls/12/merge -f merge_method=squash",
      "gh api --method=PUT /repos/o/r/pulls/3/merge",
      "gh api -XPOST repos/:owner/:repo/pulls/3/merge",
      // Fields without -X make it a POST.
      "gh api repos/o/r/pulls/3/merge -f merge_method=squash",
      // --help as another option's value is not a help request.
      "gh api -H --help -X PUT repos/o/r/pulls/3/merge",
      "gh api repos/o/r/merges -f base=main -f head=feature/x",
      `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`,
      "glab api -X PUT projects/1/merge_requests/1/merge",
      "glab api --method POST projects/group%2Frepo/merge_requests/7/merge",
      "glab api projects/:id/merge_requests/2/merge --method=PUT",
    ]) {
      expect(await denialsByHost(root, command), command).toEqual(allHosts(true));
      const reason = String(await opencodeDenial(root, command));
      expect(reason, command).toContain("workit pr merge");
      expect(reason, command).toContain("api` merge");
    }
    // Reads and other API calls keep running.
    for (const command of [
      "gh api repos/o/r/pulls/3/merge",
      "gh api -X GET repos/o/r/pulls/3/merge",
      "gh api repos/o/r/pulls/3",
      "gh api graphql -f query='query { viewer { login } }'",
      "gh api -X PATCH repos/o/r/pulls/3 -f title=x",
      "glab api projects/1/merge_requests/1",
    ])
      expect(await denialsByHost(root, command), command).toEqual(allHosts(false));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "Given a Workit workspace, When a git alias, push.default, remote.<name>.push, a glob refspec or another name for origin pushes onto main, Then all five hosts deny it",
  async () => {
    const root = workspace();
    try {
      git(root, "config", "alias.pp", "push");
      git(root, "config", "branch.feature/x.remote", "origin");
      git(root, "config", "branch.feature/x.merge", "refs/heads/main");
      const origin = path.join(root, ".git", "origin.git").replaceAll("\\", "/");
      for (const command of [
        "git pp origin HEAD:main",
        "git -c alias.p=push p origin HEAD:main",
        "git -c alias.p='!git push origin HEAD:main' p",
        "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p origin HEAD:main",
        "git -c help.autocorrect=immediate puhs origin HEAD:main",
        // feature/x tracks main: push.default=upstream pushes onto it.
        "git -c push.default=upstream push",
        "git -c push.default=matching push origin",
        "git -c remote.origin.push=HEAD:main push",
        "git push origin 'refs/heads/*:refs/heads/*'",
        "git push backup HEAD:main",
        `git push '${origin}' HEAD:main`,
        `git -c url.${path.posix.dirname(origin)}/.insteadOf=zz: push zz:origin.git HEAD:main`,
        "git push origin HEAD:heads/main",
        // Quoting and nested scripts hide the tool's name from a text match.
        "g''it push origin HEAD:main",
        "pwsh -c git push origin HEAD:main",
        "echo 'git push origin HEAD:main' | bash",
        // A dry run undone, wrappers with option values, a computed remote.
        "git push --dry-run --no-dry-run origin HEAD:main",
        "nice -n 5 git push origin HEAD:main",
        "timeout -s KILL 30 git push origin HEAD:main",
        "env -S 'git push origin HEAD:main'",
        'git push "$(git remote get-url origin)" HEAD:main',
      ])
        expect(await denialsByHost(root, command), command).toEqual(allHosts(true));
      for (const command of [
        "git pp origin feature/x",
        "git push",
        "git push origin",
        "git -c push.default=current push",
        "git push origin 'refs/heads/feature/*:refs/heads/feature/*'",
        "git push backup feature/x",
        "git push --dry-run origin HEAD:main",
        "git push -u origin $(git branch --show-current)",
      ])
        expect(await denialsByHost(root, command), command).toEqual(allHosts(false));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // It runs every host's hook: Linux ~0.8 s, macOS CI over 5 s, a parallel
    // Windows shard 31 s (2026-10-28, #415).
  },
  process.platform === "win32" ? 90_000 : 30_000,
);

test("Given a Workit workspace, When a deferred branch-creation form (#277 ruling mv7kwhzy) names a new off-policy branch, Then all five hosts deny it; an existing or compliant name passes", async () => {
  const root = workspace();
  try {
    git(root, "config", "alias.nb", "switch -c");
    const encoded = Buffer.from("git switch -c chore/x", "utf16le").toString("base64");
    for (const command of [
      "git nb chore/x",
      "git -c alias.nb='switch -c' nb chore/x",
      "git -c alias.nb='!git switch -c' nb chore/x",
      "git stash branch chore/x",
      "git update-ref refs/heads/chore/x HEAD",
      "printf 'create refs/heads/chore/x HEAD\\n' | git update-ref --stdin",
      "git fetch origin main:chore/x",
      "git fetch origin +refs/heads/main:refs/heads/chore/x",
      "git pull origin main:chore/x",
      "git fetch . HEAD:chore/x",
      "git push . HEAD:chore/x",
      "git symbolic-ref HEAD refs/heads/chore/x",
      'eval "git switch -c chore/x"',
      "echo chore/x | xargs git switch -c",
      "echo chore/x | xargs -I{} git checkout -b {}",
      "{ git switch -c chore/x; }",
      "if true; then git switch -c chore/x; fi",
      'for b in chore/x; do git switch -c "$b"; done',
      "B=chore/x; git switch -c $B",
      'pwsh -Command "git switch -c chore/x"',
      "powershell -NoProfile -c git checkout -b chore/x",
      `pwsh -EncodedCommand ${encoded}`,
      `git -c alias.nb='!f() { git switch -c "$1"; }; f' nb chore/x`,
      "echo 'git switch -c chore/x' | pwsh -Command -",
      "x=$(git switch -c chore/x)",
      "bash -c -- 'git switch -c chore/x'",
    ])
      expect(await denialsByHost(root, command), command).toEqual(allHosts(true));
    for (const command of [
      "git nb feature/ok",
      `git -c alias.nb='!f() { git switch -c "$1"; }; f' nb feature/ok`,
      "git stash branch feature/ok",
      "git update-ref refs/heads/feature/x HEAD",
      "git update-ref -d refs/heads/chore/old",
      "git fetch origin main:feature/x",
      "git fetch origin main",
      "git fetch origin 'refs/heads/*:refs/remotes/origin/*'",
      "git symbolic-ref HEAD",
      "git symbolic-ref HEAD refs/heads/main",
      "echo feature/ok | xargs git switch -c",
      "for b in a b; do git log -1 $b; done",
      'pwsh -Command "git status"',
      "git stash list",
      'echo "git switch -c chore/x"',
    ])
      expect(await denialsByHost(root, command), command).toEqual(allHosts(false));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all adapters enforce the branch policy on every raw branch-creation form", async () => {
  for (const hasTask of [false, true]) {
    const root = mkdtempSync(path.join(tmpdir(), "workit-parity-"));
    try {
      if (hasTask) startTask(root, "opencode");
      for (const [command, rule] of [
        ["git checkout -b main", "protected_ref"],
        ["git switch -c feature/raw", null],
        ["git checkout -b feature/raw", null],
        ["git status --short", null],
        ["gh pr create --fill", null],
        ["git worktree add --detach ../other", null],
        // A path alone names the branch after it.
        ["git worktree add ../other", "allowed_pattern"],
        ['git checkout -b "main"', "protected_ref"],
        // The 2026-10 ui-kit form that slipped through: a compound command
        // with cd, a start point and a trailing --no-track.
        [
          "git fetch origin develop -q && git switch -c chore/x origin/develop --no-track; git log --oneline -1",
          "allowed_pattern",
        ],
        ["GIT_TRACE=0 git branch chore/y origin/main", "allowed_pattern"],
        ["git worktree add -b fix/z ../wt origin/main", "allowed_pattern"],
        ["git switch -cchore/attached", "allowed_pattern"],
        // A directory that does not exist yet (a clone, git init) is not judged.
        ["git init fresh && cd fresh && git switch -c wip", null],
        ["cd sub && git switch -c feature/ok origin/develop --no-track", null],
      ] as const) {
        const denied = rule !== null;
        const opencode = await opencodeDenial(root, command);
        const pi = piDenial(root, command);
        expect(opencode !== null, `opencode ${command}`).toBe(denied);
        expect(pi !== null, `pi ${command}`).toBe(denied);
        if (rule) {
          expect(opencode, `opencode ${command}`).toContain(rule);
          expect(pi, `pi ${command}`).toContain(rule);
        }
        expect(codexDenies(root, command), `codex ${command}`).toBe(denied);
        expect(cursorDenies(root, command), `cursor ${command}`).toBe(denied);
        expect(claudeDenies(root, command), `claude_code ${command}`).toBe(denied);
      }
      expect(codexResult(root, "git status --short")).toEqual({
        hookEventName: "PreToolUse",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Given a Workit workspace, When a command hides its git under a comment quote, a brace list, another directory spelling or shell construct (review mv828t3f), Then all five hosts deny it", async () => {
  const root = workspace();
  try {
    const origin = path.join(root, ".git", "origin.git").replaceAll("\\", "/");
    const top = root.replaceAll("\\", "/");
    for (const command of [
      // A quote inside a comment no longer hides the rest.
      "true # don't worry\ngit push origin HEAD:main",
      // Bash drops the empty word: this runs `git push`.
      "{git,} push origin HEAD:main",
      // --all and --branches push the local main too.
      "git push --all origin",
      "git push --branches origin",
      // The repository named from another directory, or as the cwd.
      `cd /tmp && git --git-dir=${top}/.git push origin HEAD:main`,
      `cd /tmp && GIT_DIR=${top}/.git git push origin HEAD:main`,
      `export GIT_DIR=${top}/.git; cd /tmp && git push origin HEAD:main`,
      'git -C "$PWD" push origin HEAD:main',
      'git -C "$(git rev-parse --show-toplevel)" push origin HEAD:main',
      'cd "$PWD" && git push origin HEAD:main',
      // State set earlier in the same command.
      `git remote add up ${origin} && git push up HEAD:main`,
      "git config alias.zz 'push origin HEAD:main' && git zz",
      // A computed name whose literal default is main.
      'git push origin "HEAD:${UNSET:-main}"',
      // Shell constructs that run their command.
      "function f { git push origin HEAD:main; }; f",
      "coproc git push origin HEAD:main",
      "trap 'git push origin HEAD:main' EXIT",
      "source <(echo 'git push origin HEAD:main')",
      "bash <(echo 'git push origin HEAD:main')",
      "(( x = 1 << 2 ))\ngit push origin HEAD:main",
      "sudo -iu root git push origin HEAD:main",
      "taskset 1 git push origin HEAD:main",
      "script -qc 'git push origin HEAD:main' /dev/null",
      "parallel git push origin ::: HEAD:main",
      "watch -n1 git push origin HEAD:main",
      // Other git pushes.
      "git subtree push --prefix=x origin main",
      `git send-pack ${origin} HEAD:refs/heads/main`,
    ])
      expect(await denialsByHost(root, command), command).toEqual(allHosts(true));
    for (const command of [
      "git status # then git push origin HEAD:main",
      "((echo hi) )",
      "git push origin HEAD:$BRANCH",
      'git push origin "HEAD:${TARGET:-feature/x}"',
      "git config --get alias.zz",
      "git remote add up ../elsewhere.git && git push up HEAD:main",
    ])
      expect(await denialsByHost(root, command), command).toEqual(allHosts(false));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Given a GitHub origin, When a push names it with other case, a leading slash or www, Then all five hosts deny a push onto main", async () => {
  const root = workspace();
  try {
    git(root, "remote", "set-url", "origin", "https://github.com/Owner/Repo.git");
    for (const command of [
      "git push https://github.com/owner/repo HEAD:main",
      "git push git@github.com:/Owner/Repo.git HEAD:main",
      "git push https://www.github.com/Owner/Repo HEAD:main",
    ])
      expect(await denialsByHost(root, command), command).toEqual(allHosts(true));
    expect(await denialsByHost(root, "git push https://github.com/owner/fork HEAD:main")).toEqual(
      allHosts(false),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Given a Workit workspace, When a forge merge stands behind -R, a doubled slash or a stdin body, Then all five hosts deny it", async () => {
  const root = workspace();
  try {
    for (const command of [
      "gh pr -R o/r merge 1",
      "gh pr --repo o/r merge 1",
      "glab mr -R o/r merge 1",
      "gh api -X PUT repos/o/r/pulls/1//merge",
      "gh api -iXPUT repos/o/r/pulls/1/merge",
      "gh api graphql -F query=@- <<'EOF'\nmutation { mergePullRequest(input:{pullRequestId:\"x\"}) { clientMutationId } }\nEOF",
      `echo '{"query":"mutation { mergePullRequest(input:{pullRequestId:1}){clientMutationId} }"}' | gh api graphql --input -`,
      "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input:{pullRequestId:\"x\"}) { clientMutationId } }'",
      'glab api graphql -f query=\'mutation { mergeRequestAccept(input:{projectPath:"o/r", iid:"1"}) { errors } }\'',
      "stdbuf -oL git push origin HEAD:main",
    ])
      expect(await denialsByHost(root, command), command).toEqual(allHosts(true));
    for (const command of [
      "gh pr -R o/r view 1",
      "gh api graphql -F query=@- <<<'query { viewer { login } }'",
    ])
      expect(await denialsByHost(root, command), command).toEqual(allHosts(false));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Given a PR body in a quoted heredoc substitution, When it mentions raw commands in backticks after `1)` or `:)`, Then no host denies it (review M1)", async () => {
  const root = workspace();
  try {
    for (const command of [
      "gh pr create --title 'x' --body \"$(cat <<'EOF'\n## Summary\n1) Run `gh pr merge` only via workit\n2) `git push origin HEAD:main` is denied\nEOF\n)\"",
      "workit pr create --title x --body \"$(cat <<'EOF'\nNote :) then `gh pr merge 1` here\nEOF\n)\"",
      'gh pr create --title x --body "$(cat <<\'EOF\'\nquote "it\'s" (see 3) `git push origin main`\nEOF\n)"',
      'gh pr create --title x --body "$(cat <<EOF\na) b) c) `gh pr merge 2`\nEOF\n)"',
      "gh pr create --title x --body \"$(printf '%s\\n' '1) `gh pr merge 1`')\"",
    ])
      expect(await denialsByHost(root, command), command).toEqual(allHosts(false));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Given a pathological command, When any host analyzes it, Then it answers in bounded time, and one it cannot analyze is denied with an unblock (review B1)", async () => {
  const root = workspace();
  try {
    const bomb = `echo ${"{a,b}".repeat(22)}; git push origin HEAD:main`;
    const nested = `echo ${"{".repeat(3000)}a,b${"}".repeat(3000)}; git push origin HEAD:main`;
    for (const command of [bomb, nested]) {
      const started = performance.now();
      expect(claudeDenies(root, command)).toBe(true);
      // Unbounded expansion took ~17 s; 500 ms leaves room for slow CI runners.
      expect(performance.now() - started).toBeLessThan(500);
      expect(await denialsByHost(root, command)).toEqual(allHosts(true));
    }
    const deep = `echo ${"$(".repeat(100)}true${")".repeat(100)}`;
    expect(await denialsByHost(root, deep)).toEqual(allHosts(true));
    const reason = String(await opencodeDenial(root, deep));
    expect(reason).toContain("could not analyze");
    const claude = dispatchHook(claudeCodeAdapter, {
      hook_event_name: "PreToolUse",
      session_id: "session-1",
      cwd: root,
      tool_name: "Bash",
      tool_input: { command: deep },
      tool_use_id: "toolu_1",
    }).json.hookSpecificOutput as { permissionDecisionReason?: string };
    expect(claude.permissionDecisionReason).toContain("Split it into simpler commands");
    // An everyday brace list still expands and runs.
    expect(await denialsByHost(root, "mkdir -p src/{core,hooks}/{a,b}")).toEqual(allHosts(false));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
