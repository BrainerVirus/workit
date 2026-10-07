// Audit B1/B2: raw git/forge commands on an agent's shell. Inside a Workit
// workspace a gate bypass (`gh pr merge`, a push onto a protected branch) is
// denied with the workit command to run instead; routine raw delivery
// commands run with a short nudge; a raw commit is recorded for the session
// so its own verdict is not independent. Hooks fail open.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  dispatchHook,
} from "@/packages/workit-core/src/hooks/index";
import { rawAction, rawInvocations } from "@/packages/workit-core/src/hooks/raw-git";
import {
  appendObserved,
  checkVerdicts,
  readLedger,
  recordVerdict,
} from "@/packages/workit-core/src/ledger";
import { evaluateShellPermission } from "@/packages/workit-opencode/src/v2/permissions";
import { observeShellBefore, observeShellResult } from "@/packages/workit-opencode/src/v2/shell";
import { enforceToolPolicy, observeToolResult } from "@/packages/workit-pi/src/tools";
import { fixture, tempRoot, withProtectedMain } from "./hook-fixtures";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};

/** A checkout on `branch` (main exists too); `store` makes it a Workit workspace. */
const repo = (options: { branch?: string; store?: boolean; at?: string } = {}) => {
  const root = options.at ?? tempRoot("workit-raw-git-");
  if (!options.at) roots.push(root);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  if (options.branch) git(root, "checkout", "-q", "-b", options.branch);
  if (options.store !== false) mkdirSync(path.join(root, ".git", "workit"), { recursive: true });
  return root;
};

const commitFile = (root: string, name: string, extra: string[] = []) => {
  writeFileSync(path.join(root, name), `${name}\n`);
  git(root, "add", name);
  git(root, "commit", "-q", "-m", `feat: ${name}`, ...extra);
  return git(root, "rev-parse", "HEAD");
};

/** Single-quoted for a posix shell (Windows paths keep their backslashes). */
const sq = (value: string) => `'${value}'`;

const claude = (
  cwd: string,
  command: string,
  event = "PreToolUse",
  extra: Record<string, unknown> = {},
) =>
  dispatchHook(claudeCodeAdapter, {
    hook_event_name: event,
    session_id: "s-lead",
    cwd,
    tool_name: "Bash",
    tool_input: { command },
    ...extra,
  });

type ClaudeOut = {
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
};
const claudeOut = (cwd: string, command: string, extra: Record<string, unknown> = {}) =>
  (claude(cwd, command, "PreToolUse", extra).json as ClaudeOut).hookSpecificOutput;

const commitRows = (root: string) => {
  const ledger = readLedger(root);
  if (!ledger.ok) return [];
  return ledger.value.rows.filter((row) => row.type === "commit.recorded");
};

// ---------------------------------------------------------------------------
// classification (pure string parsing)

const classify = (command: string, dialect: "posix" | "powershell" = "posix") =>
  rawInvocations(command, dialect).map((invocation) => ({
    dir: invocation.dir,
    action: rawAction(invocation),
  }));

const commit = { kind: "commit" as const, amend: false };
const push = (targets: Array<string | null>, remote: string | null, blindForce = false) => ({
  kind: "push" as const,
  targets,
  blindForce,
  remote,
});

