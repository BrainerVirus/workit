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
  CURSOR_DESCRIPTOR,
  cursorAdapter,
  dispatchHook,
  type HostAdapter,
} from "@/packages/workit-core/src/hooks/index";
import {
  appendHookObserved,
  appendObserved,
  recordVerdict,
} from "@/packages/workit-core/src/ledger";
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
    branch: "feature/x",
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

const claudeStop = (cwd: string, extra: Record<string, unknown> = {}) =>
  dispatchHook(
    claudeCodeAdapter,
    fixture("claude-code", "stop", cwd, { session_id: SESSION, ...extra }),
  ).json as { decision?: string; reason?: string };

test("a question ends the turn: a last line ending in a question mark, past markup", () => {
  expect(asksUser("Pushed it.\n\nShould I open the PR now?")).toBe(true);
  expect(asksUser("Which option do you want: **A or B?**")).toBe(true);
  expect(asksUser("Done?\n\n- a\n- b\n- c\n- d\n- e\n- f\n- g")).toBe(false);
  expect(asksUser("Done. Tests pass.")).toBe(false);
  expect(asksUser("```\nwhy?\n```\nDone.")).toBe(false);
  expect(asksUser(null)).toBe(false);
});

test("G endpoint pr and an unpushed commit of this session, W the agent stops, T it continues once naming workit git push", () => {
  const root = repo("pr");
  commit(root, "a.txt");
  const out = claudeStop(root);
  expect(out.decision).toBe("block");
  expect(out.reason).toContain("feature/x has 1 commit(s) not on origin");
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
});

test("G endpoint commit, or a protected branch, or no Workit workspace, T the stop is allowed", () => {
  const root = repo("commit");
  commit(root, "a.txt");
  expect(claudeStop(root)).toEqual({});

  const onMain = repo("pr");
  git(onMain, "checkout", "-q", "main");
  commit(onMain, "b.txt");
  expect(claudeStop(onMain)).toEqual({});

  const plain = tempRoot("workit-stop-plain-");
  roots.push(plain);
  git(plain, "init", "-q", "-b", "feature/x");
  git(plain, "commit", "-q", "--allow-empty", "-m", "init");
  expect(claudeStop(plain)).toEqual({});
});

test("G endpoint green and the open PR's checks recorded failing at the head, T it continues naming workit ci wait", () => {
  const root = repo("green");
  commit(root, "a.txt");
  git(root, "push", "-q", "origin", "feature/x");
  prCreated(root, 7);
  const head = git(root, "rev-parse", "HEAD");
  appendObserved(root, {
    type: "pr.status",
    actor: actor(SESSION),
    branch: "feature/x",
    head,
    pr: 7,
    checks: "failing",
  });
  const out = claudeStop(root);
  expect(out.decision).toBe("block");
  expect(out.reason).toContain("PR #7's checks were last seen failing");
  expect(out.reason).toContain("`workit ci wait --pr 7`");
  // Passing checks at the head leave only the verdict obligation.
  appendObserved(root, {
    type: "pr.status",
    actor: actor(SESSION),
    branch: "feature/x",
    head,
    pr: 7,
    checks: "passing",
  });
  expect(claudeStop(root).reason).toContain("has no current verdict");
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

test("G Codex Stop, W an unmet obligation, T decision block; stop_hook_active allows", () => {
  const root = repo("pr");
  commit(root, "a.txt", "codex-session-1");
  const stop = (extra: Record<string, unknown> = {}) =>
    dispatchHook(codexAdapter, fixture("codex", "stop", root, extra), {}).json;
  expect(stop()).toEqual({ decision: "block", reason: expect.stringContaining("workit git push") });
  expect(stop({ stop_hook_active: true })).toEqual({});
  expect(stop({ last_assistant_message: "Want me to push?" })).toEqual({});
});

/** Cursor's adapter with `stop` registered (the shipped manifest does not register it yet). */
const cursorWithStop: HostAdapter = {
  ...cursorAdapter,
  descriptor: {
    ...CURSOR_DESCRIPTOR,
    events: { ...CURSOR_DESCRIPTOR.events, stop: { support: "native", native: "stop" } },
  },
};

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
      cursorWithStop,
      fixture("cursor", "stop", root, { transcript_path: transcript, ...extra }),
    ).json;
  say("Committed the change.");
  expect(stop()).toEqual({ followup_message: expect.stringContaining("workit git push") });
  // The shipped descriptor does not register stop yet: never answered.
  expect(
    dispatchHook(cursorAdapter, fixture("cursor", "stop", root, { transcript_path: transcript }))
      .json,
  ).toEqual({});
  expect(stop({ loop_count: 1 })).toEqual({});
  expect(stop({ status: "aborted" })).toEqual({});
  expect(stop({ transcript_path: null })).toEqual({});
  say("Committed. Shall I push it?");
  expect(stop()).toEqual({});
});
