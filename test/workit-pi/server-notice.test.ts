// #328 on Pi: a dev server is rewritten in place to `workit run --bg -- <cmd>`
// (tool_call mutates event.input.command), and a background process's RSS
// notice reaches the owner session once, on its next user turn
// (before_agent_start) or tool result, whichever comes first.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import extension from "@/packages/workit-pi/extensions/workit";
import { noticeFile } from "@/packages/workit-core/src/core/procs";
import { useConfigHome, type ConfigHome } from "@/test/shared/grant-home";
import { tempRoot } from "@/test/workit-core/hooks/hook-fixtures";

const roots: string[] = [];
const saved = { PATH: process.env.PATH, WORKIT_STATE_DIR: process.env.WORKIT_STATE_DIR };
let home: ConfigHome;
let state: string;
beforeEach(() => {
  home = useConfigHome("workit-pi-server-home-");
  writeFileSync(
    path.join(home.configDir, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
    }),
  );
  const bin = mkdtempSync(path.join(tmpdir(), "workit-pi-server-bin-"));
  writeFileSync(path.join(bin, "workit"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "workit"), 0o755);
  state = mkdtempSync(path.join(tmpdir(), "workit-pi-server-state-"));
  roots.push(bin, state);
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
  process.env.WORKIT_STATE_DIR = state;
});
afterEach(() => {
  home.restore();
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const repo = () => {
  const root = tempRoot("workit-pi-server-");
  roots.push(root);
  spawnSync("git", ["init", "-q", "-b", "feature/x"], { cwd: root });
  spawnSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"],
    { cwd: root },
  );
  mkdirSync(path.join(root, ".git", "workit"), { recursive: true });
  return root;
};

const setup = async (root: string) => {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const pi = {
    registerTool: () => undefined,
    on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, handler),
    appendEntry: () => undefined,
    sendMessage: () => undefined,
  };
  await extension(pi as any);
  const ctx = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "pi-session",
      getSessionFile: () => "/tmp/pi-session.jsonl",
      getCwd: () => root,
      getEntries: () => [],
      getBranch: () => [],
    },
    ui: { confirm: async () => true, select: async () => "approved" },
  } as any;
  const turn = async () =>
    (
      (await handlers.get("before_agent_start")!(
        {
          type: "before_agent_start",
          messageType: "user",
          prompt: "",
          systemPrompt: "",
          systemPromptOptions: {},
        },
        ctx,
      )) as { message?: { content: string } } | undefined
    )?.message?.content ?? "";
  const result = async () => {
    const answer = (await handlers.get("tool_result")!(
      {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "c1",
        input: { command: "ls" },
        content: [{ type: "text", text: "a.txt" }],
        isError: false,
      },
      ctx,
    )) as { content?: Array<{ text?: string }> } | undefined;
    return (answer?.content ?? []).map((part) => part.text ?? "").join("\n");
  };
  const call = async (command: string) => {
    const input = { command };
    const answer = await handlers.get("tool_call")!(
      { type: "tool_call", toolName: "bash", toolCallId: "c1", input },
      ctx,
    );
    return { answer, command: input.command };
  };
  return { turn, result, call };
};

const writeNotice = (id: string) => {
  const file = noticeFile(process.env, "pi-session");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      session: "pi-session",
      notices: [
        {
          id,
          cmd: "npm run dev",
          cwd: "/w",
          rssBytes: 3221225472,
          ceilingBytes: 2147483648,
          restart: `workit run --bg --restart ${id}`,
          at: "2026-11-18T00:00:00.000Z",
        },
      ],
    }),
  );
  return file;
};

test("Given `ng serve --port 4200` on Pi, When tool_call runs, Then the command is rewritten to workit run --bg and not blocked", async () => {
  const { call } = await setup(repo());
  expect(await call("ng serve --port 4200")).toEqual({
    answer: undefined,
    command: "workit run --bg -- ng serve --port 4200",
  });
});

test("Given a notice file for the Pi session, When the next user turn starts, Then before_agent_start delivers it once", async () => {
  const { turn, result } = await setup(repo());
  const file = writeNotice("p1turn");
  expect(await turn()).toContain("`workit run --bg --restart p1turn`");
  expect(existsSync(file)).toBe(false);
  expect(await turn()).not.toContain("p1turn");
  expect(await result()).not.toContain("p1turn");
});

test("Given a notice file for the Pi session mid-run, When the next tool result comes back, Then it rides that result once", async () => {
  const { result } = await setup(repo());
  writeNotice("p2tool");
  expect(await result()).toContain("`workit run --bg --restart p2tool`");
  expect(await result()).not.toContain("p2tool");
});