test("classification: chains, cd, -C, env prefixes, quoting and bash -c find the raw command and its directory", () => {
  const table: Array<[string, unknown]> = [
    [
      "git status && git log --oneline -3",
      [
        { dir: null, action: null },
        { dir: null, action: null },
      ],
    ],
    [
      "git fetch origin; git diff main",
      [
        { dir: null, action: null },
        { dir: null, action: null },
      ],
    ],
    [`git commit -m "fix: a; b && c"`, [{ dir: null, action: commit }]],
    [`git commit -m "say \\"hi\\" && go"`, [{ dir: null, action: commit }]],
    ["git commit --amend --no-edit", [{ dir: null, action: { kind: "commit", amend: true } }]],
    ["cd sub && git commit -qam x", [{ dir: "sub", action: commit }]],
    ["git -C ../other commit -m x", [{ dir: "../other", action: commit }]],
    ["cd a && git -C b commit -m x", [{ dir: path.join("a", "b"), action: commit }]],
    [
      "GIT_AUTHOR_NAME=x FOO=1 git -c core.editor=true commit -m y",
      [{ dir: null, action: commit }],
    ],
    ["/usr/bin/git commit -m y", [{ dir: null, action: commit }]],
    [
      "bash -lc 'cd repo && gh pr merge 5 --squash'",
      [{ dir: "repo", action: { kind: "merge", forge: "gh" } }],
    ],
    ["glab mr merge 3", [{ dir: null, action: { kind: "merge", forge: "glab" } }]],
    ["gh pr create --fill", [{ dir: null, action: { kind: "pr-create", forge: "gh" } }]],
    ["gh pr checks 7 --watch", [{ dir: null, action: { kind: "pr-read", forge: "gh" } }]],
    ["gh issue list", [{ dir: null, action: null }]],
    ["git push --force origin HEAD:main", [{ dir: null, action: push(["main"], "origin", true) }]],
    [
      "git push --force-with-lease origin +feature/x",
      [{ dir: null, action: push(["feature/x"], "origin") }],
    ],
    [
      "git push -u origin feature/x:refs/heads/main",
      [{ dir: null, action: push(["main"], "origin") }],
    ],
    ["git push --repo=origin HEAD:main", [{ dir: null, action: push(["main"], "origin") }]],
    ["git push --repo origin main", [{ dir: null, action: push(["main"], "origin") }]],
    ["git push", [{ dir: null, action: push([null], null) }]],
    ["git push origin --tags", [{ dir: null, action: push([], "origin") }]],
    ["echo git commit", []],
    ["grep -r 'git push' .", []],
    // Help and dry runs change nothing.
    ["gh pr merge --help", [{ dir: null, action: null }]],
    ["gh pr merge -h", [{ dir: null, action: null }]],
    ["git push --help", [{ dir: null, action: null }]],
    ["git push --dry-run origin HEAD:main", [{ dir: null, action: null }]],
    ["git push -n origin HEAD:main", [{ dir: null, action: null }]],
    ["git commit --dry-run -m x", [{ dir: null, action: null }]],
    ["git help push", [{ dir: null, action: null }]],
    ["gh pr help", [{ dir: null, action: null }]],
    // `help` or `-h` as an option's value is no help request.
    ["git commit -m help", [{ dir: null, action: commit }]],
    ["git commit -m -h", [{ dir: null, action: commit }]],
    [
      'gh pr create --title help --body "-h"',
      [{ dir: null, action: { kind: "pr-create", forge: "gh" } }],
    ],
    ["glab mr merge 3 -m --help", [{ dir: null, action: { kind: "merge", forge: "glab" } }]],
    ["git push origin help", [{ dir: null, action: push(["help"], "origin") }]],
    ["git commit -m x -- --help", [{ dir: null, action: commit }]],
    // A subshell's cd ends with it; pushd/popd is a stack.
    [
      "(cd ../other && git status); git push",
      [
        { dir: "../other", action: null },
        { dir: null, action: push([null], null) },
      ],
    ],
    [
      "pushd ../other && git commit -m x && popd && git push",
      [
        { dir: "../other", action: commit },
        { dir: null, action: push([null], null) },
      ],
    ],
    [
      "echo $(cd ../other && git status) && git push",
      [
        { dir: "../other", action: null },
        { dir: null, action: push([null], null) },
      ],
    ],
    // A directory that cannot be known gets no decision.
    ["cd - && git push", [{ dir: undefined, action: push([null], null) }]],
    ["cd $REPO && git push", [{ dir: undefined, action: push([null], null) }]],
    ["popd && git push", [{ dir: undefined, action: push([null], null) }]],
  ];
  for (const [command, expected] of table)
    expect(classify(command) as unknown, command).toEqual(expected);
});

