// Stop control (ledger decision "stop control: option A, nudge once"): a main
// session that stops with a ledger-provable unmet obligation is continued
// once, with the obligation and the workit command that clears it; it can
// always stop after that, and never when it asks the user a question.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  asksUser,
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  dispatchHook,
} from "@/packages/workit-core/src/hooks/index";
import {
  appendHookObserved,
  appendObserved,
  recordVerdict,
} from "@/packages/workit-core/src/ledger";
import { recordPrStatus, type PrStatusDoc } from "@/packages/workit-core/src/forge/report";
import { useConfigHome, type ConfigHome } from "@/test/shared/grant-home";
import { fixture, tempRoot } from "./hook-fixtures";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

let home: ConfigHome;
beforeEach(() => {
  home = useConfigHome("workit-stop-home-");
  writeFileSync(
    path.join(home.configDir, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
    }),
  );
});
afterEach(() => home.restore());

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};

const SESSION = "s-lead";
const actor = (session: string) => ({ host: "claude_code", session, agentId: null });

/** A Workit checkout on feature/x with an `origin` remote that has main only. */
const repo = (endpoint: "commit" | "pr" | "green" | "merged") => {
  const parent = tempRoot("workit-stop-");
  roots.push(parent);
  const root = path.join(parent, "work");
  const origin = path.join(parent, "origin.git");
  git(parent, "init", "-q", "--bare", "-b", "main", origin);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-q", "origin", "main");
  git(root, "checkout", "-q", "-b", "feature/x");
  mkdirSync(path.join(root, ".git", "workit"), { recursive: true });
  writeFileSync(
    path.join(home.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${parent.replaceAll("\\", "/")}/**`,
          vcs: { provider: "github", account: "octo" },
          autonomy: { push: true, pr: true, merge: "verified" },
          defaultEndpoint: endpoint,
        },
      ],
    }),
  );
  return root;
};

/** A commit on the branch, recorded for `session` as workit git commit would. */
const commit = (root: string, name: string, session = SESSION) => {
  writeFileSync(path.join(root, name), `${name}\n`);
  git(root, "add", name);
  git(root, "commit", "-q", "-m", `feat: ${name}`);
  const sha = git(root, "rev-parse", "HEAD");
  appendHookObserved(root, {
    type: "commit.recorded",
    actor: actor(session),
    branch: git(root, "branch", "--show-current"),
    head: sha,
    sha,
    session,
    agentId: null,
    subject: `feat: ${name}`,
    files: [name],
    fileCount: 1,
  });
  return sha;
};

const prCreated = (root: string, pr: number, session = SESSION) =>
  appendObserved(root, {
    type: "pr.created",
    actor: actor(session),
    branch: "feature/x",
    head: git(root, "rev-parse", "HEAD"),
    pr,
    base: "main",
    url: `https://github.com/o/r/pull/${pr}`,
    forge: "github",
    repo: "o/r",
    created: true,
  });

const prMerged = (root: string, pr: number, head = git(root, "rev-parse", "HEAD"), extra = {}) =>
  appendObserved(root, {
    type: "pr.merged",
    actor: actor(SESSION),
    branch: "feature/x",
    head,
    pr,
    base: "main",
    mergeSha: "f".repeat(40),
    method: "squash",
    verdictId: null,
    grant: "autonomy",
    ...extra,
  });

const prStatus = (
  root: string,
  pr: number,
  checks: string,
  head = git(root, "rev-parse", "HEAD"),
) =>
  appendObserved(root, {
    type: "pr.status",
    actor: actor(SESSION),
    branch: "feature/x",
    head,
    pr,
    repo: "o/r",
    forge: "github",
    checks,
  });

const claudeStop = (cwd: string, extra: Record<string, unknown> = {}) =>
  dispatchHook(
    claudeCodeAdapter,
    fixture("claude-code", "stop", cwd, { session_id: SESSION, ...extra }),
  ).json as { decision?: string; reason?: string };

test("a turn that asks the user anything in its last paragraphs is a question; a plain report is not", () => {
  for (const asked of [
    "Pushed it.\n\nShould I open the PR now?",
    "Which option do you want: **A or B?**",
    "Done. Let me know if you want me to push.",
    "¿Quieres que lo suba?",
    "Which one?\n\n1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n7. g",
    "Which one?\n\n- a\n\n- b\n\n- c",
    "Should I push? Tests pass.",
    "Ready to push — want me to?\n\n```bash\nworkit git push\n```",
    "要推送吗？",
    "هل أدفع التغييرات؟",
    "Shall I continue (y/n)",
    "Proceed [y/N]",
    "Tests pass. Would you like a PR as well.",
    // The question in the second-last paragraph still counts.
    "Should I push now?\n\nTests pass on CI.",
  ])
    expect(asksUser(asked), asked).toBe(true);
  for (const told of [
    "Done. Tests pass.",
    "```\nwhy?\n```\nDone.",
    "Stopping as you asked.",
    "Was it flaky? No: the fixture was stale.\n\nFixed the fixture.\n\nAll 40 tests pass.",
    "See https://example.com/x?a=1 for the log.",
    // Only the last two paragraphs are read.
    "Should I push?\n\nNo need: done.\n\nPushed and opened the PR.",
    // An unclosed code fence runs to the end: its text is code, not a question.
    "Done.\n\n```\nwhy?",
  ])
    expect(asksUser(told), told).toBe(false);
  expect(asksUser(null)).toBe(false);
});

test("G endpoint pr and an unpushed commit of this session, W the agent stops, T it continues once naming workit git push", () => {
  const root = repo("pr");
  commit(root, "a.txt");
  const out = claudeStop(root);
  expect(out.decision).toBe("block");
  expect(out.reason).toContain("feature/x has 1 commit(s) of this session not on origin");
  expect(out.reason).toContain("`workit git push`");
  // The continuation's own stop is allowed: one continue per turn.
  expect(claudeStop(root, { stop_hook_active: true })).toEqual({});
  // A question to the user is never blocked.
  expect(claudeStop(root, { last_assistant_message: "Push it to origin now?" })).toEqual({});
  // An unknown last message may be a question.
  expect(claudeStop(root, { last_assistant_message: undefined })).toEqual({});
  // A subagent's stop is never blocked.
  expect(claudeStop(root, { agent_id: "a1", agent_type: "workit:implementer" })).toEqual({});
  // Another session authored nothing here: no obligation.
  expect(claudeStop(root, { session_id: "s-other" })).toEqual({});
  git(root, "push", "-q", "origin", "feature/x");
  expect(claudeStop(root)).toEqual({});
  // Another session's (or the user's) unpushed commit never blocks this one.
  commit(root, "b.txt", "s-other");
  expect(claudeStop(root)).toEqual({});
  expect(claudeStop(root, { session_id: "s-other" }).reason).toContain("1 commit(s)");
});

test("G endpoint commit, a protected branch, a detached HEAD or no remote, T the stop is allowed", () => {
  const root = repo("commit");
  commit(root, "a.txt");
  expect(claudeStop(root)).toEqual({});

  // This session's unpushed commit on main, with its rows on main: main is
  // the default target, never a branch to push from.
  const onMain = repo("pr");
  git(onMain, "checkout", "-q", "main");
  commit(onMain, "b.txt");
  expect(claudeStop(onMain)).toEqual({});

  const detached = repo("pr");
  commit(detached, "c.txt");
  git(detached, "checkout", "-q", "--detach");
  expect(claudeStop(detached)).toEqual({});

  const remoteless = repo("pr");
  commit(remoteless, "d.txt");
  git(remoteless, "remote", "remove", "origin");
  expect(claudeStop(remoteless)).toEqual({});

  // A repository Workit does not manage: no store, no matching workspace.
  const plain = tempRoot("workit-stop-plain-");
  roots.push(plain);
  git(plain, "init", "-q", "-b", "feature/x");
  git(plain, "commit", "-q", "--allow-empty", "-m", "init");
  expect(claudeStop(plain)).toEqual({});
});

test("G a branch the CLI merged, W the remote branch is deleted (squash + --delete-branch, or pruned), T nothing is owed: no push, no verdict", () => {
  for (const removal of ["delete", "prune"] as const) {
    const root = repo("merged");
    commit(root, "a.txt");
    // No upstream configured: only the merge record can say it landed.
    git(root, "push", "-q", "origin", "feature/x");
    prCreated(root, 5);
    recordVerdict(
      { cwd: root, actor: actor("s-verifier"), branch: "feature/x" },
      { result: "verified", how: "drove the CLI" },
    );
    if (removal === "delete") git(root, "push", "-q", "origin", "--delete", "feature/x");
    else {
      // The forge auto-deletes the branch; a later fetch prunes it.
      git(path.join(path.dirname(root), "origin.git"), "branch", "-q", "-D", "feature/x");
      git(root, "fetch", "-q", "--prune", "origin");
    }
    // Before the merge is recorded, the commit reads unpushed.
    expect(claudeStop(root).reason, removal).toContain("`workit git push`");
    // A hook-observed merge row proves nothing: only the CLI's counts.
    appendHookObserved(root, {
      type: "pr.merged",
      actor: actor(SESSION),
      branch: "feature/x",
      head: git(root, "rev-parse", "HEAD"),
      pr: 5,
    });
    expect(claudeStop(root).reason, removal).toContain("`workit git push`");
    prMerged(root, 5);
    expect(claudeStop(root), removal).toEqual({});
  }
});

test("G a merge in the forge UI (no CLI merge row), W the forge deleted the branch and a fetch pruned it, T the gone upstream says it landed; while the upstream exists the push is owed", () => {
  const root = repo("merged");
  commit(root, "a.txt");
  git(root, "push", "-q", "-u", "origin", "feature/x");
  prCreated(root, 5);
  recordVerdict(
    { cwd: root, actor: actor("s-verifier"), branch: "feature/x" },
    { result: "verified", how: "drove the CLI" },
  );
  commit(root, "b.txt");
  expect(claudeStop(root).reason).toContain("`workit git push`");
  git(path.join(path.dirname(root), "origin.git"), "branch", "-q", "-D", "feature/x");
  git(root, "fetch", "-q", "--prune", "origin");
  expect(claudeStop(root)).toEqual({});
});

/** What `workit pr status` / `ci wait` record when the forge reports the PR `state`. */
const forgeSaw = (root: string, pr: number, state: "merged" | "closed") =>
  recordPrStatus(
    root,
    {
      forge: "github",
      repo: "o/r",
      number: pr,
      state,
      head: { branch: "feature/x", sha: git(root, "rev-parse", "HEAD") },
      checks: { state: "passing" },
    } as unknown as PrStatusDoc,
    actor(SESSION),
  );

test("G a merge in the forge UI, branch not pruned, W pr status records the merge, T no verdict is owed; a PR closed unmerged still owes one", () => {
  const merged = repo("pr");
  commit(merged, "a.txt");
  git(merged, "push", "-q", "-u", "origin", "feature/x");
  prCreated(merged, 5);
  expect(claudeStop(merged).reason).toContain("has no current verdict");
  forgeSaw(merged, 5, "merged");
  expect(claudeStop(merged)).toEqual({});

  const closed = repo("green");
  commit(closed, "a.txt");
  git(closed, "push", "-q", "-u", "origin", "feature/x");
  prCreated(closed, 6);
  prStatus(closed, 6, "failing");
  forgeSaw(closed, 6, "closed");
  // Closed is no merge, and no open PR has failing checks any more.
  const reason = claudeStop(closed).reason ?? "";
  expect(reason).toContain("has no current verdict");
  expect(reason).not.toContain("checks were last seen");
});

test("G a branch reused after its CLI merge, W this session commits again, T only the new commit is owed", () => {
  const root = repo("pr");
  commit(root, "a.txt");
  git(root, "push", "-q", "-u", "origin", "feature/x");
  prCreated(root, 5);
  prMerged(root, 5);
  git(root, "push", "-q", "origin", "--delete", "feature/x");
  commit(root, "c.txt");
  expect(claudeStop(root).reason).toContain(
    "feature/x has 1 commit(s) of this session not on origin",
  );
});

test("G a session that only opened the PR (no commits of its own), W the CLI merged it at HEAD, T no verdict is owed", () => {
  const root = repo("pr");
  commit(root, "a.txt", "s-author");
  git(root, "push", "-q", "-u", "origin", "feature/x");
  prCreated(root, 4);
  expect(claudeStop(root).reason).toContain("has no current verdict");
  prMerged(root, 4);
  expect(claudeStop(root)).toEqual({});
});

test("G an --unverified merge of this session's PR, T no verdict is owed; a new commit after the merge is owed again", () => {
  const root = repo("pr");
  const first = commit(root, "a.txt");
  git(root, "push", "-q", "-u", "origin", "feature/x");
  prCreated(root, 6);
  expect(claudeStop(root).reason).toContain("has no current verdict");
  prMerged(root, 6, first, { unverified: "merge-row" });
  expect(claudeStop(root)).toEqual({});
  // The merged head still holds this session's commits: another session's
  // commit on top owes nothing here.
  commit(root, "b.txt", "s-other");
  expect(claudeStop(root)).toEqual({});
  // This session's own commit after the merge is not in it.
  commit(root, "c.txt");
  expect(claudeStop(root).reason).toContain("1 commit(s) of this session not on origin");
});

test("G endpoint green and the open PR's checks recorded failing at the head, T it continues naming workit ci wait", () => {
  const root = repo("green");
  commit(root, "a.txt");
  git(root, "push", "-q", "origin", "feature/x");
  prCreated(root, 7);
  prStatus(root, 7, "failing");
  const out = claudeStop(root);
  expect(out.decision).toBe("block");
  expect(out.reason).toContain("PR #7's checks were last seen failing");
  expect(out.reason).toContain("`workit ci wait --pr 7` after fixing the failures");
  prStatus(root, 7, "pending");
  const pending = claudeStop(root).reason;
  expect(pending).toContain("PR #7's checks were last seen pending");
  expect(pending).not.toContain("after fixing");
  // Passing checks at the head leave only the verdict obligation.
  prStatus(root, 7, "passing");
  expect(claudeStop(root).reason).toContain("has no current verdict");
});

test("G checks recorded failing at an older head, T they say nothing about the new head", () => {
  const root = repo("green");
  commit(root, "a.txt");
  git(root, "push", "-q", "origin", "feature/x");
  prCreated(root, 7);
  prStatus(root, 7, "failing");
  commit(root, "b.txt");
  git(root, "push", "-q", "origin", "feature/x");
  const reason = claudeStop(root).reason ?? "";
  expect(reason).not.toContain("checks were last seen");
  expect(reason).toContain("has no current verdict");
});

test("G failing checks recorded for a PR merged since, or under endpoint pr, T no checks obligation", () => {
  // Commits by this session, a PR it never opened: only (a) and (b) apply.
  const merged = repo("green");
  commit(merged, "a.txt");
  git(merged, "push", "-q", "origin", "feature/x");
  prStatus(merged, 7, "failing");
  expect(claudeStop(merged).reason).toContain("PR #7's checks were last seen failing");
  // A merge of PR 7 at a head that is no local commit: the branch has not
  // landed, but PR 7 is no longer open.
  prMerged(merged, 7, "0".repeat(40));
  expect(claudeStop(merged)).toEqual({});

  const underPr = repo("pr");
  commit(underPr, "a.txt");
  git(underPr, "push", "-q", "origin", "feature/x");
  prStatus(underPr, 7, "failing");
  expect(claudeStop(underPr)).toEqual({});
});

test("G this session delivered a PR, W the head has no or only a self verdict, T it continues naming a non-author verifier; an independent verdict clears it", () => {
  const root = repo("pr");
  commit(root, "a.txt");
  git(root, "push", "-q", "origin", "feature/x");
  prCreated(root, 8);
  const none = claudeStop(root);
  expect(none.decision).toBe("block");
  expect(none.reason).toContain("has no current verdict");
  expect(none.reason).toContain("workit:verifier");
  expect(none.reason).toContain("if no verifier is already running on it");
  expect(none.reason).toContain("Never record a verdict on your own work");
  const self = recordVerdict(
    { cwd: root, actor: actor(SESSION), branch: "feature/x" },
    { result: "verified", how: "ran the tests", self: true },
  );
  expect(self.ok).toBe(true);
  expect(claudeStop(root).reason).toContain("has only a self verdict");
  const independent = recordVerdict(
    { cwd: root, actor: actor("s-verifier"), branch: "feature/x" },
    { result: "verified", how: "drove the CLI" },
  );
  expect(independent.ok).toBe(true);
  expect(claudeStop(root)).toEqual({});
});

test("G an independent failed verdict on the delivered head, T the stop is free: the fix is the agent's next turn, not a verifier", () => {
  const root = repo("pr");
  commit(root, "a.txt");
  git(root, "push", "-q", "origin", "feature/x");
  prCreated(root, 9);
  const failed = recordVerdict(
    { cwd: root, actor: actor("s-verifier"), branch: "feature/x" },
    { result: "failed", how: "the empty case crashes" },
  );
  expect(failed.ok).toBe(true);
  expect(claudeStop(root)).toEqual({});
});

test("G Codex Stop, W an unmet obligation, T decision block; stop_hook_active allows", () => {
  const root = repo("pr");
  commit(root, "a.txt", "codex-session-1");
  const stop = (extra: Record<string, unknown> = {}) =>
    dispatchHook(codexAdapter, fixture("codex", "stop", root, extra), {}).json;
  expect(stop()).toEqual({ decision: "block", reason: expect.stringContaining("workit git push") });
  expect(stop({ stop_hook_active: true })).toEqual({});
  expect(stop({ last_assistant_message: "Want me to push?" })).toEqual({});
});

test("G Cursor stop, W an unmet obligation and a transcript, T followup_message once; loop_count, a question or no transcript allow", () => {
  const root = repo("pr");
  commit(root, "a.txt", "cursor-conv-1");
  const transcript = path.join(path.dirname(root), "transcript.jsonl");
  const say = (text: string) =>
    writeFileSync(
      transcript,
      [
        JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "go" }] } }),
        JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text }] } }),
        JSON.stringify({ type: "turn_ended", status: "success" }),
      ].join("\n"),
    );
  const stop = (extra: Record<string, unknown> = {}) =>
    dispatchHook(
      cursorAdapter,
      fixture("cursor", "stop", root, { transcript_path: transcript, ...extra }),
    ).json;
  say("Committed the change.");
  expect(stop()).toEqual({ followup_message: expect.stringContaining("workit git push") });
  expect(stop({ loop_count: 1 })).toEqual({});
  expect(stop({ status: "aborted" })).toEqual({});
  expect(stop({ transcript_path: null })).toEqual({});
  // A missing or unreadable transcript may hide a question: allowed.
  expect(stop({ transcript_path: path.join(path.dirname(root), "gone.jsonl") })).toEqual({});
  expect(stop({ transcript_path: path.dirname(root) })).toEqual({});
  writeFileSync(transcript, "not json\n{also not json");
  expect(stop()).toEqual({});
  say("Committed. Shall I push it?");
  expect(stop()).toEqual({});
});
