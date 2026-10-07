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
import { checkVerdicts, readLedger, recordVerdict } from "@/packages/workit-core/src/ledger";
import { evaluateShellPermission } from "@/packages/workit-opencode/src/v2/permissions";
import { observeShellResult } from "@/packages/workit-opencode/src/v2/shell";
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
const repo = (options: { branch?: string; store?: boolean } = {}) => {
  const root = tempRoot("workit-raw-git-");
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  if (options.branch) git(root, "checkout", "-q", "-b", options.branch);
  if (options.store !== false) mkdirSync(path.join(root, ".git", "workit"), { recursive: true });
  return root;
};

const commitFile = (root: string, name: string) => {
  writeFileSync(path.join(root, name), `${name}\n`);
  git(root, "add", name);
  git(root, "commit", "-q", "-m", `feat: ${name}`);
  return git(root, "rev-parse", "HEAD");
};

const claude = (cwd: string, command: string, event = "PreToolUse", extra = {}) =>
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
const claudeOut = (cwd: string, command: string) =>
  (claude(cwd, command).json as ClaudeOut).hookSpecificOutput;

const commitRows = (root: string) => {
  const ledger = readLedger(root);
  if (!ledger.ok) return [];
  return ledger.value.rows.filter((row) => row.type === "commit.recorded");
};

// ---------------------------------------------------------------------------
// classification (pure string parsing)

const classify = (command: string) =>
  rawInvocations(command).map((invocation) => ({
    dir: invocation.dir,
    action: rawAction(invocation),
  }));

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
    [`git commit -m "fix: a; b && c"`, [{ dir: null, action: { kind: "commit", amend: false } }]],
    ["git commit --amend --no-edit", [{ dir: null, action: { kind: "commit", amend: true } }]],
    ["cd sub && git commit -qam x", [{ dir: "sub", action: { kind: "commit", amend: false } }]],
    [
      "git -C ../other commit -m x",
      [{ dir: "../other", action: { kind: "commit", amend: false } }],
    ],
    ["cd a && git -C b commit -m x", [{ dir: "a/b", action: { kind: "commit", amend: false } }]],
    [
      "GIT_AUTHOR_NAME=x FOO=1 git -c core.editor=true commit -m y",
      [{ dir: null, action: { kind: "commit", amend: false } }],
    ],
    [
      "bash -lc 'cd repo && gh pr merge 5 --squash'",
      [{ dir: "repo", action: { kind: "merge", forge: "gh" } }],
    ],
    ["glab mr merge 3", [{ dir: null, action: { kind: "merge", forge: "glab" } }]],
    ["gh pr create --fill", [{ dir: null, action: { kind: "pr-create", forge: "gh" } }]],
    ["gh pr checks 7 --watch", [{ dir: null, action: { kind: "pr-read", forge: "gh" } }]],
    ["gh issue list", [{ dir: null, action: null }]],
    [
      "git push --force origin HEAD:main",
      [
        {
          dir: null,
          action: { kind: "push", targets: ["main"], blindForce: true, remote: "origin" },
        },
      ],
    ],
    [
      "git push --force-with-lease origin +feature/x",
      [
        {
          dir: null,
          action: { kind: "push", targets: ["feature/x"], blindForce: false, remote: "origin" },
        },
      ],
    ],
    [
      "git push -u origin feature/x:refs/heads/main",
      [
        {
          dir: null,
          action: { kind: "push", targets: ["main"], blindForce: false, remote: "origin" },
        },
      ],
    ],
    [
      "git push",
      [{ dir: null, action: { kind: "push", targets: [null], blindForce: false, remote: null } }],
    ],
    [
      "git push origin --tags",
      [{ dir: null, action: { kind: "push", targets: [], blindForce: false, remote: "origin" } }],
    ],
    ["echo git commit", []],
    ["grep -r 'git push' .", []],
  ];
  for (const [command, expected] of table)
    expect(classify(command) as unknown, command).toEqual(expected);
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
      JSON.stringify({ workspaces: [{ name: "w", glob: `${root}/**` }] }),
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

    const opencode = (command: string) => {
      const event = { sessionID: "ses_1", action: "shell", resources: [command], effect: "allow" };
      evaluateShellPermission(root, event);
      return event as typeof event & { message?: string };
    };
    expect(opencode("gh pr merge 1")).toMatchObject({
      effect: "deny",
      message: expect.stringContaining("workit pr merge"),
    });
    expect(opencode("git commit -m x").effect).toBe("allow");

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
// post-tool: raw commits are recorded for the session (B2)