test("classification: PowerShell keeps backslashes as path separators and uses its own quoting", () => {
  expect(classify(String.raw`git -C C:\repo push origin main`, "powershell")).toEqual([
    { dir: String.raw`C:\repo`, action: push(["main"], "origin") },
  ]);
  // The same text in a posix shell escapes the `r`.
  expect(classify(String.raw`git -C C:\repo push origin main`)[0].dir).toBe("C:repo");
  expect(
    classify("Set-Location 'C:\\work\\it''s'; git commit -m \"say `\"hi`\"\"", "powershell"),
  ).toEqual([{ dir: String.raw`C:\work\it's`, action: commit }]);
  expect(
    classify(String.raw`Push-Location "D:\a b"; git push; Pop-Location; git push`, "powershell"),
  ).toEqual([
    { dir: String.raw`D:\a b`, action: push([null], null) },
    { dir: null, action: push([null], null) },
  ]);
});

// ---------------------------------------------------------------------------
// pre-tool decisions

test("G a Workit workspace, W gh pr merge, glab mr merge or a push onto main, T denied with the workit command", async () => {
  await withProtectedMain(() => {
    const root = repo({ branch: "feature/x" });
    for (const command of ["gh pr merge 5 --squash", "cd . && glab mr merge 3"]) {
      const out = claudeOut(root, command);
      expect(out?.permissionDecision, command).toBe("deny");
      expect(out?.permissionDecisionReason, command).toContain("workit pr merge");
    }
    for (const command of [
      "git push --force origin HEAD:main",
      "git push origin feature/x:main",
      "git push origin --delete main",
      "git push --repo=origin HEAD:main",
    ]) {
      const out = claudeOut(root, command);
      expect(out?.permissionDecision, command).toBe("deny");
      expect(out?.permissionDecisionReason, command).toContain(
        "workit git push --force-with-lease",
      );
    }
    // A bare push targets the checked-out branch: refused on main, nudged on a feature branch.
    const onMain = repo();
    expect(claudeOut(onMain, "git push")?.permissionDecision).toBe("deny");
    expect(claudeOut(root, "git push")?.permissionDecision).toBeUndefined();
  });
});

test("G help, a dry run or a fork remote, T never denied", async () => {
  await withProtectedMain(() => {
    const root = repo({ branch: "feature/x" });
    git(root, "remote", "add", "origin", path.join(root, "origin.git"));
    git(root, "remote", "add", "fork", path.join(root, "fork.git"));
    for (const command of [
      "gh pr merge --help",
      "git push --help",
      "git push --dry-run origin HEAD:main",
      "git push -n origin HEAD:main",
    ])
      expect(claude(root, command).json, command).toEqual({});
    const fork = claudeOut(root, "git push fork main");
    expect(fork?.permissionDecision).toBeUndefined();
    expect(fork?.additionalContext).toContain("workit git push");
    expect(claudeOut(root, "git push origin main")?.permissionDecision).toBe("deny");
  });
});

test("G a feature branch and a sibling repo on main, W the sibling is entered only in a subshell or pushd/popd, T the push is nudged, not denied", async () => {
  await withProtectedMain(() => {
    const parent = tempRoot("workit-raw-git-pair-");
    roots.push(parent);
    const root = repo({ branch: "feature/x", at: path.join(parent, "work") });
    repo({ at: path.join(parent, "other") });
    for (const command of [
      "(cd ../other && git status); git push",
      "pushd ../other && git status && popd && git push",
    ]) {
      const out = claudeOut(root, command);
      expect(out?.permissionDecision, command).toBeUndefined();
      expect(out?.additionalContext, command).toContain("workit git push");
    }
    // Without the subshell the push really runs in the sibling, on main.
    expect(claudeOut(root, "cd ../other && git push")?.permissionDecision).toBe("deny");
    // `cd -` leaves the directory unknown: no decision at all.
    expect(claude(root, "cd ../other && cd - && git push").json).toEqual({});
  });
});

