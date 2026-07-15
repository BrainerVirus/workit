import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { adaptPluginHandoffClient, createHandoffTools, handoffSession } from "../src/tools/handoff";
import { WorkflowStateStore } from "../src/state";

const request = {
  directory: "/repo",
  title: "Continue x",
  prompt: "Continue",
  stay: false,
};

test("handoff creates a top-level session, seeds it, then selects it", async () => {
  const calls: string[] = [];
  const createBodies: unknown[] = [];
  const client = {
    session: {
      async create(input: { body: unknown }) {
        calls.push("create");
        createBodies.push(input.body);
        return { data: { id: "child-1" } };
      },
      async promptAsync(input: { path: { id: string } }) {
        calls.push(`seed:${input.path.id}`);
        return { data: undefined };
      },
    },
    tui: {
      async selectSession(input: { body: { sessionID: string } }) {
        calls.push(`select:${input.body.sessionID}`);
        return { data: true };
      },
    },
  };

  const result = await handoffSession(client, request);

  expect(calls).toEqual(["create", "seed:child-1", "select:child-1"]);
  expect(createBodies).toEqual([{ title: "Continue x" }]);
  expect(result).toEqual({
    ok: true,
    data: { sessionID: "child-1", seeded: true, selected: true },
    error: null,
  });
});

test("selection failure preserves the seeded session ID", async () => {
  const client = {
    session: {
      async create() { return { data: { id: "child-2" } }; },
      async promptAsync() { return { data: undefined }; },
    },
    tui: { async selectSession() { throw new Error("no TUI"); } },
  };

  const result = await handoffSession(client, { ...request, stay: false });

  expect(result).toEqual({
    ok: false,
    data: { sessionID: "child-2", seeded: true, selected: false, stage: "select" },
    error: "no TUI",
  });
});

test("false selection response preserves the seeded session ID", async () => {
  const client = {
    session: {
      async create() { return { data: { id: "child-false" } }; },
      async promptAsync() { return { data: undefined }; },
    },
    tui: { async selectSession() { return { data: false }; } },
  };

  expect(await handoffSession(client, request)).toEqual({
    ok: false,
    data: { sessionID: "child-false", seeded: true, selected: false, stage: "select" },
    error: "session selection unavailable",
  });
});

test("stay seeds without selecting", async () => {
  let selected = false;
  const client = {
    session: {
      async create() { return { data: { id: "child-3" } }; },
      async promptAsync() { return { data: undefined }; },
    },
    tui: { async selectSession() { selected = true; } },
  };

  const result = await handoffSession(client, { ...request, stay: true });

  expect(selected).toBe(false);
  expect(result).toEqual({
    ok: true,
    data: { sessionID: "child-3", seeded: true, selected: false },
    error: null,
  });
});

test("seed failure preserves the created session ID and skips selection", async () => {
  let selected = false;
  const client = {
    session: {
      async create() { return { data: { id: "child-4" } }; },
      async promptAsync() { throw new Error("seed rejected"); },
    },
    tui: { async selectSession() { selected = true; } },
  };

  const result = await handoffSession(client, request);

  expect(selected).toBe(false);
  expect(result).toEqual({
    ok: false,
    data: { sessionID: "child-4", seeded: false, selected: false, stage: "seed" },
    error: "seed rejected",
  });
});

test("SDK error results are treated as stage failures", async () => {
  const client = {
    session: {
      async create() { return { data: { id: "child-error" } }; },
      async promptAsync() { return { error: { message: "seed rejected" } }; },
    },
    tui: { async selectSession() { return { data: undefined }; } },
  };

  expect(await handoffSession(client, request)).toEqual({
    ok: false,
    data: { sessionID: "child-error", seeded: false, selected: false, stage: "seed" },
    error: "seed rejected",
  });
});

test("missing created session ID reports the create stage", async () => {
  const client = {
    session: {
      async create() { return { data: undefined }; },
      async promptAsync() { return { data: undefined }; },
    },
    tui: { async selectSession() { return { data: true }; } },
  };

  expect(await handoffSession(client, request)).toEqual({
    ok: false,
    data: { stage: "create" },
    error: "session create returned no ID",
  });
});

