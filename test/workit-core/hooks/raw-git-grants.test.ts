// #589: the pre-tool raw-git hook judged raw `git push` and `gh pr create`
// only by branch policy, so a workspace with push:false or a claimed remote
// was no boundary for raw git. Grants now govern what leaves the machine: a
// branch push (push), a tag push or forge release (release), a PR/MR create
// or edit (pr), a merge (merge). Local commands keep today's decision.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  dispatchHook,
} from "@/packages/workit-core/src/hooks/index";
import { sshSeam } from "@/packages/workit-core/src/core/remotes";
import { evaluateShellPermission } from "@/packages/workit-opencode/src/v2/permissions";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { fixture } from "./hook-fixtures";

setDefaultTimeout(process.platform === "win32" ? 60_000 : 30_000);

let configHome: ConfigHome;
let root = "";
const savedSsh = sshSeam.read;
beforeAll(() => {
  sshSeam.read = () => ({ text: "", home: os.tmpdir() });
  configHome = useConfigHome("wk-raw-grants-config-");
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-raw-grants-")));
});
afterAll(() => {
  sshSeam.read = savedSsh;
  configHome.restore();
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true }));

const git = (cwd: string, ...args: string[]) => {
  const run = childProcess.spawnSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};

let worlds = 0;
/**
 * strict (every grant false, claims its bare remote) and open (push and pr
 * granted); `open/atk` is a fresh checkout on feature/x whose origin is
 * strict's bare remote, `open/own` one whose origin is an unclaimed bare.
 */
const world = (options: { claim?: boolean; openGrants?: Record<string, unknown> } = {}) => {
  const base = path.join(root, `w${worlds++}`);
  const strict = path.join(base, "strict");
  const open = path.join(base, "open");
  mkdirSync(strict, { recursive: true });
  mkdirSync(open, { recursive: true });
  const bare = path.join(strict, "remote.git");
  git(strict, "init", "-q", "--bare", "-b", "main", bare);
  const innocent = path.join(open, "innocent.git");
  git(open, "init", "-q", "--bare", "-b", "main", innocent);
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "strict",
          glob: `${strict}/**`,
          vcs: { provider: "github", account: "me" },
          autonomy: { push: false, pr: false, merge: false, release: false },
          ...(options.claim === false ? {} : { remotes: [bare, "github.com/acme/strict"] }),
        },
        {
          name: "open",
          glob: `${open}/**`,
          vcs: { provider: "github", account: "me" },
          autonomy: options.openGrants ?? { push: true, pr: true, merge: true, release: true },
        },
      ],
    }),
  );
  const checkout = (at: string, origin: string) => {
    mkdirSync(at, { recursive: true });
    git(at, "init", "-q", "-b", "main");
    git(at, "remote", "add", "origin", origin);
    git(at, "commit", "-q", "--allow-empty", "-m", "chore: base");
    git(at, "switch", "-q", "-c", "feature/x");
    git(at, "commit", "-q", "--allow-empty", "-m", "chore: x");
    return at;
  };
  const tip = (repo: string) =>
    childProcess
      .spawnSync("git", ["rev-parse", "--verify", "-q", "refs/heads/feature/x"], {
        cwd: repo,
        encoding: "utf8",
      })
      .stdout.trim() || null;
  return {
    strict,
    open,
    bare,
    innocent,
    tip,
    atk: checkout(path.join(open, "atk"), bare),
    own: checkout(path.join(open, "own"), innocent),
    inStrict: checkout(path.join(strict, "work"), bare),
  };
};

let sessions = 0;
const claude = (cwd: string, command: string) =>
  (
    dispatchHook(claudeCodeAdapter, {
      hook_event_name: "PreToolUse",
      session_id: `s-grants-${sessions++}`,
      cwd,
      tool_name: "Bash",
      tool_input: { command },
    }).json as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    } | null
  )?.hookSpecificOutput;

const denied = (cwd: string, command: string): string => {
  const out = claude(cwd, command);
  expect(out?.permissionDecision, `${command} in ${cwd}`).toBe("deny");
  return String(out?.permissionDecisionReason);
};
const notDenied = (cwd: string, command: string) =>
  expect(claude(cwd, command)?.permissionDecision, `${command} in ${cwd}`).not.toBe("deny");

