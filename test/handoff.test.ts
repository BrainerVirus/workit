import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { adaptPluginHandoffClient, buildHandoffPrompt, createHandoffTools, handoffSession } from "../packages/workit/src/tools/handoff";
import { WorkflowStateStore } from "../packages/workit/src/state";

const posix = (p: string) => p.split(path.sep).join("/");

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
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-native-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: root });
  spawnSync("git", ["config", "user.name", "T"], { cwd: root });
  writeFileSync(path.join(root, ".gitkeep"), "");
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "base"], { cwd: root });
  mkdirSync(path.join(root, "docs", "x"), { recursive: true });
  mkdirSync(path.join(root, "docs", "x", "sdd"), { recursive: true });
  writeFileSync(path.join(root, "docs/x/spec.md"), "# X\n\n**Branch:** `feature/x`\n");
  writeFileSync(
    path.join(root, "docs/x/plan.md"),
    "# X\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
  );
  writeFileSync(path.join(root, "docs/x/sdd/flow.json"), JSON.stringify({
    slug: "x",
    spec: { path: "docs/x/spec.md", status: "approved" },
    plan: { path: "docs/x/plan.md", status: "approved" },
    menu: { presented: true, chosen: "handoff" },
    updated_at: Date.now(),
  }));
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

  const raw = await createHandoffTools(client, state).workflow_handoff_session.execute(
    { message: "please continue --stay" },
    { directory: root, worktree: root, sessionID: "parent" } as never,
  );

  expect(JSON.parse(raw as string)).toEqual({
    ok: true,
    data: { sessionID: "child-5", seeded: true, selected: false },
    error: null,
  });
  expect(calls[0]).toBe("create:Continue x");
  expect(posix(calls[1])).toContain("**Spec:** docs/x/spec.md");
  expect(posix(calls[1])).toContain("**Plan:** docs/x/plan.md");
  expect(posix(calls[1])).toContain("**SDD:** `docs/x/sdd`");
  const stored = state.get("parent")!;
  expect({
    spec: posix(stored.spec),
    plan: posix(stored.plan),
    sdd: posix(stored.sdd),
  }).toEqual({
    spec: "docs/x/spec.md",
    plan: "docs/x/plan.md",
    sdd: "docs/x/sdd",
  });
  rmSync(root, { recursive: true, force: true });
});

test("native handoff ignores a hallucinated stay argument when the message has no --stay flag", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-stay-"));
  mkdirSync(path.join(root, "docs", "x"), { recursive: true });
  mkdirSync(path.join(root, "docs", "x", "sdd"), { recursive: true });
  writeFileSync(path.join(root, "docs/x/spec.md"), "# X\n\n**Branch:** `feature/x`\n");
  writeFileSync(
    path.join(root, "docs/x/plan.md"),
    "# X\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
  );
  writeFileSync(path.join(root, "docs/x/sdd/flow.json"), JSON.stringify({
    slug: "x",
    spec: { path: "docs/x/spec.md", status: "approved" },
    plan: { path: "docs/x/plan.md", status: "approved" },
    menu: { presented: true, chosen: "handoff" },
    updated_at: Date.now(),
  }));
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

  const raw = await createHandoffTools(
    client,
    new WorkflowStateStore(),
  ).workflow_handoff_session.execute(
    { message: "Load the wk-handoff skill and follow it.", stay: true } as never,
    { directory: root, worktree: root, sessionID: "parent" } as never,
  );

  expect(calls).toEqual(["child-select"]);
  expect(JSON.parse(raw as string)).toEqual({
    ok: true,
    data: { sessionID: "child-select", seeded: true, selected: true },
    error: null,
  });
  rmSync(root, { recursive: true, force: true });
});