test("G a raw commit and no hook record, T the author's own verdict reads as independent (the gap this closes)", async () => {
  await withProtectedMain(() => {
    const root = repo({ branch: "feature/x" });
    commitFile(root, "a.txt");
    const verdict = recordVerdict(
      { cwd: root, actor: { host: "claude_code", session: "s-lead", agentId: null } },
      { result: "verified", how: "ran it" },
    );
    expect(verdict.ok).toBe(true);
  });
});

test("G Claude PostToolUse after a raw git commit, T commit.recorded names the session and its verdict is not independent", async () => {
  await withProtectedMain(() => {
    const root = repo({ branch: "feature/x" });
    const sha = commitFile(root, "a.txt");
    expect(
      claude(root, "git commit -m 'feat: a.txt'", "PostToolUse", { tool_response: { stdout: "" } })
        .json,
    ).toEqual({});
    expect(commitRows(root)).toEqual([
      expect.objectContaining({
        branch: "feature/x",
        sha,
        session: "s-lead",
        observer: "host_hook",
        actor: expect.objectContaining({ host: "claude_code", session: "s-lead" }),
      }),
    ]);
    // A second PostToolUse for the same commit records nothing more.
    claude(root, "git commit -m 'feat: a.txt'", "PostToolUse");
    expect(commitRows(root)).toHaveLength(1);

    const refused = recordVerdict(
      { cwd: root, actor: { host: "claude_code", session: "s-lead", agentId: null } },
      { result: "verified", how: "ran it" },
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("author_verdict");
    const ledger = readLedger(root);
    if (!ledger.ok) throw new Error(ledger.error);
    expect(checkVerdicts(root, "feature/x", ledger.value.rows).authors).toEqual(["s-lead"]);
    // A different session still verifies.
    expect(
      recordVerdict(
        { cwd: root, actor: { host: "claude_code", session: "s-lead-v1", agentId: null } },
        { result: "verified", how: "ran it" },
      ).ok,
    ).toBe(true);
  });
});

test("G Codex PostToolUse after a raw amend in another directory (cd x &&), T it is recorded there", async () => {
  await withProtectedMain(() => {
    const parent = tempRoot("workit-raw-git-parent-");
    roots.push(parent);
    const root = repo({ branch: "feature/y" });
    const sha = commitFile(root, "b.txt");
    const post = dispatchHook(
      codexAdapter,
      {
        hook_event_name: "PostToolUse",
        session_id: "codex-thread-1",
        cwd: parent,
        tool_name: "Bash",
        tool_input: { command: `cd ${root} && git commit --amend --no-edit` },
        tool_response: "ok",
      },
      {},
    );
    expect(post.error).toBeNull();
    expect(commitRows(root)).toEqual([
      expect.objectContaining({ sha, session: "codex-thread-1", branch: "feature/y" }),
    ]);
  });
});

test("G an old HEAD (the commit command failed), T nothing is recorded", async () => {
  await withProtectedMain(() => {
    const root = repo({ branch: "feature/x" });
    writeFileSync(path.join(root, "c.txt"), "c\n");
    git(root, "add", "c.txt");
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "old"], {
      cwd: root,
      env: { ...process.env, GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" },
    });
    claude(root, "git commit -m nothing", "PostToolUse");
    expect(commitRows(root)).toEqual([]);
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

test("G OpenCode and Pi shell results after a raw commit, T recorded for the session and the nudge is appended", async () => {
  await withProtectedMain(() => {
    const root = repo({ branch: "feature/x" });
    const sha = commitFile(root, "d.txt");
    const event = {
      tool: "shell",
      sessionID: "ses_oc",
      id: "call-1",
      input: { command: "git commit -m 'feat: d'" },
      status: "completed" as const,
      result: { content: "[feature/x abc] feat: d" },
    };
    observeShellResult(root, event);
    expect(event.result.content).toContain("workit git commit -m");
    expect(commitRows(root)).toEqual([expect.objectContaining({ sha, session: "ses_oc" })]);

    const sha2 = commitFile(root, "e.txt");
    const ctx = {
      cwd: root,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "pi-1" },
    };
    const result = observeToolResult(
      {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "t1",
        input: { command: "git commit -m 'feat: e'" },
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
    commitFile(root, "f.txt");
    const store = path.join(root, ".git", "workit");
    writeFileSync(path.join(store, "ledger"), "a file where the ledger directory belongs");
    const out = claude(root, "git commit -m x", "PostToolUse");
    expect(out.error).toBeNull();
    expect(out.json).toEqual({});
    expect(existsSync(path.join(store, "ledger", "ledger.jsonl"))).toBe(false);
  });
});