test("Given open's checkout whose origin is strict's claimed remote, When raw git push runs in any form, Then each is denied naming strict and the grant command, and strict does not move", () => {
  const w = world();
  for (const command of [
    "git push -u origin feature/x",
    "git push",
    "git push --force origin feature/x",
    "git push --force-with-lease origin feature/x",
    "git push origin HEAD:refs/heads/feature/y",
    `git push ${w.bare} feature/x`,
    `git push file://${w.bare} feature/x`,
    "git push --receive-pack=git-receive-pack origin feature/x",
  ]) {
    const reason = denied(w.atk, command);
    expect(reason, command).toContain("push grant");
    expect(reason, command).toContain("workit git push");
  }
  const reason = denied(w.atk, "git push -u origin feature/x");
  expect(reason).toContain("strict");
  expect(reason).toContain("workit grant set strict push=true");
  // A URL the shell's insteadOf turns into strict's remote is strict's.
  denied(w.own, `git -c url.${w.bare}.insteadOf=x: push x:any feature/x`);
  // An innocent origin whose ssh command or receive-pack decides the target is unknown.
  denied(w.own, "GIT_SSH_COMMAND=/bin/false git push -u origin feature/x");
  expect(w.tip(w.bare)).toBeNull();
});

test("Given strict's own checkout with push false, When raw git push runs, Then it is denied even without a claimed remote", () => {
  const w = world({ claim: false });
  const reason = denied(w.inStrict, "git push -u origin feature/x");
  expect(reason).toContain("workspace strict");
  expect(reason).toContain("workit grant set strict push=true");
});

test("Given open's checkout whose origin is unclaimed and push granted, When raw git push runs, Then it runs as today (no deny)", () => {
  const w = world();
  notDenied(w.own, "git push -u origin feature/x");
  notDenied(w.own, "git push --force-with-lease origin feature/x");
  // A fork: origin is its own, upstream strict's. Only the push target counts.
  git(w.own, "remote", "add", "upstream", w.bare);
  notDenied(w.own, "git push -u origin feature/x");
  denied(w.own, "git push upstream feature/x");
});

test("Given open with release not granted, When a raw tag push or forge release runs, Then it needs the release grant; a branch push still runs", () => {
  const w = world({ openGrants: { push: true, pr: true, release: false } });
  git(w.own, "tag", "v1.0");
  for (const command of [
    "git push origin v1.0",
    "git push origin refs/tags/v1.0",
    "git push --tags",
    "gh release create v1.0",
    "glab release create v1.0",
  ])
    expect(denied(w.own, command), command).toContain("release grant");
  notDenied(w.own, "git push -u origin feature/x");
});

test("Given strict's pr and merge are false and its forge repository claimed, When raw PR/MR commands run, Then create, edit and merge are denied naming the grant; an unclaimed -R repository from open runs", () => {
  const w = world();
  for (const command of [
    "gh pr create --fill",
    "gh pr edit 1 --title x",
    "gh pr ready 1",
    "glab mr create --fill",
    "glab mr update 1 --title x",
  ])
    expect(denied(w.inStrict, command), command).toContain("pr grant");
  const merge = denied(w.inStrict, "gh pr merge 1");
  expect(merge).toContain("merge grant");
  // From open: -R names the base.
  expect(denied(w.own, "gh pr create -R acme/strict --fill")).toContain("pr grant");
  notDenied(w.own, "gh pr create -R acme/open --fill");
  notDenied(w.own, "gh pr view 1");
});

test("Given open's checkouts and no -R, When raw gh PR commands run, Then the base resolves as gh does: gh-resolved, else upstream, else origin", () => {
  const w = world();
  const remotes = (origin: string, upstream?: string) => {
    git(w.own, "remote", "set-url", "origin", origin);
    if (upstream) git(w.own, "remote", "add", "upstream", upstream);
  };
  remotes("git@github.com:acme/open.git");
  notDenied(w.own, "gh pr create --fill");
  remotes("git@github.com:acme/strict.git");
  for (const command of ["gh pr create --fill", "gh pr edit 1 --title x", "gh pr ready 1"])
    expect(denied(w.own, command), command).toContain("pr grant");
  expect(denied(w.own, "gh pr merge 1")).toContain("merge grant");
  // A fork: gh targets upstream (strict's) unless set-default picked the fork.
  remotes("git@github.com:me/fork.git", "https://github.com/acme/strict");
  expect(denied(w.own, "gh pr create --fill")).toContain("strict");
  git(w.own, "config", "remote.origin.gh-resolved", "base");
  notDenied(w.own, "gh pr create --fill");
  // Nothing resolves: undetermined, denied while remotes are claimed.
  git(w.own, "remote", "remove", "upstream");
  git(w.own, "remote", "remove", "origin");
  expect(denied(w.own, "gh pr create --fill")).toContain("pr grant");
});

