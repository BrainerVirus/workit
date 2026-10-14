// Retro #267 B1/B2: every OpenCode V2 shell and child session carries a real,
// host-derived Workit session id (the lead's OPENCODE_SESSION_ID; a child's
// `<lead>:<child>`), and a child without a Workit worker can still record
// evidence and findings under it.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { hostSessionFromEnv, sessionClaimRefusal } from "@/packages/workit-core/src/host-session";
import definition from "@/packages/workit-opencode/src/v2/plugin";
import {
  applyShellSession,
  noteShellCall,
  settleShellCall,
  type PendingShells,
} from "@/packages/workit-opencode/src/v2/shell-session";
import { childMayRecord } from "@/packages/workit-opencode/src/v2/child-identity";
import { scope, taskStartRequest } from "../workit-core/task-fixtures";

type Registered = {
  name: string;
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content?: string }>;
};

const repository = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workit-v2-identity-"));
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  run(["init", "-q", "-b", "feature/identity"]);
  run(["config", "user.email", "test@example.invalid"]);
  run(["config", "user.name", "Workit Test"]);
  writeFileSync(path.join(root, "base.txt"), "base\n");
  run(["add", "base.txt"]);
  run(["commit", "-qm", "base"]);
  return root;
};

/** The OpenCode V2 plugin context the plugin touches, with a scripted session table. */
const harness = async (root: string, sessions: Record<string, { parentID?: string }>) => {
  const registered: Registered[] = [];
  const toolHooks = new Map<string, (event: any) => Promise<void>>();
  const shellHooks = new Map<string, (event: any) => Promise<void> | void>();
  const noop = async () => ({ dispose: async () => {} });
  const ctx = {
    location: { directory: root },
    session: {
      get: async ({ sessionID }: { sessionID: string }) =>
        sessions[sessionID]
          ? { id: sessionID, ...sessions[sessionID], location: { directory: root } }
          : null,
      hook: noop,
      context: async () => [],
      synthetic: async () => {},
    },
    skill: {
      list: async () => ({ data: [] }),
      transform: async (fn: (editor: unknown) => void) =>
        fn({
          list: () => [],
          add: () => {},
          get: () => undefined,
          update: () => {},
          remove: () => {},
        }),
    },
    command: {
      list: async () => ({ data: [] }),
      transform: async (fn: (editor: unknown) => void) => fn({ add: () => {} }),
    },
    permission: { hook: noop },
    shell: {
      hook: async (name: string, fn: (event: any) => Promise<void> | void) => {
        shellHooks.set(name, fn);
      },
    },
    tool: {
      transform: async (fn: (editor: unknown) => void) => {
        fn({ add: (tool: Registered) => registered.push(tool) });
        return { dispose: async () => {} };
      },
      hook: async (name: string, fn: (event: any) => Promise<void>) => {
        toolHooks.set(name, fn);
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            while (!signal.aborted) await Bun.sleep(5);
            return { done: true, value: undefined };
          },
        }),
      }),
    },
  };
  const teardown = await definition.setup(ctx as never);
  const cleanup = () => {
    if (typeof teardown === "function") void teardown();
  };
  /** One shell tool call from `sessionID`: its env as OpenCode would spawn it. */
  const shell = async (sessionID: string, command: string, inherited: Record<string, string>) => {
    const input = { command };
    await toolHooks.get("execute.before")!({ tool: "shell", sessionID, id: "c1", input });
    const event = { command, cwd: root, timeout: 0, shell: "bash", env: { ...inherited } };
    await shellHooks.get("create.before")!(event);
    // OpenCode's shell tool sets this after the plugin hook (opencode v2.0.28).
    event.env = { ...event.env, OPENCODE_SESSION_ID: sessionID };
    return event.env as NodeJS.ProcessEnv;
  };
  const call = async (name: string, input: unknown, sessionID: string) => {
    const tool = registered.find((entry) => entry.name === name)!;
    return JSON.parse((await tool.execute(input, { sessionID })).content ?? "null");
  };
  return { shell, call, cleanup };
};