test("G Claude Code's PowerShell tool, W git -C <path with a backslash> push onto main, T the path is read as PowerShell does", async () => {
  await withProtectedMain(() => {
    const parent = tempRoot("workit-raw-git-ps-");
    roots.push(parent);
    // `a\b`: nested directories on Windows, one directory name elsewhere.
    const at =
      process.platform === "win32" ? path.join(parent, "a", "b") : path.join(parent, "a\\b");
    repo({ branch: "feature/x", at });
    const command = String.raw`git -C a\b push origin HEAD:main`;
    const powershell = claudeOut(parent, command, { tool_name: "PowerShell" });
    expect(powershell?.permissionDecision).toBe("deny");
    // Bash reads `a\b` as `ab`, which is no repository.
    expect(claude(parent, command).json).toEqual({});
  });
});

test("G a Workit workspace, W routine raw delivery commands, T they run with a nudge naming the workit equivalent", async () => {
  await withProtectedMain(() => {
    const root = repo({ branch: "feature/x" });
    const nudges: Array<[string, string]> = [
      ["git commit -qam 'feat: x'", "workit git commit -m"],
      ["git push -u origin feature/x", "workit git push"],
      ["git push --force origin feature/x", "workit git push --force-with-lease"],
      ["gh pr create --fill", "workit pr create"],
      ["gh pr view 4 && gh pr checks 4", "workit pr status"],
      ["glab mr create --fill", "workit pr create"],
    ];
    // A commit whose message is "help" is still a commit.
    nudges.push(["git commit -m help", "workit git commit -m"]);
    for (const [command, verb] of nudges) {
      const out = claudeOut(root, command);
      expect(out?.permissionDecision, command).toBeUndefined();
      expect(out?.additionalContext, command).toContain(verb);
    }
    for (const command of ["git status", "git log -3", "git diff main", "git fetch origin"])
      expect(claude(root, command).json, command).toEqual({});
  });
});

test("G a repository Workit does not manage, W gh pr merge or a push onto main, T no decision", async () => {
  await withProtectedMain(() => {
    const root = repo({ store: false });
    for (const command of ["gh pr merge 5", "git push origin HEAD:main", "git commit -m x"])
      expect(claude(root, command).json, command).toEqual({});
  });
});