test("native handoff resolves package context, records paths, and seeds from ToolContext", async () => {
  const calls: string[] = [];
  const client = {
    session: {
      async create(input: { body: { title: string } }) {
        calls.push(`create:${input.body.title}`);
        return { data: { id: "child-5" } };
      },
      async promptAsync(input: { path: { id: string }; body: { parts: [{ text: string }] } }) {
        calls.push(`seed:${input.path.id}:${input.body.parts[0].text}`);
        return { data: undefined };
      },
    },
    tui: { async selectSession() { throw new Error("stay should skip selection"); } },
  };
  const state = new WorkflowStateStore();
  const runtime = {
    runScript(root: string, script: string, args: string[]) {
      calls.push(`script:${root}:${script}:${args.join(" ")}`);
      return {
        exitCode: 0,
        stdout: [
          "PROMPT_START",
          "Continue now",
          "**Spec:** docs/superpowers/specs/x-design.md",
          "**Plan:** docs/superpowers/plans/x.md",
          "**SDD:** `docs/superpowers/sdd/x` (tracked)",
          "PROMPT_END",
          "",
        ].join("\n"),
        stderr: "",
        cwd: root,
      };
    },
  };

  const raw = await createHandoffTools(client, state, runtime).workflow_handoff_session.execute(
    { message: "please continue --stay" },
    { directory: "/repo", worktree: "/repo", sessionID: "parent" } as never,
  );

  expect(JSON.parse(raw as string)).toEqual({
    ok: true,
    data: { sessionID: "child-5", seeded: true, selected: false },
    error: null,
  });
  expect(calls).toEqual([
    "script:/repo:collect-handoff-context.sh:please continue --stay",
    "create:Continue x",
    "seed:child-5:Continue now\n**Spec:** docs/superpowers/specs/x-design.md\n**Plan:** docs/superpowers/plans/x.md\n**SDD:** `docs/superpowers/sdd/x` (tracked)",
  ]);
  expect(state.get("parent")).toEqual({
    spec: "docs/superpowers/specs/x-design.md",
    plan: "docs/superpowers/plans/x.md",
    sdd: "docs/superpowers/sdd/x",
  });
});

test("native handoff ignores a hallucinated stay argument when the message has no --stay flag", async () => {
  const calls: string[] = [];
  const client = {
    session: {
      async create() { return { data: { id: "child-select" } }; },
      async promptAsync() { return { data: undefined }; },
    },
    tui: {
      async selectSession(input: { body: { sessionID: string } }) {
        calls.push(input.body.sessionID);
        return { data: true };
      },
    },
  };
  const runtime = {
    runScript(root: string) {
      return {
        exitCode: 0,
        stdout: [
          "PROMPT_START",
          "Continue now",
          "**Spec:** docs/superpowers/specs/x-design.md",
          "**Plan:** docs/superpowers/plans/x.md",
          "**SDD:** `docs/superpowers/sdd/x` (tracked)",
          "PROMPT_END",
          "",
        ].join("\n"),
        stderr: "",
        cwd: root,
      };
    },
  };

  const raw = await createHandoffTools(
    client,
    new WorkflowStateStore(),
    runtime,
  ).workflow_handoff_session.execute(
    { message: "Load the wf-handoff skill and follow it. Arguments:", stay: true } as never,
    { directory: "/repo", worktree: "/repo", sessionID: "parent" } as never,
  );

  expect(calls).toEqual(["child-select"]);
  expect(JSON.parse(raw as string)).toEqual({
    ok: true,
    data: { sessionID: "child-select", seeded: true, selected: true },
    error: null,
  });
});

test("native handoff resolves relative paths from the session directory, not the VCS worktree", async () => {
  const roots: string[] = [];
  const client = {
    session: {
      async create() { return { data: { id: "child-directory" } }; },
      async promptAsync() { return { data: undefined }; },
    },
    tui: { async selectSession() { return { data: true }; } },
  };
  const runtime = {
    runScript(root: string) {
      roots.push(root);
      return {
        exitCode: 1,
        stdout: "",
        stderr: "stop after root capture",
        cwd: root,
      };
    },
  };

  await createHandoffTools(client, new WorkflowStateStore(), runtime).workflow_handoff_session.execute(
    { message: "continue" },
    { directory: "/repo/session", worktree: "/repo", sessionID: "parent" } as never,
  );

  expect(roots).toEqual(["/repo/session"]);
});

