// OpenCode stop control: a main session that goes idle with a provable unmet
// obligation gets one synthetic message that resumes it; the run that
// message starts, a child session, a question or another checkout stop freely.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendHookObserved } from "@/packages/workit-core/src/ledger";
import { createStopControl, lastAssistantText } from "@/packages/workit-opencode/src/v2/stop";
import { useConfigHome, type ConfigHome } from "@/test/shared/grant-home";
import { tempRoot } from "@/test/workit-core/hooks/hook-fixtures";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

let home: ConfigHome;
beforeEach(() => {
  home = useConfigHome("workit-oc-stop-home-");
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

/** feature/x with one unpushed commit of `ses_main`, workspace endpoint pr. */
const repo = () => {
  const parent = tempRoot("workit-oc-stop-");
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
          autonomy: { push: true, pr: true },
          defaultEndpoint: "pr",
        },
      ],
    }),
  );
  writeFileSync(path.join(root, "a.txt"), "a\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "feat: a");
  const sha = git(root, "rev-parse", "HEAD");
  // Every session below recorded the commit, so each one's stop would owe a
  // push: only the session checks tell them apart.
  for (const session of SESSIONS)
    appendHookObserved(root, {
      type: "commit.recorded",
      actor: { host: "opencode", session, agentId: null },
      branch: "feature/x",
      head: sha,
      sha,
      session,
      agentId: null,
      subject: "feat: a",
      files: ["a.txt"],
      fileCount: 1,
    });
  return root;
};

const SESSIONS = [
  "ses_main",
  "ses_twin",
  "ses_child",
  "ses_elsewhere",
  "ses_interrupted",
  "ses_failed",
  "ses_running",
];

const assistant = (text: string) => ({
  type: "assistant",
  content: [
    { type: "reasoning", text: "thinking" },
    { type: "text", text },
  ],
});

test("the last assistant message's text parts are read, tool steps skipped", () => {
  expect(
    lastAssistantText([assistant("first"), { type: "user", content: [] }, assistant("last")]),
  ).toBe("last");
  expect(lastAssistantText([{ type: "user", content: [{ type: "text", text: "hi" }] }])).toBeNull();
});

test("G an idle main session that succeeded with an unpushed commit under endpoint pr, T one resuming synthetic message; the continued run, a child, another checkout, an interrupted or failed run, or a question stop", async () => {
  const root = repo();
  let last = "Committed the change.";
  const resumed: Array<[string, string]> = [];
  type Facts = {
    id: string;
    parentID?: string;
    directory: string;
    outcome?: "succeeded" | "failed" | "interrupted";
  };
  const sessions: Record<string, Facts> = {
    ses_main: { id: "ses_main", directory: root, outcome: "succeeded" },
    ses_twin: { id: "ses_twin", directory: root, outcome: "succeeded" },
    ses_child: { id: "ses_child", parentID: "ses_main", directory: root, outcome: "succeeded" },
    ses_elsewhere: { id: "ses_elsewhere", directory: path.dirname(root), outcome: "succeeded" },
    ses_interrupted: { id: "ses_interrupted", directory: root, outcome: "interrupted" },
    ses_failed: { id: "ses_failed", directory: root, outcome: "failed" },
    ses_running: { id: "ses_running", directory: root },
  };
  const control = createStopControl(root, {
    getSession: async (id) => sessions[id] ?? null,
    messages: async () => [assistant(last)],
    resume: async (id, text) => resumed.push([id, text]),
  });
  expect(await control.onIdle("ses_main")).toBe(true);
  expect(resumed).toEqual([["ses_main", expect.stringContaining("`workit git push`")]]);
  // The run that synthetic message started goes idle freely.
  expect(await control.onIdle("ses_main")).toBe(false);
  for (const id of ["ses_child", "ses_elsewhere", "ses_interrupted", "ses_failed", "ses_running"])
    expect(await control.onIdle(id), id).toBe(false);
  expect(resumed).toHaveLength(1);
  last = "Committed. Do you want me to push?";
  expect(await control.onIdle("ses_twin")).toBe(false);
  // The same facts without the question: the twin owes the push too.
  last = "Committed the change.";
  expect(await control.onIdle("ses_twin")).toBe(true);
  expect(resumed).toHaveLength(2);
  // A failing port fails open.
  const broken = createStopControl(root, {
    getSession: async () => {
      throw new Error("down");
    },
    messages: async () => [],
    resume: async () => undefined,
  });
  expect(await broken.onIdle("ses_main")).toBe(false);
});
