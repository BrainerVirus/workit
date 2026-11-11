// #792 item 26: a raw `git commit` onto a protected branch is denied with the
// branch to start instead, on every host that routes shell.pre through core;
// a `cd <worktree> && git add … && git commit …` chain is denied with the one
// `workit git --cwd <worktree> commit` call that replaces it. Read-only git
// and raw commits on a feature branch keep running.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  dispatchHook,
} from "@/packages/workit-core/src/hooks/index";
import { evaluateShellPermission } from "@/packages/workit-opencode/src/v2/permissions";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";
import { fixture, tempRoot, withProtectedMain } from "./hook-fixtures";

setDefaultTimeout(process.platform === "win32" ? 60_000 : 30_000);

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

/** A checkout on main with one commit; `store` makes it a Workit workspace. */
const repo = (store: boolean) => {
  const root = realpathSync(tempRoot("workit-raw-commit-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  writeFileSync(path.join(root, "README.md"), "# demo\n");
  git(root, "add", "README.md");
  git(root, "commit", "-q", "-m", "chore: init");
  if (store) mkdirSync(path.join(root, ".git", "workit"), { recursive: true });
  return root;
};

let sessions = 0;
type Out = {
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};
const claude = (cwd: string, command: string) =>
  (
    dispatchHook(claudeCodeAdapter, {
      hook_event_name: "PreToolUse",
      session_id: `s-commit-${++sessions}`,
      cwd,
      tool_name: "Bash",
      tool_input: { command },
    }).json as Out
  ).hookSpecificOutput;

type Host = "claude_code" | "codex" | "cursor" | "opencode" | "pi";

/** The deny reason one host gives for `command` in `root`, or null when it lets it run. */
const decisionOn = (host: Host, root: string, command: string): string | null => {
  switch (host) {
    case "claude_code": {
      const out = claude(root, command);
      return out?.permissionDecision === "deny" ? String(out.permissionDecisionReason) : null;
    }
    case "codex": {
      const out = dispatchHook(
        codexAdapter,
        fixture("codex", "pre-tool-use-bash", root, {
          tool_input: { command },
        }),
        {},
      ).json as Out;
      return out.hookSpecificOutput?.permissionDecision === "deny"
        ? String(out.hookSpecificOutput.permissionDecisionReason)
        : null;
    }
    case "cursor": {
      const out = dispatchHook(
        cursorAdapter,
        fixture("cursor", "before-shell-execution", root, { command }),
      );
      const json = out.json as { permission?: string; agent_message?: string };
      return json.permission === "deny" ? String(json.agent_message) : null;
    }
    case "opencode": {
      const event = {
        sessionID: "ses_1",
        action: "shell",
        resources: [command],
        effect: "allow",
      };
      evaluateShellPermission(root, event);
      return event.effect === "deny" ? String((event as { message?: string }).message) : null;
    }
    case "pi": {
      const pi = enforceToolPolicy(
        { toolName: "bash", input: { command } } as never,
        {
          cwd: root,
          isProjectTrusted: () => true,
          sessionManager: { getSessionId: () => "pi-1" },
        } as never,
      ) as { block?: boolean; reason?: string } | undefined;
      return pi?.block ? String(pi.reason) : null;
    }
  }
};

/** Single-quoted for a posix shell (Windows paths keep their backslashes). */
const sq = (value: string) => `'${value}'`;
/** A path as the deny prints it: bare when shell-safe, else single-quoted. */
const asWord = (value: string) => (/^[\w./@%+:,=-]+$/u.test(value) ? value : sq(value));

const BRANCH_FIRST = "workit git branch --kind feature --slug <slug>";

for (const host of ["claude_code", "codex", "cursor", "opencode", "pi"] as const)
  test(`G a protected main, W a raw git commit there (alone or chained), T ${host} denies it naming ${BRANCH_FIRST}`, async () => {
    await withProtectedMain(() => {
      const root = repo(true);
      writeFileSync(path.join(root, "README.md"), "# demo\nhello\n");
      for (const command of [
        "git commit -am 'docs: hello'",
        "git add README.md && git commit -m 'docs: hello'",
        `git add README.md && git commit -m "$(cat <<'EOF'\ndocs: hello\nEOF\n)"`,
        "git commit --amend --no-edit",
      ]) {
        const reason = decisionOn(host, root, command);
        expect(reason, command).toContain(BRANCH_FIRST);
        expect(reason, command).toContain("on main, a protected branch");
      }
      // Read-only git and a commit after switching to a work branch keep running.
      for (const command of [
        "git status",
        "git log -3",
        "git diff",
        "git show HEAD",
        "git commit --dry-run -m x",
        "git switch -c feature/hello && git commit -am 'docs: hello'",
      ])
        expect(decisionOn(host, root, command), command).toBeNull();
    });
  });

test("G a repository with no Workit store but a config naming main protected, W a raw commit on main, T it is denied", async () => {
  await withProtectedMain(() => {
    const root = repo(false);
    expect(
      claude(root, "git add README.md && git commit -m x")?.permissionDecisionReason,
    ).toContain(BRANCH_FIRST);
    // On a feature branch the raw commit runs, as before.
    git(root, "switch", "-q", "-c", "feature/x");
    expect(claude(root, "git add README.md && git commit -m x")).toBeUndefined();
  });
});

test("G no config naming protected branches and no Workit store, W a raw commit on main, T no decision", async () => {
  const keys = ["WORKIT_CONFIG", "WORKIT_CONFIG_DIR"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const empty = tempRoot("workit-raw-commit-config-");
  roots.push(empty);
  delete process.env.WORKIT_CONFIG;
  process.env.WORKIT_CONFIG_DIR = empty;
  try {
    expect(claude(repo(false), "git commit -am x")).toBeUndefined();
  } finally {
    for (const key of keys)
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
  }
});

/** A lead checkout on feature/base with a linked worktree on feature/wt-notes. */
const withWorktree = (store: boolean) => {
  const root = repo(store);
  git(root, "switch", "-q", "-c", "feature/base");
  const wt = path.join(path.dirname(root), `${path.basename(root)}-wt`);
  roots.push(wt);
  git(root, "worktree", "add", "-q", "-b", "feature/wt-notes", wt);
  writeFileSync(path.join(wt, "notes.md"), "# Notes\n");
  return { root, wt };
};

for (const store of [true, false])
  test(`G a linked worktree (${store ? "Workit workspace" : "config-declared policy"}), W cd <wt> && git add && git commit, T it is denied with the exact workit git --cwd call`, async () => {
    await withProtectedMain(() => {
      const { root, wt } = withWorktree(store);
      const call = `workit git --cwd ${asWord(wt)} commit -m 'docs: notes' -- notes.md`;
      for (const command of [
        `cd ${sq(wt)} && git add -- notes.md && git commit -m "docs: notes"`,
        `cd ${sq(wt)} && git add notes.md && git commit -m 'docs: notes'`,
        `cd ${sq(wt)} && git add notes.md && git commit --message='docs: notes'`,
      ])
        expect(claude(root, command)?.permissionDecisionReason, command).toContain(call);
      expect(
        claude(root, `cd ${sq(wt)} && git add -A && git commit -m 'docs: notes'`)
          ?.permissionDecisionReason,
      ).toContain(`workit git --cwd ${asWord(wt)} commit -m 'docs: notes' --all`);
      // Read-only git through the cd, a commit that stages nothing first (the
      // live-session guard's own advice), and raw git inside the worktree keep running.
      for (const [cwd, command] of [
        [root, `cd ${sq(wt)} && git commit -m x`],
        [root, `cd ${sq(wt)} && git status`],
        [root, `cd ${sq(wt)} && git log -3`],
        [wt, "git add notes.md && git commit -m 'docs: notes'"],
        [root, "git add README.md && git commit -m 'docs: x'"],
      ] as const)
        expect(claude(cwd, command)?.permissionDecision, command).toBeUndefined();
    });
  });

// Verifier mwc8hg8b: the cd-chain deny names a call only when it is provably
// the same commit; every other shape keeps the host's own decision.
test("G a linked worktree, W cd-chain commits whose workit call is provably equivalent, T the deny names that exact call", async () => {
  await withProtectedMain(() => {
    const { root, wt } = withWorktree(true);
    const heredoc = `cd ${sq(wt)} && git add notes.md && git commit -m "$(cat <<'EOF'\ndocs: notes\n\nWhy $it matters.\n\nCo-Authored-By: A <a@b.c>\nEOF\n)"`;
    const exact: Array<[string, string]> = [
      [
        `cd ${sq(wt)} && git add notes.md && git commit -m 'docs: a' -m 'body b'`,
        `workit git --cwd ${asWord(wt)} commit -m 'docs: a' -m 'body b' -- notes.md`,
      ],
      [
        heredoc,
        `workit git --cwd ${asWord(wt)} commit -m 'docs: notes\n\nWhy $it matters.\n\nCo-Authored-By: A <a@b.c>' -- notes.md`,
      ],
      [
        `cd ${sq(wt)} && git add . && git commit -m 'docs: notes'`,
        `workit git --cwd ${asWord(wt)} commit -m 'docs: notes' -- .`,
      ],
      [
        `cd ${sq(wt)} && git add --all && git commit -m 'docs: notes'`,
        `workit git --cwd ${asWord(wt)} commit -m 'docs: notes' --all`,
      ],
      [
        `cd ${sq(wt)} && git add notes.md && git commit --allow-empty -m 'docs: notes'`,
        `workit git --cwd ${asWord(wt)} commit -m 'docs: notes' --allow-empty -- notes.md`,
      ],
    ];
    for (const [command, call] of exact)
      expect(claude(root, command)?.permissionDecisionReason, command).toBe(
        `workit: no \`cd … &&\` chain; run \`${call}\`.`,
      );
  });
});

test("G a linked worktree, W a cd-chain commit no workit call reproduces exactly, T no decision", async () => {
  await withProtectedMain(() => {
    const { root, wt } = withWorktree(true);
    const add = `cd ${sq(wt)} && git add notes.md && `;
    for (const command of [
      `${add}git commit -m "fix $X"`,
      `${add}git commit -m "a \`b\`"`,
      `${add}git commit -m "$(cat <<EOF\ndocs: $X\nEOF\n)"`,
      `${add}git commit -m "$(cat <<'EOF'\ndocs: a\nEOF\nrm -rf x\nEOF\n)"`,
      `${add}git commit -F msg.txt`,
      `${add}git commit -F-`,
      `${add}git commit -C HEAD`,
      `${add}git commit -t tpl.txt`,
      `${add}git commit`,
      `${add}git commit -s -m 'docs: notes'`,
      `${add}git commit --signoff -m 'docs: notes'`,
      `${add}git commit --author 'A <a@b.c>' -m 'docs: notes'`,
      `${add}git commit -e -m 'docs: notes'`,
      `${add}git commit --no-verify -m 'docs: notes'`,
      `${add}git commit -q -m 'docs: notes'`,
      `${add}git commit -am 'docs: notes'`,
      `${add}git commit -m 'docs: notes' -- notes.md`,
      `cd ${sq(wt)} && git add -p notes.md && git commit -m 'docs: notes'`,
      `cd ${sq(wt)} && git add -u && git commit -m 'docs: notes'`,
      `cd ${sq(wt)} && git add 'n*.md' && git commit -m 'docs: notes'`,
      `cd ${sq(wt)} && git add notes.md; git commit -m 'docs: notes'`,
      `cd ${sq(wt)} && git add notes.md || git commit -m 'docs: notes'`,
      `cd ${sq(wt)} && git add notes.md && git commit -m 'docs: notes' && git push`,
    ])
      expect(claude(root, command)?.permissionDecision, command).toBeUndefined();
    // A file already staged outside the named paths would be left out of the workit commit.
    writeFileSync(path.join(wt, "other.md"), "x\n");
    git(wt, "add", "other.md");
    expect(claude(root, `${add}git commit -m 'docs: notes'`)?.permissionDecision).toBeUndefined();
    // `git add -A` takes it along, as `--all` does.
    expect(
      claude(root, `cd ${sq(wt)} && git add -A && git commit -m 'docs: notes'`)
        ?.permissionDecisionReason,
    ).toContain(`workit git --cwd ${asWord(wt)} commit -m 'docs: notes' --all`);
  });
});