test("G a workspaces.json entry matching the checkout (no store yet), T it is a Workit workspace", async () => {
  await withProtectedMain((configDir) => {
    const root = repo({ store: false });
    writeFileSync(
      path.join(configDir, "workspaces.json"),
      JSON.stringify({ workspaces: [{ name: "w", glob: `${root.replaceAll("\\", "/")}/**` }] }),
    );
    expect(claudeOut(root, "gh pr merge 2")?.permissionDecision).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// per-host output shapes

test("each host renders the deny on its own channel and the nudge without granting permission", async () => {
  await withProtectedMain(() => {
    const root = repo({ branch: "feature/x" });
    const codex = (command: string) =>
      dispatchHook(
        codexAdapter,
        fixture("codex", "pre-tool-use-bash", root, { tool_input: { command } }),
        {},
      );
    expect(codex("gh pr merge 1").json).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("workit pr merge"),
      },
    });
    expect(codex("git commit -m x").json).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: expect.stringContaining("workit git commit"),
      },
    });

    const cursor = (command: string) =>
      dispatchHook(cursorAdapter, fixture("cursor", "before-shell-execution", root, { command }));
    const denied = cursor("gh pr merge 1");
    expect(denied.exitCode).toBe(2);
    expect(denied.json).toMatchObject({
      permission: "deny",
      agent_message: expect.stringContaining("workit pr merge"),
    });
    const nudged = cursor("git commit -m x");
    expect(nudged.exitCode).toBe(0);
    // Cursor's shell has no session id: the nudge names the conversation's.
    expect(nudged.json).toEqual({
      permission: "allow",
      agent_message: expect.stringMatching(/WORKIT_SESSION_ID=\S+ workit git commit/),
    });

    const opencode = (command: string, workdirs?: Map<string, string>) => {
      const event = { sessionID: "ses_1", action: "shell", resources: [command], effect: "allow" };
      evaluateShellPermission(root, event, workdirs);
      return event as typeof event & { message?: string };
    };
    expect(opencode("gh pr merge 1")).toMatchObject({
      effect: "deny",
      message: expect.stringContaining("workit pr merge"),
    });
    expect(opencode("git commit -m x").effect).toBe("allow");
    // The shell tool's workdir (noted by execute.before) is where `git push` runs.
    const onMain = repo();
    expect(opencode("git push").effect).toBe("allow");
    expect(opencode("git push", new Map([["ses_1", onMain]])).effect).toBe("deny");

    const ctx = {
      cwd: root,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "pi-1" },
    };
    expect(
      enforceToolPolicy(
        { toolName: "bash", input: { command: "glab mr merge 2" } } as never,
        ctx as never,
      ),
    ).toEqual({ block: true, reason: expect.stringContaining("workit pr merge") });
    expect(
      enforceToolPolicy(
        { toolName: "bash", input: { command: "git commit -m x" } } as never,
        ctx as never,
      ),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// recording raw commits (B2)

const asLead = { host: "claude_code", session: "s-lead", agentId: null };

/** Claude PreToolUse, `run` (the command's effect), then PostToolUse, one tool-use id. */
const claudeCall = (cwd: string, command: string, run: () => void, session = "s-lead") => {
  const ids = { tool_use_id: `tu-${Math.random().toString(36).slice(2)}`, session_id: session };
  claude(cwd, command, "PreToolUse", ids);
  run();
  return claude(cwd, command, "PostToolUse", { ...ids, tool_response: { stdout: "" } });
};

test("G a raw commit and no hook record, T the author's own verdict reads as independent (the gap this closes)", async () => {
  await withProtectedMain(() => {
    const root = repo({ branch: "feature/x" });
    commitFile(root, "a.txt");
    expect(recordVerdict({ cwd: root, actor: asLead }, { result: "verified", how: "x" }).ok).toBe(
      true,
    );
  });
});

test("G Claude Pre/PostToolUse around a raw git commit, T commit.recorded names the session and its verdict is not independent", async () => {
  await withProtectedMain(() => {
    const root = repo({ branch: "feature/x" });
    let sha = "";
    const post = claudeCall(root, "git commit -m 'feat: a.txt'", () => {
      sha = commitFile(root, "a.txt");
    });
    expect(post.json).toEqual({});
    expect(commitRows(root)).toEqual([
      expect.objectContaining({
        branch: "feature/x",
        sha,
        session: "s-lead",
        observer: "host_hook",
        actor: expect.objectContaining({ host: "claude_code", session: "s-lead" }),
      }),
    ]);
    // The marker is spent: a repeated PostToolUse records nothing more.
    claude(root, "git commit -m 'feat: a.txt'", "PostToolUse");
    expect(commitRows(root)).toHaveLength(1);

    const refused = recordVerdict({ cwd: root, actor: asLead }, { result: "verified", how: "x" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("author_verdict");
    const ledger = readLedger(root);
    if (!ledger.ok) throw new Error(ledger.error);
    expect(checkVerdicts(root, "feature/x", ledger.value.rows).authors).toEqual(["s-lead"]);
    expect(
      recordVerdict(
        { cwd: root, actor: { ...asLead, session: "s-lead-v1" } },
        { result: "verified", how: "ran it" },
      ).ok,
    ).toBe(true);
  });
});

test("G a raw commit whose message is help, T it is still recorded for the session", async () => {
  await withProtectedMain(() => {
    const root = repo({ branch: "feature/x" });
    let sha = "";
    claudeCall(root, "git commit -m help", () => {
      sha = commitFile(root, "help.txt");
    });
    expect(commitRows(root)).toEqual([expect.objectContaining({ sha, session: "s-lead" })]);
  });
});

test("G a raw commit that fails (also behind || true), T nothing is recorded, even with a recent HEAD", async () => {
  await withProtectedMain(() => {
    const root = repo({ branch: "feature/x" });
    commitFile(root, "recent.txt"); // someone's commit, seconds ago
    for (const command of [
      "git commit -m 'feat: nothing'",
      "git commit -m 'feat: nothing' || true",
    ])
      claudeCall(root, command, () => {
        // Nothing staged: the commit fails and HEAD stays.
        spawnSync("git", ["commit", "-q", "-m", "feat: nothing"], { cwd: root });
      });
    expect(commitRows(root)).toEqual([]);
  });
});

test("G a PostToolUse with no PreToolUse note, T nothing is recorded", async () => {
  await withProtectedMain(() => {
    const root = repo({ branch: "feature/x" });
    commitFile(root, "b.txt");
    claude(root, "git commit -m x", "PostToolUse", { tool_use_id: "never-noted" });
    expect(commitRows(root)).toEqual([]);
  });
});

test("G another session commits during this session's failing commit, T this session records nothing", async () => {
  await withProtectedMain(() => {
    const root = repo({ branch: "feature/x" });
    // Another session's workit commit: a Workit-Session trailer names it.
    claudeCall(root, "git commit -m 'feat: mine' || true", () => {
      commitFile(root, "theirs.txt", ["--trailer", "Workit-Session: s-other"]);
    });
    // Another session's raw commit its own hook already recorded.
    claudeCall(root, "git commit -m 'feat: mine' || true", () => {
      const sha = commitFile(root, "theirs2.txt");
      const row = appendObserved(root, {
        type: "commit.recorded",
        actor: { host: "codex_cli", session: "s-other2", agentId: null },
        branch: "feature/x",
        head: sha,
        sha,
        session: "s-other2",
      });
      if (!row.ok) throw new Error(row.error);
    });
    expect(commitRows(root).map((row) => row.session)).toEqual(["s-other2"]);
  });
});

test("G an old HEAD (made before the note), T nothing is recorded", async () => {
  await withProtectedMain(() => {
    const root = repo({ branch: "feature/x" });
    claudeCall(root, "git commit -m old", () => {
      writeFileSync(path.join(root, "c.txt"), "c\n");
      git(root, "add", "c.txt");
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "old"], {
        cwd: root,
        env: { ...process.env, GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" },
      });
    });
    expect(commitRows(root)).toEqual([]);
  });
});

test("G Codex Pre/PostToolUse around a raw amend in another directory (cd x &&), T it is recorded there", async () => {
  await withProtectedMain(() => {
    const parent = tempRoot("workit-raw-git-parent-");
    roots.push(parent);
    const root = repo({ branch: "feature/y" });
    commitFile(root, "b.txt");
    const command = `cd ${sq(root)} && git commit --amend --no-edit -m 'feat: b2'`;
    const payload = (event: string) => ({
      hook_event_name: event,
      session_id: "codex-thread-1",
      cwd: parent,
      tool_name: "Bash",
      tool_use_id: "call-7",
      tool_input: { command },
      tool_response: "ok",
    });
    expect(dispatchHook(codexAdapter, payload("PreToolUse"), {}).error).toBeNull();
    git(root, "commit", "-q", "--amend", "--no-edit", "-m", "feat: b2");
    const amended = git(root, "rev-parse", "HEAD");
    expect(dispatchHook(codexAdapter, payload("PostToolUse"), {}).error).toBeNull();
    expect(commitRows(root)).toEqual([
      expect.objectContaining({ sha: amended, session: "codex-thread-1", branch: "feature/y" }),
    ]);
  });
});

test("G Cursor (no post-tool event), W a raw commit, T the session's next shell command records it", async () => {
  await withProtectedMain(() => {
    const root = repo({ branch: "feature/x" });
    const cursor = (command: string) =>
      dispatchHook(cursorAdapter, fixture("cursor", "before-shell-execution", root, { command }));
    cursor("git commit -m 'feat: c'");
    const sha = commitFile(root, "c.txt");
    expect(commitRows(root)).toEqual([]);
    expect(cursor("ls").exitCode).toBe(0);
    const session = String(fixture("cursor", "before-shell-execution", root).conversation_id);
    expect(commitRows(root)).toEqual([
      expect.objectContaining({ sha, session, branch: "feature/x" }),
    ]);
    expect(readdirSync(path.join(root, ".git", "workit", "hooks"))).toEqual([]);
  });
});

test("G a commit run in a workspace from an unrelated repository, T the note lives in the workspace and no store appears in the unrelated one", async () => {
  await withProtectedMain(() => {
    const unrelated = repo({ store: false });
    const workspace = repo({ branch: "feature/x" });
    dispatchHook(
      cursorAdapter,
      fixture("cursor", "before-shell-execution", unrelated, {
        command: `cd ${sq(workspace)} && git commit -m 'feat: d'`,
      }),
    );
    expect(existsSync(path.join(unrelated, ".git", "workit"))).toBe(false);
    expect(readdirSync(path.join(workspace, ".git", "workit", "hooks"))).toHaveLength(1);
  });
});

test("G OpenCode and Pi shell calls around a raw commit, T recorded for the session and the nudge is appended", async () => {
  await withProtectedMain(() => {
    const root = repo({ branch: "feature/x" });
    const call = {
      tool: "shell",
      sessionID: "ses_oc",
      id: "call-1",
      input: { command: "git commit -m 'feat: d'" },
    };
    observeShellBefore(root, call, new Map());
    const sha = commitFile(root, "d.txt");
    const after = {
      ...call,
      status: "completed" as const,
      result: { content: "[feature/x abc] feat: d" },
    };
    observeShellResult(root, after);
    expect(after.result.content).toContain("workit git commit -m");
    expect(commitRows(root)).toEqual([expect.objectContaining({ sha, session: "ses_oc" })]);

    const ctx = {
      cwd: root,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "pi-1" },
    };
    const input = { command: "git commit -m 'feat: e'" };
    enforceToolPolicy({ toolName: "bash", toolCallId: "t1", input } as never, ctx as never);
    const sha2 = commitFile(root, "e.txt");
    const result = observeToolResult(
      {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "t1",
        input,
        content: [{ type: "text", text: "ok" }],
        isError: false,
        details: undefined,
      } as never,
      ctx as never,
    );
    expect(result?.content.at(-1)).toEqual({
      type: "text",
      text: expect.stringContaining("workit git commit -m"),
    });
    expect(commitRows(root).at(-1)).toEqual(
      expect.objectContaining({ sha: sha2, session: "pi-1" }),
    );
  });
});

// ---------------------------------------------------------------------------
// fail open

test("G an unreadable branch policy on fail-closed Cursor, W a push onto main, T the hook still answers allow (fail open)", async () => {
  await withProtectedMain((configDir) => {
    const root = repo({ branch: "feature/x" });
    writeFileSync(path.join(configDir, "workspaces.json"), "{ not json");
    const out = dispatchHook(
      cursorAdapter,
      fixture("cursor", "before-shell-execution", root, { command: "git push origin HEAD:main" }),
    );
    expect(out.error).toBeNull();
    expect(out.exitCode).toBe(0);
    expect(out.json).toMatchObject({ permission: "allow" });
  });
});

test("G an unwritable ledger, W a raw commit PostToolUse, T no error escapes and nothing is denied", async () => {
  await withProtectedMain(() => {
    const root = repo({ branch: "feature/x" });
    const store = path.join(root, ".git", "workit");
    writeFileSync(path.join(store, "ledger"), "a file where the ledger directory belongs");
    const out = claudeCall(root, "git commit -m x", () => commitFile(root, "f.txt"));
    expect(out.error).toBeNull();
    expect(out.json).toEqual({});
    expect(existsSync(path.join(store, "ledger", "ledger.jsonl"))).toBe(false);
  });
});
