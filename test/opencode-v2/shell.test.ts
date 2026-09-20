import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import definition from "@/packages/workit-opencode/src/v2/plugin";

/** The exact 10 registered Workit tool names in registration order. */
const TOOL_NAMES = [
  "workit_task",
  "workit_policy",
  "workit_evidence",
  "workit_finding",
  "workit_decision",
  "workit_worker",
  "workit_writer",
  "workit_state",
  "workit_external_action",
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

test("setup registers the exact 10 tools with codemode off and object schemas", async () => {
  const root = repository();
  try {
    const { registered, cleanup } = await harness(root);
    expect(registered.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    for (const tool of registered) {
      expect(tool.options?.codemode, tool.name).toBe(false);
      expect(tool.input.type, tool.name).toBe("object");
      expect(tool.description.length, tool.name).toBeGreaterThan(0);
    }
    const external = registered.find((tool) => tool.name === "workit_external_action");
    expect(external?.input.properties.operation.enum).toEqual([
      "git.branch_setup",
      "git.commit",
      "git.push",
      "hosting.pull_request",
      "hosting.merge",
      "youtrack.update",
      "youtrack.time",
      "youtrack.meeting",
      "changelog.apply",
      "context.read",
    ]);
    expect(external?.input.required).toEqual(["operation", "payload"]);
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
    const blocked = await child.call("workit_task", { schemaVersion: 1, action: "list" });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("no validated Workit worker");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("workit_external_action runs context.read and refuses unported mutations", async () => {
  const root = repository();
  try {
    const { call } = await harness(root);
    const read = await call("workit_external_action", {
      operation: "context.read",
      payload: { kind: "git" },
    });
    expect(read.ok).toBe(true);
    const mutation = await call("workit_external_action", {
      operation: "git.commit",
      payload: { message: "chore: probe" },
    });
    expect(mutation.ok).toBe(false);
    expect(mutation.code).toBe("capability_unavailable");
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
    expect([...hooks.keys()].sort()).toEqual(["execute.after", "execute.before"]);
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

test("setup registers 14 method skills with packaged content and locations", async () => {
  const root = repository();
  try {
    const { skills } = await harness(root);
    expect(skills).toHaveLength(14);
    for (const skill of skills) {
      expect(skill.content.length, skill.id).toBeGreaterThan(100);
      expect(skill.description?.length, skill.id).toBeGreaterThan(0);
      expect(existsSync(skill.location), skill.id).toBe(true);
      expect(skill.location.endsWith(path.join(skill.id, "SKILL.md")), String(skill.id)).toBe(true);
      expect(skill.content.startsWith("---"), String(skill.id)).toBe(false);
    }
    expect(skills.map((skill) => skill.id).sort()).toEqual([
      "workit-babysit",
      "workit-behavioral-tdd",
      "workit-blast-radius",
      "workit-challenge",
      "workit-debug",
      "workit-deslop",
      "workit-diagram",
      "workit-green-run",
      "workit-handoff",
      "workit-implement",
      "workit-mockup",
      "workit-plan",
      "workit-review",
      "workit-steer",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup registers 14 collision-safe wk commands that forward prompts", async () => {
  const root = repository();
  try {
    const { commands, prompts } = await harness(root);
    expect(commands).toHaveLength(14);
    const names = commands.map((command) => command.name);
    expect(names).toContain("wk-tdd");
    expect(names).toContain("wk-babysit");
    const tdd = commands.find((command) => command.name === "wk-tdd")!;
    const delivery = { mode: "steer" };
    const files = [{ uri: "file:///tmp/a.png" }];
    await tdd.execute({
      sessionID: "ses_v2",
      prompt: { text: "user arguments", files },
      delivery,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ sessionID: "ses_v2", delivery, files });
    expect(prompts[0].text).toContain("workit-behavioral-tdd");
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
    expect(skills).toHaveLength(13);
    expect(skills.some((skill) => skill.id === "workit-debug")).toBe(false);
    expect(commands).toHaveLength(13);
    expect(commands.some((command) => command.name === "wk-debug")).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup aborts the event subscription", async () => {
  const root = repository();
  try {
    const { state, cleanup } = await harness(root);
    expect(typeof cleanup).toBe("function");
    if (typeof cleanup === "function") cleanup();
    const start = Date.now();
    while (!state.ended && Date.now() - start < 1000) await Bun.sleep(5);
    expect(state.ended).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const workitQuestion = (presented: string, approved: string) => ({
  questions: [
    {
      header: "Workit decision: design",
      question: presented,
      options: [
        { label: "approved", description: approved },
        { label: "rejected", description: "Reject this decision" },
      ],
    },
  ],
});

test("question results mint one consume-once decision receipt", async () => {
  const root = repository();
  try {
    const { hooks, call } = await harness(root);
    const intent = {
      objective: "receipt probe",
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
    const taskId = inspected.data.task.id as string;
    const workspaceId = inspected.data.workspace.id as string;
    const scope = inspected.data.task.intent.data.scope;
    const presented = "Workit decision: design — approve the probe?";
    const approved = "Approve the probe.";
    await hooks.get("execute.after")!({
      tool: "question",
      sessionID: "ses_v2",
      id: "call_q1",
      input: workitQuestion(presented, approved),
      status: "completed",
      result: { metadata: { answers: { q0: "approved" } } },
    });
    const record = {
      schemaVersion: 1,
      action: "record",
      taskId,
      purpose: "design",
      binding: {
        taskId,
        workspaceId,
        scope,
        presented,
        approvedContent: approved,
        contentRefs: [],
      },
      response: "approved",
      requirementIds: [],
    };
    const recorded = await call("workit_decision", record);
    expect(recorded.ok).toBe(true);
    // The receipt is consumed once: a replay finds nothing to bind.
    const replay = await call("workit_decision", record);
    expect(replay.ok).toBe(false);
    expect(replay.code).toBe("permission_denied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("permission evaluate denies worktrees always and routes only with a live task", async () => {
  const root = repository();
  try {
    const { permissionHooks, call } = await harness(root);
    const evaluate = permissionHooks.get("evaluate")!;
    expect(evaluate).toBeFunction();

    // No live task: recognized routes keep their configured decision.
    const idle = {
      action: "shell",
      resources: ["git switch -c probe"],
      effect: "allow",
      message: undefined as string | undefined,
    };
    await evaluate(idle);
    expect(idle.effect).toBe("allow");

    // Worktree commands are denied regardless of task state.
    const worktree = {
      action: "shell",
      resources: ["git worktree add ../x"],
      effect: "allow",
      message: undefined as string | undefined,
    };
    await evaluate(worktree);
    expect(worktree.effect).toBe("deny");
    expect(worktree.message).toContain("worktrees");

    // Explicit configured denies stay final.
    const explicit = {
      action: "shell",
      resources: ["git worktree add ../x"],
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
    const route = {
      action: "shell",
      resources: ["git switch -c probe"],
      effect: "allow",
      message: undefined as string | undefined,
    };
    await evaluate(route);
    expect(route.effect).toBe("deny");
    expect(route.message).toContain("git.branch_setup");

    // Unrelated and unparseable commands keep their configured behavior.
    const unrelated = {
      action: "shell",
      resources: ["echo hi"],
      effect: "allow",
      message: undefined as string | undefined,
    };
    await evaluate(unrelated);
    expect(unrelated.effect).toBe("allow");
    const unparseable = {
      action: "shell",
      resources: ["git switch -c `x`"],
      effect: "ask",
      message: undefined as string | undefined,
    };
    await evaluate(unparseable);
    expect(unparseable.effect).toBe("ask");

    // Non-shell actions are never touched.
    const edit = { action: "edit", resources: ["file.txt"], effect: "allow" };
    await evaluate(edit);
    expect(edit.effect).toBe("allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context injects the bootstrap and task context, compaction appends without result", async () => {
  const root = repository();
  try {
    const { sessionHooks, call } = await harness(root);
    const context = sessionHooks.get("context")!;
    const compaction = sessionHooks.get("compaction")!;
    expect(context).toBeFunction();
    expect(compaction).toBeFunction();

    const empty: Array<{ type: string; text: string }> = [];
    await context({ sessionID: "ses_v2", system: empty });
    // No live task yet: the lead still gets the contract bootstrap.
    expect(empty.some((part) => part.text.includes("<workit-contract>"))).toBe(true);
    expect(empty.some((part) => part.text.includes("<workit-task-context>"))).toBe(false);

    // Markers dedupe within the same event.
    await context({ sessionID: "ses_v2", system: empty });
    expect(empty.filter((part) => part.text.includes("<workit-contract>"))).toHaveLength(1);

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