test("Given every grant false in a Workit workspace, When local-only commands run, Then each gets the same decision as with no workspaces at all", () => {
  const w = world({ claim: false });
  mkdirSync(path.join(w.inStrict, ".git", "workit"), { recursive: true });
  const local = [
    "git stash",
    "git reset --hard HEAD",
    "git switch -c feature/y",
    "git restore .",
    "git fetch origin",
    "git branch feature/z",
    "git commit --amend --no-edit",
    "git rebase main",
  ];
  const decide = (command: string) => {
    const out = claude(w.inStrict, command);
    return out?.permissionDecision ?? null;
  };
  const governed = local.map(decide);
  rmSync(path.join(configHome.configDir, "workspaces.json"));
  expect(governed).toEqual(local.map(decide));
});

test("Given a permissive workspace that claims no remotes, When a raw push runs, Then the hook spawns git no more often than with no workspaces", () => {
  const w = world({ claim: false });
  const count = (command: string) => {
    const spy = spyOn(childProcess, "spawnSync");
    try {
      claude(w.own, command);
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  };
  // Only open, permissive: strict's entry would make push matter.
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "open",
          glob: `${w.open}/**`,
          vcs: { provider: "github", account: "me" },
          autonomy: { push: true, pr: true },
        },
      ],
    }),
  );
  const permissive = count("git push -u origin feature/x");
  rmSync(path.join(configHome.configDir, "workspaces.json"));
  const none = count("git push -u origin feature/x");
  expect(permissive).toBe(none);
});

// #549 N2/N3: a local remote whose git internals or commondir lead into
// strict's repository is strict's, through the raw hook as through workit.
test.skipIf(process.platform === "win32")(
  "Given a remote whose refs and objects are symlinks into strict's repository (N2) or whose commondir names it (N3), When raw git push targets it, Then it is denied as strict's",
  () => {
    const w = world();
    const borrowed = path.join(w.open, "borrowed.git");
    mkdirSync(borrowed);
    writeFileSync(path.join(borrowed, "HEAD"), "ref: refs/heads/main\n");
    for (const name of ["refs", "objects"])
      symlinkSync(path.join(w.bare, name), path.join(borrowed, name));
    const common = path.join(w.open, "common.git");
    mkdirSync(path.join(common, "refs"), { recursive: true });
    mkdirSync(path.join(common, "objects"));
    writeFileSync(path.join(common, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(common, "commondir"), path.relative(common, w.bare));
    for (const remote of [borrowed, common]) {
      git(w.own, "remote", "set-url", "origin", remote);
      const reason = denied(w.own, "git push -u origin feature/x");
      expect(reason, remote).toContain("workspace strict claims");
    }
    expect(w.tip(w.bare)).toBeNull();
  },
);

// Host parity: each host routes shell commands through the same pre-tool hook.
for (const host of ["claude_code", "codex", "cursor", "opencode", "pi"] as const)
  test(`Given open's checkout whose origin strict claims, When a raw push runs on ${host}, Then ${host} denies it naming the push grant`, () => {
    const w = world();
    const command = "git push -u origin feature/x";
    let reason = "";
    if (host === "claude_code") reason = denied(w.atk, command);
    else if (host === "codex")
      reason = String(
        (
          dispatchHook(
            codexAdapter,
            fixture("codex", "pre-tool-use-bash", w.atk, { tool_input: { command } }),
            {},
          ).json as { hookSpecificOutput?: { permissionDecisionReason?: string } }
        ).hookSpecificOutput?.permissionDecisionReason,
      );
    else if (host === "cursor") {
      const out = dispatchHook(
        cursorAdapter,
        fixture("cursor", "before-shell-execution", w.atk, { command }),
      );
      expect(out.exitCode).toBe(2);
      reason = String((out.json as { agent_message?: string }).agent_message);
    } else if (host === "opencode") {
      const event = { sessionID: "ses_1", action: "shell", resources: [command], effect: "allow" };
      evaluateShellPermission(w.atk, event);
      expect(event.effect).toBe("deny");
      reason = String((event as { message?: string }).message);
    } else {
      const pi = enforceToolPolicy(
        { toolName: "bash", input: { command } } as never,
        {
          cwd: w.atk,
          isProjectTrusted: () => true,
          sessionManager: { getSessionId: () => "pi-1" },
        } as never,
      ) as { reason?: string } | undefined;
      reason = String(pi?.reason);
    }
    expect(reason).toContain("push grant");
    expect(reason).toContain("strict");
  });