test("Given OpenCode V2, When the lead and a child run workit in their shells, Then each acts as its own host session and the child's derived id passes the verdict check", async () => {
  const root = repository();
  const plugin = await harness(root, { ses_lead: {}, ses_child: { parentID: "ses_lead" } });
  try {
    // An outer host's pair (Codex or Claude Code launched OpenCode) never stands in.
    const outer = { WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "outer-1" };
    const lead = await plugin.shell("ses_lead", "workit ledger check", outer);
    expect(lead.WORKIT_HOST).toBe("opencode");
    expect(hostSessionFromEnv(lead)).toEqual({ host: "opencode", session: "ses_lead" });
    const child = await plugin.shell("ses_child", "workit ledger check", outer);
    expect(child.WORKIT_SESSION_ID).toBe("ses_lead:ses_child");
    expect(hostSessionFromEnv(child).session).toBe("ses_lead:ses_child");
    expect(sessionClaimRefusal(child, "ses_lead:ses_child")).toBeNull();
    // The lead hand-minting a verifier id in its own shell is refused.
    expect(sessionClaimRefusal(lead, "ses_lead-v1")?.error).toContain("forged_session");
  } finally {
    plugin.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Given the same command in flight from two sessions, Then the shell gets no derived id rather than a wrong one", async () => {
  const pending: PendingShells = new Map();
  noteShellCall(pending, { sessionID: "ses_a", input: { command: "ls" } });
  noteShellCall(pending, { sessionID: "ses_b", input: { command: "ls" } });
  const event = { command: "ls", env: {} as Record<string, string | undefined> };
  await applyShellSession(pending, event, async () => "ses_lead");
  expect(event.env).toEqual({ WORKIT_HOST: "opencode" });
  // A denied call that never created a shell is forgotten.
  settleShellCall(pending, { sessionID: "ses_b", input: { command: "ls" } });
  expect(pending.size).toBe(0);
});

test("Given an OpenCode child session without a Workit worker, When it records a finding, Then it is recorded under <lead>:<child>; other operations stay denied", async () => {
  const root = repository();
  const plugin = await harness(root, { ses_lead: {}, ses_child: { parentID: "ses_lead" } });
  try {
    const finding = {
      schemaVersion: 1,
      action: "record",
      claim: "an edge case is untested",
      consequence: "a regression can ship",
      scope: scope(),
      candidateId: null,
      refs: [],
    };
    const early = await plugin.call("workit_finding", finding, "ses_child");
    expect(early).toMatchObject({ ok: false, code: "not_found" });
    const started = new WorkitCore(new TaskStore(root), {
      root,
      caller: { host: "opencode", actor: "ses_lead" },
      capabilities: [],
      constraints: [],
      now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    }).task(
      taskStartRequest({
        intent: { objective: "identity", scope: scope({ paths: ["."] }), authorityRefs: [] },
      }),
    );
    expect(started.ok).toBe(true);
    const recorded = await plugin.call("workit_finding", finding, "ses_child");
    expect(recorded.ok).toBe(true);
    expect(recorded.data.provenance.session).toMatchObject({ handle: "ses_lead:ses_child" });
    const denied = await plugin.call(
      "workit_task",
      { schemaVersion: 1, action: "list" },
      "ses_child",
    );
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("no validated Workit worker: as ses_lead:ses_child");
  } finally {
    plugin.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a child without a worker may only record evidence and findings", () => {
  expect(childMayRecord("evidence", { action: "record" })).toBe(true);
  expect(childMayRecord("finding", { action: "record" })).toBe(true);
  expect(childMayRecord("finding", { action: "resolve" })).toBe(false);
  expect(childMayRecord("task", { action: "inspect" })).toBe(false);
  expect(childMayRecord("worker", { action: "assign" })).toBe(false);
});
