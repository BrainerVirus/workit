import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { TaskStore, WorkitCore, success } from "@/packages/workit-core/src/core";
import definition from "@/packages/workit-opencode/src/v2/plugin";
import { scope, taskStartRequest } from "../workit-core/task-fixtures";
import { injectAgentContext } from "@/packages/workit-opencode/src/v2/injection";
import { registerCommands, registerSkills } from "@/packages/workit-opencode/src/v2/registry";
import {
  WORKIT_METHOD_SKILLS,
  WORKIT_SKILL_ALIASES,
} from "@/packages/workit-core/src/core/skill-manifests";

/** The exact 9 registered Workit tool names in registration order. */
const TOOL_NAMES = [
  "workit_task",
  "workit_policy",
  "workit_evidence",
  "workit_finding",
  "workit_decision",
  "workit_worker",
  "workit_state",
  "workit_context",
  "workit_init_apply",
];

type Registered = {
  name: string;
  description: string;
  input: Record<string, any>;
  options?: { codemode?: boolean };
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content?: string }>;
};

const repository = (branch = "feature/v2-shell") => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workit-v2-shell-"));
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git(["init", "-q", "-b", branch]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "Workit Test"]);
  writeFileSync(path.join(root, "base.txt"), "base\n");
  git(["add", "base.txt"]);
  git(["commit", "-qm", "base"]);
  return root;
};

const harness = async (
  root: string,
  options: {
    parentID?: string;
    sessionDirectory?: string;
    sessions?: Record<string, { parentID?: string }>;
    existingSkills?: Array<{ id: string }>;
    existingCommands?: Array<{ name: string }>;
  } = {},
) => {
  const registered: Registered[] = [];
  const hooks = new Map<string, (event: unknown) => Promise<void>>();
  const permissionHooks = new Map<string, (event: any) => void | Promise<void>>();
  const sessionHooks = new Map<string, (event: any) => void | Promise<void>>();
  const skills: Array<Record<string, any>> = [];
  const commands: Array<Record<string, any>> = [];
  const prompts: Array<Record<string, any>> = [];
  const state = { subscribed: false, ended: false };
  const sessions: Record<string, { parentID?: string }> = {
    ses_v2: options.parentID ? { parentID: options.parentID } : {},
    ...options.sessions,
  };
  const ctx = {
    location: { directory: root },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const spec = sessions[sessionID];
        if (!spec) return null;
        return {
          id: sessionID,
          ...(spec.parentID ? { parentID: spec.parentID } : {}),
          location: { directory: options.sessionDirectory ?? root },
        };
      },
      hook: async (name: string, fn: (event: any) => void | Promise<void>) => {
        sessionHooks.set(name, fn);
      },
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input);
      },
    },
    skill: {
      list: async () => ({ data: options.existingSkills ?? [] }),
      transform: async (fn: (editor: unknown) => void) => {
        await fn({
          list: () => [...(options.existingSkills ?? []), ...skills],
          add: (skill: Record<string, any>) => skills.push(skill),
          get: (id: string) => skills.find((skill) => skill.id === id),
          update: () => {},
          remove: () => {},
        });
      },
    },
    command: {
      list: async () => ({ data: options.existingCommands ?? [] }),
      transform: async (fn: (editor: unknown) => void) => {
        await fn({ add: (command: Record<string, any>) => commands.push(command) });
      },
    },
    permission: {
      hook: async (name: string, fn: (event: any) => void | Promise<void>) => {
        permissionHooks.set(name, fn);
      },
    },
    tool: {
      transform: async (fn: (editor: unknown) => void) => {
        const editor = {
          add: (tool: Registered) => registered.push(tool),
          list: () => registered,
          get: (id: string) => registered.find((tool) => tool.name === id),
          namespace: () => {},
          update: () => {},
          remove: () => {},
        };
        await fn(editor);
        return { dispose: async () => {} };
      },
      hook: async (name: string, fn: (event: unknown) => Promise<void>) => {
        hooks.set(name, fn);
      },
    },
    event: {
      // An event stream with no events: iteration only ends when teardown
      // aborts the signal, which is exactly what cleanup must prove.
      subscribe: ({ signal }: { signal: AbortSignal }) => {
        state.subscribed = true;
        const iterator: AsyncIterator<unknown> = {
          next: async () => {
            while (!signal.aborted) await Bun.sleep(5);
            state.ended = true;
            return { done: true, value: undefined };
          },
        };
        return { [Symbol.asyncIterator]: () => iterator };
      },
    },
  };
  const cleanup = await definition.setup(ctx as never);
  const call = async (name: string, input: unknown, sessionID = "ses_v2") => {
    const tool = registered.find((entry) => entry.name === name);
    if (!tool) throw new Error(`tool ${name} is not registered`);
    const result = await tool.execute(input, { sessionID });
    return JSON.parse(result.content ?? "null");
  };
  return {
    registered,
    hooks,
    permissionHooks,
    sessionHooks,
    skills,
    commands,
    prompts,
    state,
    cleanup,
    call,
  };
};

