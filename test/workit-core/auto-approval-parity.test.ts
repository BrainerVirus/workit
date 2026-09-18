import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { taskStartRequest } from "./task-fixtures";

/**
 * Auto-approval parity: the same standing rule produces the same outcome —
 * execution with no question — on OpenCode, Pi, and the CLI. Each test
 * builds a repo, an active lead task, writer ownership, a staged change,
 * and a matching workspace rule, then drives the host's own external-action
 * surface and asserts the commit lands with zero confirmations.
 */

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd });

const setupTask = (host: "opencode" | "pi" | "workit_cli", actor: string) => {
  const root = mkdtempSync(join(tmpdir(), "workit-auto-parity-"));
  for (const args of [
    ["init", "-q", "-b", "feature/auto"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Workit Test"],
  ])
    git(root, args);
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, ["add", "base.txt"]);
  git(root, ["commit", "-qm", "base"]);
  const store = new TaskStore(root);
  const core = new WorkitCore(store, {
    root,
    caller: { host, actor },
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as { id: string }).id;
  const task = store.readTask(taskId);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  const writer = core.writer({
    schemaVersion: 1,
    action: "acquire",
    taskId,
    expectedRevision: task.data.revision,
    expectedWorkspaceRevision: workspace.data.revision,
    workerId: null,
  });
  if (!writer.ok) throw new Error(writer.error);
  writeFileSync(join(root, "change.txt"), "change\n");
  git(root, ["add", "change.txt"]);
  const configDir = mkdtempSync(join(tmpdir(), "workit-autocfg-"));
  writeFileSync(
    join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "auto", glob: `${root}/**`, autoApprove: ["commit"] }],
    }),
  );
  const previous = process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = configDir;
  return {
    root,
    configDir,
    taskId,
    cleanup: () => {
      if (previous === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
      else process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = previous;
      rmSync(root, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    },
  };
};

const committed = (root: string): string =>
  spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: root, encoding: "utf8" }).stdout.trim();

test("OpenCode executes a commit with no question under a standing rule", async () => {
  const actor = "opencode-auto";
  const value = setupTask("opencode", actor);
  try {
    const { NativeReceiptStore, createWorkitTools } =
      await import("@/packages/workit-opencode/src/tools/workit");
    const receipts = new NativeReceiptStore();
    const tools = createWorkitTools({
      receipts,
      client: { session: { get: async () => ({ data: { id: actor, directory: value.root } }) } },
    }) as any;
    const out = await tools.workit_external_action.execute(
      { operation: "git.commit", payload: { message: "chore(auto): opencode one" } },
      { directory: value.root, sessionID: actor },
    );
    const parsed = JSON.parse(typeof out === "string" ? out : out.output);
    expect(parsed.ok).toBe(true);
    expect(committed(value.root)).toBe("chore(auto): opencode one");
  } finally {
    value.cleanup();
  }
});

test("Pi executes a commit with zero confirms under a standing rule", async () => {
  const actor = "pi-session";
  const value = setupTask("pi", actor);
  try {
    const { default: extension } = await import("@/packages/workit-pi/extensions/workit");
    const handlers = new Map();
    const pi: any = {
      tools: [],
      commands: [],
      sent: [],
      registerTool(t: any) {
        pi.tools.push(t);
      },
      registerCommand(c: any, o: any) {
        pi.commands.push({ name: c, ...o });
      },
      sendUserMessage(c: any, o: any) {
        pi.sent.push({ content: c, options: o });
      },
      on(name: string, h: any) {
        handlers.set(name, h);
      },
    };
    await extension(pi);
    const action = pi.tools.find((tool: any) => tool.name === "workit_external_action");
    let confirms = 0;
    const ctx: any = {
      cwd: value.root,
      hasUI: false,
      mode: "json",
      isProjectTrusted: () => true,
      sessionManager: {
        getSessionId: () => actor,
        getSessionFile: () => "",
        getCwd: () => value.root,
        getEntries: () => [],
        getBranch: () => [],
      },
      ui: {
        confirm: async () => {
          confirms += 1;
          return true;
        },
        select: async () => "approved",
      },
    };
    const result = await action.execute(
      "auto-call",
      { operation: "git.commit", payload: { message: "chore(auto): pi one" } },
      undefined,
      undefined,
      ctx,
    );
    expect(result.details).toMatchObject({ ok: true });
    expect(confirms).toBe(0);
    expect(committed(value.root)).toBe("chore(auto): pi one");
  } finally {
    value.cleanup();
  }
});

test("CLI executes a commit headless with no TTY under a standing rule", async () => {
  const value = setupTask("workit_cli", "cli");
  try {
    const { runActionCommand } = await import("@/packages/workit-cli/src/task");
    const out: string[] = [];
    const err: string[] = [];
    const code = await runActionCommand(
      [
        "git.commit",
        "--payload",
        JSON.stringify({ message: "chore(auto): cli one" }),
        "--confirm",
        "--json",
      ],
      {
        cwd: value.root,
        out: { write: (s: string) => out.push(s) } as any,
        err: { write: (s: string) => err.push(s) } as any,
        stdinIsTTY: () => false,
      } as any,
    );
    expect(code).toBe(0);
    expect(committed(value.root)).toBe("chore(auto): cli one");
  } finally {
    value.cleanup();
  }
});
