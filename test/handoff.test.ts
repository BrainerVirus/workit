import { expect, test } from "bun:test";
import { adaptHandoffClient, createHandoffTools, handoffSession } from "../src/tools/handoff";
import { WorkflowStateStore } from "../src/state";

const request = {
  parentID: "parent",
  directory: "/repo",
  title: "Continue x",
  prompt: "Continue",
  stay: false,
};

test("handoff creates, seeds, then selects the exact child session", async () => {
  const calls: string[] = [];
  const client = {
    session: {
      async create() { calls.push("create"); return { data: { id: "child-1" } }; },
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
      async create(input: { body: { parentID: string; title: string } }) {
        calls.push(`create:${input.body.parentID}:${input.body.title}`);
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
    { message: "please continue", stay: true },
    { worktree: "/repo", sessionID: "parent" } as never,
  );

  expect(JSON.parse(raw as string)).toEqual({
    ok: true,
    data: { sessionID: "child-5", seeded: true, selected: false },
    error: null,
  });
  expect(calls).toEqual([
    "script:/repo:collect-handoff-context.sh:please continue",
    "create:parent:Continue x",
    "seed:child-5:Continue now\n**Spec:** docs/superpowers/specs/x-design.md\n**Plan:** docs/superpowers/plans/x.md\n**SDD:** `docs/superpowers/sdd/x` (tracked)",
  ]);
  expect(state.get("parent")).toEqual({
    spec: "docs/superpowers/specs/x-design.md",
    plan: "docs/superpowers/plans/x.md",
    sdd: "docs/superpowers/sdd/x",
  });
});

test("v2 adapter maps the handoff boundary to flat SDK calls", async () => {
  const calls: unknown[] = [];
  const client = adaptHandoffClient({
    session: {
      async create(input) {
        calls.push(["create", input]);
        return { data: { id: "child-v2" } };
      },
      async promptAsync(input) {
        calls.push(["promptAsync", input]);
        return { data: undefined };
      },
    },
    tui: {
      async selectSession(input) {
        calls.push(["selectSession", input]);
        return { data: true };
      },
    },
  });

  expect(await client.session.create({
    body: { parentID: "parent", title: "Continue x" },
    query: { directory: "/repo" },
  })).toEqual({ data: { id: "child-v2" } });
  expect(await client.session.promptAsync({
    path: { id: "child-v2" },
    query: { directory: "/repo" },
    body: { parts: [{ type: "text", text: "Continue" }] },
  })).toEqual({ data: undefined });
  expect(await client.tui.selectSession({
    body: { sessionID: "child-v2" },
    query: { directory: "/repo" },
  })).toEqual({ data: true });
  expect(calls).toEqual([
    ["create", { parentID: "parent", title: "Continue x", directory: "/repo" }],
    ["promptAsync", {
      sessionID: "child-v2", directory: "/repo", parts: [{ type: "text", text: "Continue" }],
    }],
    ["selectSession", { sessionID: "child-v2", directory: "/repo" }],
  ]);
});