test("the V2 definition carries the stable workit id and setup", () => {
  expect(definition.id).toBe("workit");
  expect(typeof definition.setup).toBe("function");
});

test("setup registers the exact 9 tools with codemode off and object schemas", async () => {
  const root = repository();
  try {
    const { registered, cleanup } = await harness(root);
    expect(registered.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    expect(registered.some((tool) => tool.name === "workit_external_action")).toBe(false);
    for (const tool of registered) {
      expect(tool.options?.codemode, tool.name).toBe(false);
      expect(tool.input.type, tool.name).toBe("object");
      expect(tool.description.length, tool.name).toBeGreaterThan(0);
    }
    const contextTool = registered.find((tool) => tool.name === "workit_context");
    expect(contextTool?.input.required).toEqual(["kind"]);
    expect(contextTool?.input.additionalProperties).toBe(false);
    expect(contextTool?.input.properties.kind.enum).toEqual([
      "git",
      "pr",
      "youtrack",
      "github_issue",
      "gitlab_issue",
      "changelog",
      "release",
      "affected",
    ]);
    expect(contextTool?.input.properties).not.toHaveProperty("operation");
    const init = registered.find((tool) => tool.name === "workit_init_apply");
    expect(init?.input.required).toEqual(["confirmed", "action"]);
    expect(init?.input.properties.action.enum).toContain("branch_policy");
    expect(cleanup).toBeFunction();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("family tools execute against the session checkout", async () => {
  const root = repository();
  try {
    const { call } = await harness(root);
    const intent = {
      objective: "V2 shell probe",
      scope: { description: "shell", paths: ["docs"], exclusions: [] },
      authorityRefs: [],
    };
    const started = await call("workit_task", { schemaVersion: 1, action: "start", intent });
    expect(started.ok).toBe(true);
    const listed = await call("workit_task", { schemaVersion: 1, action: "list" });
    expect(listed.ok).toBe(true);
    expect(listed.data).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("foreign session locations and child sessions are denied", async () => {
  const root = repository();
  const other = mkdtempSync(path.join(os.tmpdir(), "workit-v2-other-"));
  try {
    const foreign = await harness(root, { sessionDirectory: other });
    const denied = await foreign.call("workit_task", { schemaVersion: 1, action: "list" });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("session location");

    const child = await harness(root, { parentID: "ses_parent" });
    expect(await child.call("workit_context", { kind: "git" })).toMatchObject({ ok: true });
    expect(existsSync(path.join(root, ".workit"))).toBe(false);
    const blocked = await child.call("workit_task", { schemaVersion: 1, action: "list" });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("no validated Workit worker");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("context rejects mutation-shaped arguments without Git or Workit effects", async () => {
  const root = repository();
  try {
    const { call } = await harness(root);
    const before = spawnSync("git", ["status", "--porcelain=v1"], {
      cwd: root,
      encoding: "utf8",
    }).stdout;
    expect(
      await call("workit_context", {
        kind: "git",
        operation: "git.commit",
        payload: { message: "must-not-run" },
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(
      spawnSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }).stdout,
    ).toBe(before);
    expect(existsSync(path.join(root, ".workit"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workit_init_apply runs the shared confirmed executor", async () => {
  const root = repository();
  try {
    const { call } = await harness(root);
    const applied = await call("workit_init_apply", { confirmed: true, action: "gitignore" });
    expect(applied.ok).toBe(true);
    expect(existsSync(path.join(root, ".gitignore"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup registers the subagent lifecycle hooks and an abortable event stream", async () => {
  const root = repository();
  try {
    const { hooks, state, call } = await harness(root, {
      sessions: { ses_child: { parentID: "ses_parent" } },
    });
    expect([...hooks.keys()].toSorted()).toEqual(["execute.after", "execute.before"]);
    expect(state.subscribed).toBe(true);

    // Hooks ignore unrelated tools and deny unmanaged nested launches.
    await hooks.get("execute.before")!({
      tool: "shell",
      sessionID: "ses_v2",
      id: "call_1",
      input: {},
    });
    await expect(
      hooks.get("execute.before")!({
        tool: "subagent",
        sessionID: "ses_child",
        id: "call_2",
        input: {},
      }),
    ).rejects.toThrow(/direct children of the coordinator/);
    await hooks.get("execute.after")!({
      tool: "shell",
      sessionID: "ses_v2",
      id: "call_1",
      input: {},
      status: "completed",
      result: {},
    });
    // Family tools still work with the lifecycle wired in.
    const listed = await call("workit_task", { schemaVersion: 1, action: "list" });
    expect(listed.ok).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup registers every method skill with packaged content and paths", async () => {
  const root = repository();
  try {
    const { skills } = await harness(root);
    for (const skill of skills) {
      expect(skill.content.length, skill.id).toBeGreaterThan(100);
      expect(skill.description?.length, skill.id).toBeGreaterThan(0);
      expect(existsSync(skill.path), skill.id).toBe(true);
      expect(skill.path.endsWith(path.join(skill.id, "SKILL.md")), String(skill.id)).toBe(true);
      expect(skill.content.startsWith("---"), String(skill.id)).toBe(false);
    }
    expect(skills.map((skill): string => skill.id).toSorted()).toEqual(
      [...WORKIT_METHOD_SKILLS].toSorted(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The checkout is a local pin: skills come from the canonical, unrendered source.
test("Given a local source pin, When skills register, Then cross-skill references use OpenCode's load wording", async () => {
  const root = repository();
  try {
    const { skills } = await harness(root);
    const ship = skills.find((skill) => skill.id === "workit-ship")!;
    expect(ship.content).toContain("(call the skill tool with `workit-review`)");
    for (const skill of skills) expect(skill.content, skill.id).not.toMatch(/\(workit-[a-z-]+\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup registers one collision-safe wk command per alias that forwards prompts", async () => {
  const root = repository();
  try {
    const { commands, prompts } = await harness(root);
    expect(commands.map((command): string => command.name).toSorted()).toEqual(
      Object.keys(WORKIT_SKILL_ALIASES).toSorted(),
    );
    const names = commands.map((command) => command.name);
    expect(names).toContain("wk-bdd");
    expect(names).toContain("wk-ship");
    const tdd = commands.find((command) => command.name === "wk-bdd")!;
    const delivery = { mode: "steer" };
    const files = [{ uri: "file:///tmp/a.png" }];
    await tdd.execute({
      sessionID: "ses_v2",
      prompt: { text: "user arguments", files },
      delivery,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ sessionID: "ses_v2", delivery, files });
    expect(prompts[0].text).toContain("workit-bdd");
    expect(prompts[0].text).toContain("user arguments");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing user skills and commands are never replaced", async () => {
  const root = repository();
  try {
    const { skills, commands } = await harness(root, {
      existingSkills: [{ id: "workit-debug" }],
      existingCommands: [{ name: "wk-debug" }],
    });
    // Every packaged skill but the user's colliding one.
    expect(skills).toHaveLength(WORKIT_METHOD_SKILLS.length - 1);
    expect(skills.some((skill) => skill.id === "workit-debug")).toBe(false);
    expect(commands).toHaveLength(WORKIT_METHOD_SKILLS.length - 1);
    expect(commands.some((command) => command.name === "wk-debug")).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Workit alias is omitted when its skill id belongs to a user skill", async () => {
  const root = repository();
  try {
    const { skills, commands } = await harness(root, {
      existingSkills: [{ id: "workit-debug" }],
    });
    expect(skills.some((skill) => skill.id === "workit-debug")).toBe(false);
    expect(commands.some((command) => command.name === "wk-debug")).toBe(false);
    expect(commands).toHaveLength(WORKIT_METHOD_SKILLS.length - 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the implementation skill trigger covers ordinary requested implementation", async () => {
  const root = repository();
  try {
    const { skills } = await harness(root);
    expect(skills.find((skill) => skill.id === "workit-implement")?.description).toContain(
      "Use for implement, build",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup aborts the event subscription", async () => {
  const root = repository();
  try {
    const { state, cleanup } = await harness(root);
    expect(typeof cleanup).toBe("function");
    if (typeof cleanup === "function") void cleanup();
    const start = Date.now();
    while (!state.ended && Date.now() - start < 1000) await Bun.sleep(5);
    expect(state.ended).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("permission evaluate validates only literal noncompliant branch targets", async () => {
  const root = repository();
  const configDir = mkdtempSync(path.join(os.tmpdir(), "workit-v2-shell-config-"));
  const previousEnv = {
    config: process.env.WORKFLOW_TOOLKIT_CONFIG,
    configDir: process.env.WORKFLOW_TOOLKIT_CONFIG_DIR,
    profile: process.env.WORKFLOW_PROFILE,
    workspace: process.env.WORKFLOW_WORKSPACE_NAME,
  };
  delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = configDir;
  delete process.env.WORKFLOW_PROFILE;
  delete process.env.WORKFLOW_WORKSPACE_NAME;
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
    }),
  );
  try {
    const { permissionHooks, call } = await harness(root);
    const evaluate = permissionHooks.get("evaluate")!;
    expect(evaluate).toBeFunction();

    const valid = {
      action: "shell",
      resources: ["git switch -c feature/probe"],
      effect: "allow",
      message: undefined as string | undefined,
    };
    await evaluate(valid);
    expect(valid.effect).toBe("allow");

    const invalid = {
      action: "shell",
      resources: ["git switch -c main"],
      effect: "allow",
      message: undefined as string | undefined,
    };
    await evaluate(invalid);
    expect(invalid.effect).toBe("deny");
    expect(invalid.message).toContain("protected_ref");
    expect(invalid.message).toContain("main");
    expect(invalid.message).toContain("choose a non-protected branch");

    const pr = {
      action: "shell",
      resources: ["gh pr create --fill"],
      effect: "allow",
      message: undefined as string | undefined,
    };
    await evaluate(pr);
    expect(pr.effect).toBe("allow");

    const worktree = {
      action: "shell",
      resources: ["git worktree add ../x"],
      effect: "allow",
      message: undefined as string | undefined,
    };
    await evaluate(worktree);
    expect(worktree.effect).toBe("allow");

    // A host deny remains final and keeps its existing message.
    const explicit = {
      action: "shell",
      resources: ["git switch -c main"],
      effect: "deny",
      message: undefined as string | undefined,
    };
    await evaluate(explicit);
    expect(explicit.message).toBeUndefined();

    const intent = {
      objective: "route probe",
      scope: { description: "probe", paths: ["docs"], exclusions: [] },
      authorityRefs: [],
    };
    await call("workit_task", { schemaVersion: 1, action: "start", intent });
    const activeTaskValid = {
      action: "shell",
      resources: ["git switch -c feature/active"],
      effect: "allow",
      message: undefined as string | undefined,
    };
    await evaluate(activeTaskValid);
    expect(activeTaskValid.effect).toBe("allow");

    const unsupported = {
      action: "shell",
      resources: ['git checkout -b "main"'],
      effect: "ask",
      message: undefined as string | undefined,
    };
    await evaluate(unsupported);
    expect(unsupported.effect).toBe("ask");

    const compound = {
      action: "shell",
      resources: ["git switch -c main && echo done"],
      effect: "allow",
      message: undefined as string | undefined,
    };
    await evaluate(compound);
    expect(compound.effect).toBe("allow");

    // Non-shell actions are never touched.
    const edit = { action: "edit", resources: ["file.txt"], effect: "allow" };
    await evaluate(edit);
    expect(edit.effect).toBe("allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (previousEnv.config === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = previousEnv.config;
    if (previousEnv.configDir === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
    else process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = previousEnv.configDir;
    if (previousEnv.profile === undefined) delete process.env.WORKFLOW_PROFILE;
    else process.env.WORKFLOW_PROFILE = previousEnv.profile;
    if (previousEnv.workspace === undefined) delete process.env.WORKFLOW_WORKSPACE_NAME;
    else process.env.WORKFLOW_WORKSPACE_NAME = previousEnv.workspace;
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("context injects the bootstrap and task context, compaction appends without result", async () => {
  const root = repository();
  try {
    const store = new TaskStore(root);
    const olderCore = new WorkitCore(store, {
      root,
      caller: { host: "opencode", actor: "older-v2-session" },
      capabilities: [],
      constraints: [],
      now: "2025-12-31T00:00:00Z",
    });
    const older = olderCore.task(
      taskStartRequest({
        intent: {
          objective: "parked V2 history",
          scope: { description: "probe", paths: ["."], exclusions: [] },
          authorityRefs: [],
        },
      }),
    );
    expect(older.ok).toBe(true);
    if (!older.ok) throw new Error("older task missing");
    const olderId = (older.data as { id: string }).id;
    const olderTask = store.readTask(olderId);
    const olderWorkspace = store.readWorkspace();
    if (!olderTask.ok || !olderWorkspace.ok || !olderWorkspace.data)
      throw new Error("state missing");
    expect(
      olderCore.task({
        schemaVersion: 1,
        action: "pause",
        taskId: olderId,
        expectedRevision: olderTask.data.revision,
        expectedWorkspaceRevision: olderWorkspace.data.revision,
        reason: "park for later",
      }).ok,
    ).toBe(true);
    const { sessionHooks, call } = await harness(root);
    const context = sessionHooks.get("context")!;
    const compaction = sessionHooks.get("compaction")!;
    expect(context).toBeFunction();
    expect(compaction).toBeFunction();

    const beforeTasks = store.listTasks();
    const beforeWorkspace = store.readWorkspace();
    const empty: Array<{ type: string; text: string }> = [];
    await context({ sessionID: "ses_v2", system: empty });
    // The lead gets the contract and a passive history offer.
    expect(empty.some((part) => part.text.includes("<workit-contract>"))).toBe(true);
    expect(empty.some((part) => part.text.includes("<workit-task-context>"))).toBe(false);
    expect(empty.some((part) => part.text.includes("<workit-history-offer>"))).toBe(true);
    expect(empty.some((part) => part.text.includes("parked V2 history"))).toBe(true);

    const repeated: Array<{ type: string; text: string }> = [];
    await context({ sessionID: "ses_v2", system: repeated });
    expect(repeated.some((part) => part.text.includes("<workit-history-offer>"))).toBe(false);
    expect(store.listTasks()).toEqual(beforeTasks);
    expect(store.readWorkspace()).toEqual(beforeWorkspace);

    const intent = {
      objective: "context probe",
      scope: { description: "probe", paths: ["docs"], exclusions: [] },
      authorityRefs: [],
    };
    await call("workit_task", { schemaVersion: 1, action: "start", intent });
    const withTask: Array<{ type: string; text: string }> = [];
    await context({ sessionID: "ses_v2", system: withTask });
    expect(withTask.some((part) => part.text.includes("<workit-task-context>"))).toBe(true);

    const compacting: Array<{ type: string; text: string }> = [];
    const event: { sessionID: string; system: typeof compacting; result?: unknown } = {
      sessionID: "ses_v2",
      system: compacting,
    };
    await compaction(event);
    expect(compacting.some((part) => part.text.includes("<workit-task-context>"))).toBe(true);
    expect(event.result).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Ported from the retired V1 suites (S18): direct-child worker context,
// rejected native decisions, and per-output compaction dedupe on the V2 path.

const decisionTask = async (call: (name: string, input: unknown) => Promise<any>) => {
  const intent = {
    objective: "decision probe",
    scope: { description: "probe", paths: ["docs"], exclusions: [] },
    authorityRefs: [],
  };
  await call("workit_task", { schemaVersion: 1, action: "start", intent });
  const listed = await call("workit_task", { schemaVersion: 1, action: "list" });
  const inspected = await call("workit_task", {
    schemaVersion: 1,
    action: "inspect",
    taskId: listed.data[0].id,
    view: "full",
  });
  return {
    taskId: inspected.data.task.id as string,
    workspaceId: inspected.data.workspace.id as string,
    scope: inspected.data.task.intent.data.scope,
  };
};

test("workit_decision records an agent-asserted decision without a question", async () => {
  const root = repository();
  try {
    const { call } = await harness(root);
    const { taskId, workspaceId, scope: taskScope } = await decisionTask(call);
    const record = {
      schemaVersion: 1,
      action: "record",
      taskId,
      purpose: "design",
      binding: {
        taskId,
        workspaceId,
        scope: taskScope,
        presented: "Workit decision: design — approve the design?",
        contentRefs: [],
      },
      requirementIds: [],
    };
    const failed = await call("workit_decision", {
      ...record,
      response: "approved",
      expectedRevision: "00000000-0000-4000-8000-000000000000",
    });
    expect(failed).toMatchObject({ ok: false, code: "revision_conflict" });
    const approved = await call("workit_decision", { ...record, response: "approved" });
    expect(approved.ok, JSON.stringify(approved)).toBe(true);
    const rejected = await call("workit_decision", { ...record, response: "rejected" });
    expect(rejected.ok, JSON.stringify(rejected)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each distinct compaction output receives task context exactly once", async () => {
  const root = repository();
  try {
    const { sessionHooks, call } = await harness(root);
    await decisionTask(call);
    const compaction = sessionHooks.get("compaction")!;
    const count = (system: Array<{ text: string }>) =>
      system.filter((part) => part.text.includes("<workit-task-context>")).length;
    const first: Array<{ type: string; text: string }> = [];
    const second: Array<{ type: string; text: string }> = [];
    await compaction({ sessionID: "ses_v2", system: first });
    await compaction({ sessionID: "ses_v2", system: first });
    await compaction({ sessionID: "ses_v2", system: second });
    expect(count(first)).toBe(1);
    expect(count(second)).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const coordinatorCore = (root: string, nativeWorker = false) =>
  new WorkitCore(new TaskStore(root), {
    root,
    caller: { host: "opencode", actor: "coord" },
    capabilities: [],
    constraints: [],
    now: () => "2026-01-01T00:00:00Z",
    ...(nativeWorker
      ? {
          nativeWorker: {
            verifyWorker: ({ expected, caller }: any) =>
              success(null, null, {
                kind: "host_observed",
                host: caller.host,
                session: expected.session,
                workerId: expected.workerId,
              }),
          },
        }
      : {}),
  } as never);

const runningWorker = (
  root: string,
  taskId: string,
  role: "reviewer" | "implementer",
  session: string,
) => {
  const store = new TaskStore(root);
  const revisions = () => {
    const task = store.readTask(taskId);
    const workspace = store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
    return { task: task.data.revision, workspace: workspace.data.revision };
  };
  let current = revisions();
  const assigned = coordinatorCore(root).worker({
    schemaVersion: 1,
    action: "assign",
    taskId,
    expectedRevision: current.task,
    expectedWorkspaceRevision: current.workspace,
    assignment: {
      role,
      objective: "inspect the assigned area",
      scope: scope({ paths: [role === "reviewer" ? "review" : "src"] }),
      decisionIds: [],
      requirementIds: [],
      candidateId: null,
      stoppingCondition: "report the result",
    },
  });
  if (!assigned.ok) throw new Error(assigned.error);
  current = revisions();
  const observed = coordinatorCore(root, true).observeWorkerLifecycle({
    taskId,
    workerId: (assigned.data as { id: string }).id,
    expectedRevision: current.task,
    expectedWorkspaceRevision: current.workspace,
    state: "running",
    session: { kind: "host", host: "opencode", handle: session },
    observation: { event: "worker-started" },
  });
  if (!observed.ok) throw new Error(observed.error);
};

test("direct-child reviewer and implementer contexts are exact and lineage-bound", () => {
  const root = repository();
  try {
    const started = coordinatorCore(root).task(
      taskStartRequest({
        intent: { objective: "worker probe", scope: scope({ paths: ["."] }), authorityRefs: [] },
      }),
    );
    if (!started.ok) throw new Error(started.error);
    const taskId = (started.data as { id: string }).id;
    runningWorker(root, taskId, "reviewer", "reviewer-session");
    runningWorker(root, taskId, "implementer", "implementer-session");
    const children = new Map([
      ["reviewer-session", "coord"],
      ["implementer-session", "coord"],
    ]);
    const contextFor = (id: string, parentID: string) => {
      const system: Array<{ type: string; text: string }> = [];
      injectAgentContext(root, { id, parentID, directory: root }, children, system);
      return system.map((part) => part.text).join("\n");
    };

    const reviewer = contextFor("reviewer-session", "coord");
    expect(reviewer).toContain("<workit-worker-context>");
    expect(reviewer).toContain('"role":"reviewer"');
    expect(reviewer).toContain('"readOnly":true');
    expect(reviewer).not.toContain("<workit-contract>");

    const implementer = contextFor("implementer-session", "coord");
    expect(implementer).toContain("<workit-worker-context>");
    expect(implementer).toContain('"role":"implementer"');
    expect(implementer).toContain('"readOnly":false');
    expect(implementer).toContain('"paths":["src"]');

    // A child whose observed parent is not its recorded coordinator gets none.
    const mismatched = contextFor("reviewer-session", "other-coordinator");
    expect(mismatched).not.toContain("<workit-worker-context>");
    expect(mismatched).not.toContain('"role":"reviewer"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// OpenCode runs transform callbacks when it builds its catalog, not inside
// `transform()` (seen on 2.0.18/2.0.21: the wk-* aliases were missing from
// /api/command). Alias registration must not depend on callback timing.
test("wk-* aliases register even when the host defers transform callbacks", async () => {
  const deferred: Array<() => void> = [];
  const skills: Array<{ id: string }> = [];
  const commands: string[] = [];
  const ctx = {
    skill: {
      list: async () => ({ data: [{ id: "workit-review" }] }),
      transform: async (fn: (editor: any) => void) => {
        deferred.push(() =>
          fn({ list: () => [{ id: "workit-review" }], add: (s: { id: string }) => skills.push(s) }),
        );
      },
    },
    command: {
      list: async () => ({ data: [{ name: "init" }] }),
      transform: async (fn: (editor: any) => void) => {
        deferred.push(() => fn({ add: (c: { name: string }) => commands.push(c.name) }));
      },
    },
    session: { prompt: async () => {} },
  };
  const registered = await registerSkills(ctx);
  await registerCommands(ctx, registered);
  expect(commands).toEqual([]); // nothing ran yet: the host has not built its catalog
  // Catalogs build independently: the command catalog may build first.
  for (const run of deferred.toReversed()) run();
  const aliasesFor = (skill: string) =>
    Object.entries(WORKIT_SKILL_ALIASES)
      .filter(([, target]) => target === skill)
      .map(([alias]) => alias);
  expect(skills.map((s) => s.id).toSorted()).toEqual(
    WORKIT_METHOD_SKILLS.filter((id) => id !== "workit-review").toSorted(),
  );
  for (const [alias, skill] of Object.entries(WORKIT_SKILL_ALIASES))
    expect(commands.includes(alias), alias).toBe(skill !== "workit-review");
  expect(aliasesFor("workit-review").every((alias) => !commands.includes(alias))).toBe(true);
});

// V2 lineage gate (v2/plugin.ts workerIdFor): a persisted running worker bound
// to this child session is not enough — the child must also be a direct child
// the lifecycle observed launching from that coordinator. A child that merely
// claims the coordinator as parent stays denied.
test("a child session with a persisted worker but no observed direct launch is denied", async () => {
  const root = repository();
  try {
    const started = coordinatorCore(root).task(
      taskStartRequest({
        intent: { objective: "lineage probe", scope: scope({ paths: ["."] }), authorityRefs: [] },
      }),
    );
    if (!started.ok) throw new Error(started.error);
    runningWorker(root, (started.data as { id: string }).id, "reviewer", "child-session");
    const { call } = await harness(root, { sessions: { "child-session": { parentID: "coord" } } });
    const result = await call("workit_task", { schemaVersion: 1, action: "list" }, "child-session");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no validated Workit worker");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
