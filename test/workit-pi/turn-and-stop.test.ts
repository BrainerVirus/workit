// Pi's per-turn hooks: before_agent_start carries the skill prompt nudge
// (with the contract, alone as workit-skill, or with changed task context)
// and keeps no digest for an untrusted project; agent_end continues a run
// once when it ends with a provable unmet obligation.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import extension from "@/packages/workit-pi/extensions/workit";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { appendHookObserved } from "@/packages/workit-core/src/ledger";
import { useConfigHome, type ConfigHome } from "@/test/shared/grant-home";
import { startTask, tempRoot } from "@/test/workit-core/hooks/hook-fixtures";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

let home: ConfigHome;
beforeEach(() => {
  home = useConfigHome("workit-pi-turn-home-");
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

/** A Workit checkout on feature/x whose workspace endpoint is `pr`. */
const repo = () => {
  const parent = tempRoot("workit-pi-turn-");
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
  return root;
};

const setup = async (root: string, trusted = true) => {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const sent: Array<{ message: any; options: any }> = [];
  const pi = {
    registerTool: () => undefined,
    on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, handler),
    appendEntry: () => undefined,
    sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
  };
  await extension(pi as any);
  const ctx = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => trusted,
    sessionManager: {
      getSessionId: () => "pi-session",
      getSessionFile: () => "/tmp/pi-session.jsonl",
      getCwd: () => root,
      getEntries: () => [],
      getBranch: () => [],
    },
    ui: { confirm: async () => true, select: async () => "approved" },
  } as any;
  const turn = async (prompt = ""): Promise<{ customType: string; content: string } | undefined> =>
    (
      (await handlers.get("before_agent_start")!(
        { type: "before_agent_start", prompt, systemPrompt: "", systemPromptOptions: {} },
        ctx,
      )) as { message?: { customType: string; content: string } } | undefined
    )?.message;
  const end = async (text: string) =>
    handlers.get("agent_end")!(
      {
        type: "agent_end",
        messages: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          { role: "assistant", content: [{ type: "text", text }] },
        ],
      },
      ctx,
    );
  return { turn, end, sent };
};

const progress = (root: string, taskId: string, nextAction: string) => {
  const done = new WorkitCore(new TaskStore(root), {
    root,
    caller: { host: "workit_cli", actor: "cli" },
    callerAttested: true,
    capabilities: [],
    constraints: [],
    now: "2026-01-02T00:00:00Z",
  }).task({
    schemaVersion: 1,
    action: "progress",
    taskId,
    progress: { summary: "progress", nextAction, blockers: [] },
  });
  if (!done.ok) throw new Error(done.error);
};

test("G a trusted Pi session, W prompts ask for skills, T the nudge rides the first turn's contract, alone as workit-skill on a no-change turn, and with changed context", async () => {
  const root = repo();
  const taskId = startTask(root, { host: "pi", actor: "pi-session" }, "pi nudge task");
  const { turn } = await setup(root);
  const first = await turn("let's brainstorm the token names");
  expect(first?.customType).toBe("workit-context");
  expect(first?.content).toContain("Current task context:");
  expect(first?.content).toContain("looks like workit-shape work");
  const quiet = await turn("the dialog test is flaky");
  expect(quiet).toEqual({
    customType: "workit-skill",
    content: expect.stringContaining("looks like workit-debug work"),
    display: false,
  } as never);
  expect(await turn("thanks")).toBeUndefined();
  progress(root, taskId, "write the parser test");
  const changed = await turn("can you review PR 12");
  expect(changed?.customType).toBe("workit-context");
  expect(changed?.content).toContain("write the parser test");
  expect(changed?.content).toContain("looks like workit-review work");
  expect(changed?.content).not.toContain("Workit is optional coordination");
});

test("G an untrusted Pi project, T no per-turn digest is written and the second turn sends nothing", async () => {
  const root = repo();
  startTask(root, { host: "pi", actor: "pi-session" }, "untrusted task");
  const { turn } = await setup(root, false);
  expect((await turn())?.content).toContain("unavailable until Pi trusts this project");
  const hooks = path.join(root, ".git", "workit", "hooks");
  const digests = (() => {
    try {
      return readdirSync(hooks).filter((name) => name.startsWith("turn-"));
    } catch {
      return [];
    }
  })();
  expect(digests).toEqual([]);
  expect(await turn()).toBeUndefined();
});

test("G a Pi run that ends with an unpushed commit under endpoint pr, W agent_end, T one triggered follow-up turn; its own end, a question, or an untrusted project stop freely", async () => {
  const root = repo();
  writeFileSync(path.join(root, "a.txt"), "a\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "feat: a");
  const sha = git(root, "rev-parse", "HEAD");
  appendHookObserved(root, {
    type: "commit.recorded",
    actor: { host: "pi", session: "pi-session", agentId: null },
    branch: "feature/x",
    head: sha,
    sha,
    session: "pi-session",
    agentId: null,
    subject: "feat: a",
    files: ["a.txt"],
    fileCount: 1,
  });
  const { end, sent } = await setup(root);
  await end("Committed the change.");
  expect(sent).toEqual([
    {
      message: {
        customType: "workit-stop",
        content: expect.stringContaining("`workit git push`"),
        display: true,
      },
      options: { triggerTurn: true, deliverAs: "followUp" },
    },
  ]);
  // The run that continuation started ends freely.
  await end("Still committed.");
  expect(sent).toHaveLength(1);
  // A later run is continued again, once; a question to the user never.
  await end("Committed again.");
  expect(sent).toHaveLength(2);
  await end("Done.");
  await end("Should I push it now?");
  expect(sent).toHaveLength(2);
  const untrusted = await setup(root, false);
  await untrusted.end("Committed the change.");
  expect(untrusted.sent).toEqual([]);
});