test("plugin client adapter publishes the native session selection event", async () => {
  const calls: unknown[] = [];
  const client = adaptPluginHandoffClient({
    session: {
      async create(input: unknown) {
        calls.push(["create", input]);
        return { data: { id: "child-live" } };
      },
      async promptAsync(input: unknown) {
        calls.push(["promptAsync", input]);
        return { data: undefined };
      },
    },
    tui: {
      async publish(input: unknown) {
        calls.push(["publish", input]);
        return { data: true };
      },
    },
  } as never);

  expect(await client.session.create({
    body: { title: "Continue x" },
    query: { directory: "/repo" },
  })).toEqual({ data: { id: "child-live" } });
  expect(await client.session.promptAsync({
    path: { id: "child-live" },
    query: { directory: "/repo" },
    body: { parts: [{ type: "text", text: "Continue" }] },
  })).toEqual({ data: undefined });
  expect(await client.tui.selectSession({
    body: { sessionID: "child-live" },
    query: { directory: "/repo" },
  })).toEqual({ data: true });
  expect(calls).toEqual([
    ["create", { body: { title: "Continue x" }, query: { directory: "/repo" } }],
    ["promptAsync", {
      path: { id: "child-live" }, query: { directory: "/repo" },
      body: { parts: [{ type: "text", text: "Continue" }] },
    }],
    ["publish", {
      body: { type: "tui.session.select", properties: { sessionID: "child-live" } },
      query: { directory: "/repo" },
    }],
  ]);
});

test("handoff context is read-only when the SDD workspace is absent", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-handoff-readonly-"));
  try {
    mkdirSync(path.join(root, "docs/superpowers/specs"), { recursive: true });
    mkdirSync(path.join(root, "docs/superpowers/plans"), { recursive: true });
    writeFileSync(path.join(root, "docs/superpowers/specs/x.md"), "# X\n**Branch:** `feature/x`\n");
    writeFileSync(path.join(root, "docs/superpowers/plans/x.md"), "# X\n**Spec:** `docs/superpowers/specs/x.md`\n### Task 1: One\n");
    const result = spawnSync("bash", [path.resolve(import.meta.dir, "../scripts/collect-handoff-context.sh"),
      "docs/superpowers/specs/x.md docs/superpowers/plans/x.md"], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(existsSync(path.join(root, "docs/superpowers/sdd/x"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("handoff resolves a matching local spec and plan when slash arguments are empty", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-handoff-matching-pair-"));
  try {
    mkdirSync(path.join(root, "docs/superpowers/specs"), { recursive: true });
    mkdirSync(path.join(root, "docs/superpowers/plans"), { recursive: true });
    writeFileSync(
      path.join(root, "docs/superpowers/specs/2026-07-14-mfe-tasks-base-design.md"),
      "# MFE Tasks Base Design\n",
    );
    writeFileSync(
      path.join(root, "docs/superpowers/plans/2026-07-14-mfe-tasks-base.md"),
      "# MFE Tasks Base Plan\n\n**Goal:** Build the MFE.\n\n### Task 1: Setup\n- [ ] Step\n",
    );

    const result = spawnSync(
      "bash",
      [path.resolve(import.meta.dir, "../scripts/collect-handoff-context.sh"),
        "Load the wf-handoff skill and follow it. Arguments:"],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("RESOLVE=matching_pair");
    expect(result.stdout).toContain("**Spec:** docs/superpowers/specs/2026-07-14-mfe-tasks-base-design.md");
    expect(result.stdout).toContain("**Plan:** docs/superpowers/plans/2026-07-14-mfe-tasks-base.md");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("handoff matching-pair ties resolve deterministically", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-handoff-pair-tie-"));
  try {
    const specs = path.join(root, "docs/superpowers/specs");
    const plans = path.join(root, "docs/superpowers/plans");
    mkdirSync(specs, { recursive: true });
    mkdirSync(plans, { recursive: true });
    const files = [
      path.join(specs, "2026-07-14-alpha-design.md"),
      path.join(plans, "2026-07-14-alpha.md"),
      path.join(specs, "2026-07-14-zulu-design.md"),
      path.join(plans, "2026-07-14-zulu.md"),
    ];
    writeFileSync(files[0], "# Alpha\n");
    writeFileSync(files[1], "# Alpha\n### Task 1: Alpha\n- [ ] Step\n");
    writeFileSync(files[2], "# Zulu\n");
    writeFileSync(files[3], "# Zulu\n### Task 1: Zulu\n- [ ] Step\n");
    const sameTime = new Date("2026-07-14T12:00:00Z");
    for (const file of files) utimesSync(file, sameTime, sameTime);

    const result = spawnSync(
      "bash",
      [path.resolve(import.meta.dir, "../scripts/collect-handoff-context.sh"),
        "Load the wf-handoff skill and follow it. Arguments:"],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("**Spec:** docs/superpowers/specs/2026-07-14-alpha-design.md");
    expect(result.stdout).toContain("**Plan:** docs/superpowers/plans/2026-07-14-alpha.md");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