test("native handoff resolves relative paths from the session directory", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-dir-"));
  try {
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    mkdirSync(path.join(root, "docs", "x", "sdd"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# X\n\n**Branch:** `feature/x`\n");
    writeFileSync(
      path.join(root, "docs/x/plan.md"),
      "# X\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
    );
    writeFileSync(path.join(root, "docs/x/sdd/flow.json"), JSON.stringify({
      slug: "x",
      spec: { path: "docs/x/spec.md", status: "approved" },
      plan: { path: "docs/x/plan.md", status: "approved" },
      menu: { presented: true, chosen: "inline" },
      updated_at: Date.now(),
    }));
    let createdDirectory = "";
    const client = {
      session: {
        async create(input: { body: { title: string }; query: { directory: string } }) {
          createdDirectory = input.query.directory;
          return { data: { id: "child-directory" } };
        },
        async promptAsync() { return { data: undefined }; },
      },
      tui: { async selectSession() { return { data: true }; } },
    };

    await createHandoffTools(client as never, new WorkflowStateStore()).workflow_handoff_session.execute(
      { message: "continue" },
      { directory: root, worktree: root, sessionID: "parent" } as never,
    );

    expect(createdDirectory).toBe(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-readonly-"));
  try {
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# X\n**Branch:** `feature/x`\n");
    writeFileSync(
      path.join(root, "docs/x/plan.md"),
      "# X\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
    );
    const result = buildHandoffPrompt(root, "docs/x/plan.md");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.prompt).toContain("**Spec:** docs/x/spec.md");
      expect(result.prompt).toContain("**Plan:** docs/x/plan.md");
    }
    expect(existsSync(path.join(root, "docs/x/sdd"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("handoff resolves a matching local spec and plan when slash arguments are empty", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-matching-pair-"));
  try {
    mkdirSync(path.join(root, "docs", "2026-07-14-mfe-tasks-base"), { recursive: true });
    writeFileSync(
      path.join(root, "docs/2026-07-14-mfe-tasks-base/spec.md"),
      "# MFE Tasks Base Design\n\n**Branch:** `feature/mfe-tasks-base`\n",
    );
    writeFileSync(
      path.join(root, "docs/2026-07-14-mfe-tasks-base/plan.md"),
      "# MFE Tasks Base Plan\n\n**Spec:** `docs/2026-07-14-mfe-tasks-base/spec.md`\n**Branch:** `feature/mfe-tasks-base`\n\n**Goal:** Build the MFE.\n\n### Task 1: Setup\n\n- [ ] **Step 1:** Work\n",
    );

    const result = buildHandoffPrompt(root, "Load the wk-handoff skill and follow it.");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(posix(result.spec)).toBe("docs/2026-07-14-mfe-tasks-base/spec.md");
      expect(posix(result.plan)).toBe("docs/2026-07-14-mfe-tasks-base/plan.md");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("handoff matching-pair ties resolve deterministically", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-pair-tie-"));
  try {
    const specs = path.join(root, "docs");
    mkdirSync(specs, { recursive: true });
    mkdirSync(path.join(root, "docs", "2026-07-14-alpha"), { recursive: true });
    mkdirSync(path.join(root, "docs", "2026-07-14-zulu"), { recursive: true });
    const files = [
      path.join(root, "docs", "2026-07-14-alpha", "spec.md"),
      path.join(root, "docs", "2026-07-14-alpha", "plan.md"),
      path.join(root, "docs", "2026-07-14-zulu", "spec.md"),
      path.join(root, "docs", "2026-07-14-zulu", "plan.md"),
    ];
    writeFileSync(files[0], "# Alpha\n\n**Branch:** `feature/alpha`\n");
    writeFileSync(
      files[1],
      "# Alpha\n\n**Spec:** `docs/2026-07-14-alpha/spec.md`\n**Branch:** `feature/alpha`\n\n### Task 1: Alpha\n\n- [ ] **Step 1:** Work\n",
    );
    writeFileSync(files[2], "# Zulu\n\n**Branch:** `feature/zulu`\n");
    writeFileSync(
      files[3],
      "# Zulu\n\n**Spec:** `docs/2026-07-14-zulu/spec.md`\n**Branch:** `feature/zulu`\n\n### Task 1: Zulu\n\n- [ ] **Step 1:** Work\n",
    );
    const sameTime = new Date("2026-07-14T12:00:00Z");
    for (const file of files) utimesSync(file, sameTime, sameTime);

    const result = buildHandoffPrompt(root, "Load the wk-handoff skill and follow it.");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(posix(result.spec)).toBe("docs/2026-07-14-alpha/spec.md");
      expect(posix(result.plan)).toBe("docs/2026-07-14-alpha/plan.md");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("handoff collect fails before prompt when docs validation fails", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-validate-fail-"));
  try {
    mkdirSync(path.join(root, "docs", "bad"), { recursive: true });
    const spec = "docs/bad/spec.md";
    const plan = "docs/bad/plan.md";
    writeFileSync(path.join(root, spec), "# Bad\n\n**Branch:** `feature/bad`\n");
    writeFileSync(
      path.join(root, plan),
      `# Bad\n\n**Spec:** \`${spec}\`\n**Branch:** \`feature/bad\`\n\n### Task 1: One\n\n- [ ] **Step 1:** x\n\n### Task 3: Skip\n\n- [ ] **Step 1:** x\n`,
    );
    const result = buildHandoffPrompt(root, `${spec} ${plan}`);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/docs validation failed/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("handoff hard-fails when flow gates are not approved", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-gate-"));
  try {
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# X\n\n**Branch:** `feature/x`\n");
    writeFileSync(
      path.join(root, "docs/x/plan.md"),
      "# X\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
    );
    const raw = await createHandoffTools(
      {} as never,
      new WorkflowStateStore(),
    ).workflow_handoff_session.execute(
      { message: "continue" },
      { directory: root, sessionID: "parent" } as never,
    );
    const out = JSON.parse(raw as string);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("spec not approved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff proceeds when flow gates are approved", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-gate-ok-"));
  try {
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    mkdirSync(path.join(root, "docs", "x", "sdd"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# X\n\n**Branch:** `feature/x`\n");
    writeFileSync(
      path.join(root, "docs/x/plan.md"),
      "# X\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
    );
    writeFileSync(path.join(root, "docs/x/sdd/flow.json"), JSON.stringify({
      slug: "x",
      spec: { path: "docs/x/spec.md", status: "approved" },
      plan: { path: "docs/x/plan.md", status: "approved" },
      menu: { presented: true, chosen: "handoff" },
      updated_at: Date.now(),
    }));
    const calls: string[] = [];
    const client = {
      session: {
        async create() { calls.push("create"); return { data: { id: "child-gate" } }; },
        async promptAsync() { calls.push("seed"); return { data: undefined }; },
      },
      tui: { async selectSession() { calls.push("select"); return { data: true }; } },
    };
    const raw = await createHandoffTools(
      client as never,
      new WorkflowStateStore(),
    ).workflow_handoff_session.execute(
      { message: "continue" },
      { directory: root, sessionID: "parent" } as never,
    );
    expect(JSON.parse(raw as string)).toMatchObject({ ok: true });
    expect(calls).toEqual(["create", "seed", "select"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});



test("handoff rejects multiple specs or plans in the message", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-multi-"));
  try {
    const result = buildHandoffPrompt(
      root,
      "docs/a/plan.md docs/b/plan.md",
    );
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("multiple features in message");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("handoff reports missing feature docs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-empty-"));
  try {
    const noDocs = buildHandoffPrompt(root, "no paths here");
    expect("error" in noDocs).toBe(true);
    if ("error" in noDocs) expect(noDocs.error).toContain("no docs/<slug>/ features found under docs/");
  } finally { rmSync(root, { recursive: true, force: true }); }
});






