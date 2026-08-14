import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  adaptPluginHandoffClient,
  createHandoffTools,
} from "../../packages/workit-opencode/src/tools/handoff";
import {
  buildHandoffPrompt,
  handoffSession,
  type HandoffRequest,
} from "../../packages/workit-core/src/core/handoff-tools";
import {
  DESTINATION_MENU_CHOICES,
  DESTINATION_MENU_LABELS,
  HANDOFF_DESTINATION_MARKER,
  SOURCE_MENU_CHOICES,
  markHandoffDestination,
  readEffectiveFlowState,
  recordMenuChoice,
  type FlowGateResult,
} from "../../packages/workit-core/src/core/flow-state";
import { WorkflowStateStore } from "../../packages/workit-core/src/state";
import { establishApprovedFlow, menuEvidence } from "./flow-fixtures";
import { HostReceiptStore } from "../../packages/workit-core/src/core/flow-state";

const posix = (p: string) => p.split(path.sep).join("/");

// Digest of the exact on-disk bytes, so crafted "approved" fixtures pass the
// digest-integrity gate (CA-01).
const sha256 = (abs: string) => createHash("sha256").update(readFileSync(abs)).digest("hex");

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
      async create() {
        return { data: { id: "child-2" } };
      },
      async promptAsync() {
        return { data: undefined };
      },
    },
    tui: {
      async selectSession() {
        throw new Error("no TUI");
      },
    },
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
      async create() {
        return { data: { id: "child-false" } };
      },
      async promptAsync() {
        return { data: undefined };
      },
    },
    tui: {
      async selectSession() {
        return { data: false };
      },
    },
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
      async create() {
        return { data: { id: "child-3" } };
      },
      async promptAsync() {
        return { data: undefined };
      },
    },
    tui: {
      async selectSession() {
        selected = true;
      },
    },
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
      async create() {
        return { data: { id: "child-4" } };
      },
      async promptAsync() {
        throw new Error("seed rejected");
      },
    },
    tui: {
      async selectSession() {
        selected = true;
      },
    },
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
      async create() {
        return { data: { id: "child-error" } };
      },
      async promptAsync() {
        return { error: { message: "seed rejected" } };
      },
    },
    tui: {
      async selectSession() {
        return { data: undefined };
      },
    },
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
      async create() {
        return { data: undefined };
      },
      async promptAsync() {
        return { data: undefined };
      },
    },
    tui: {
      async selectSession() {
        return { data: true };
      },
    },
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
  writeFileSync(
    path.join(root, "docs/x/sdd/flow.json"),
    JSON.stringify({
      slug: "x",
      spec: {
        path: "docs/x/spec.md",
        status: "approved",
        approved_digest: sha256(path.join(root, "docs/x/spec.md")),
      },
      plan: {
        path: "docs/x/plan.md",
        status: "approved",
        approved_digest: sha256(path.join(root, "docs/x/plan.md")),
      },
      menu: { presented: true, chosen: "handoff" },
      updated_at: Date.now(),
    }),
  );
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
    tui: {
      async selectSession() {
        throw new Error("stay should skip selection");
      },
    },
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
  writeFileSync(
    path.join(root, "docs/x/sdd/flow.json"),
    JSON.stringify({
      slug: "x",
      spec: {
        path: "docs/x/spec.md",
        status: "approved",
        approved_digest: sha256(path.join(root, "docs/x/spec.md")),
      },
      plan: {
        path: "docs/x/plan.md",
        status: "approved",
        approved_digest: sha256(path.join(root, "docs/x/plan.md")),
      },
      menu: { presented: true, chosen: "handoff" },
      updated_at: Date.now(),
    }),
  );
  const calls: string[] = [];
  const client = {
    session: {
      async create() {
        return { data: { id: "child-select" } };
      },
      async promptAsync() {
        return { data: undefined };
      },
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
    writeFileSync(
      path.join(root, "docs/x/sdd/flow.json"),
      JSON.stringify({
        slug: "x",
        spec: {
          path: "docs/x/spec.md",
          status: "approved",
          approved_digest: sha256(path.join(root, "docs/x/spec.md")),
        },
        plan: {
          path: "docs/x/plan.md",
          status: "approved",
          approved_digest: sha256(path.join(root, "docs/x/plan.md")),
        },
        menu: { presented: true, chosen: "inline" },
        updated_at: Date.now(),
      }),
    );
    let createdDirectory = "";
    const client = {
      session: {
        async create(input: { body: { title: string }; query: { directory: string } }) {
          createdDirectory = input.query.directory;
          return { data: { id: "child-directory" } };
        },
        async promptAsync() {
          return { data: undefined };
        },
      },
      tui: {
        async selectSession() {
          return { data: true };
        },
      },
    };

    await createHandoffTools(
      client as never,
      new WorkflowStateStore(),
    ).workflow_handoff_session.execute({ message: "continue" }, {
      directory: root,
      worktree: root,
      sessionID: "parent",
    } as never);

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

  expect(
    await client.session.create({
      body: { title: "Continue x" },
      query: { directory: "/repo" },
    }),
  ).toEqual({ data: { id: "child-live" } });
  expect(
    await client.session.promptAsync({
      path: { id: "child-live" },
      query: { directory: "/repo" },
      body: { parts: [{ type: "text", text: "Continue" }] },
    }),
  ).toEqual({ data: undefined });
  expect(
    await client.tui.selectSession({
      body: { sessionID: "child-live" },
      query: { directory: "/repo" },
    }),
  ).toEqual({ data: true });
  expect(calls).toEqual([
    ["create", { body: { title: "Continue x" }, query: { directory: "/repo" } }],
    [
      "promptAsync",
      {
        path: { id: "child-live" },
        query: { directory: "/repo" },
        body: { parts: [{ type: "text", text: "Continue" }] },
      },
    ],
    [
      "publish",
      {
        body: { type: "tui.session.select", properties: { sessionID: "child-live" } },
        query: { directory: "/repo" },
      },
    ],
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    ).workflow_handoff_session.execute({ message: "continue" }, {
      directory: root,
      sessionID: "parent",
    } as never);
    const out = JSON.parse(raw as string);
    expect(out.ok).toBe(false);
    // No activated flow state exists: the gate fails closed with the strict
    // read (flow_not_activated) rather than a misleading approval error.
    expect(out.error).toMatch(/not (approved|activated)/);
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
    writeFileSync(
      path.join(root, "docs/x/sdd/flow.json"),
      JSON.stringify({
        slug: "x",
        spec: {
          path: "docs/x/spec.md",
          status: "approved",
          approved_digest: sha256(path.join(root, "docs/x/spec.md")),
        },
        plan: {
          path: "docs/x/plan.md",
          status: "approved",
          approved_digest: sha256(path.join(root, "docs/x/plan.md")),
        },
        menu: { presented: true, chosen: "handoff" },
        updated_at: Date.now(),
      }),
    );
    const calls: string[] = [];
    const client = {
      session: {
        async create() {
          calls.push("create");
          return { data: { id: "child-gate" } };
        },
        async promptAsync() {
          calls.push("seed");
          return { data: undefined };
        },
      },
      tui: {
        async selectSession() {
          calls.push("select");
          return { data: true };
        },
      },
    };
    const raw = await createHandoffTools(
      client as never,
      new WorkflowStateStore(),
    ).workflow_handoff_session.execute({ message: "continue" }, {
      directory: root,
      sessionID: "parent",
    } as never);
    expect(JSON.parse(raw as string)).toMatchObject({ ok: true });
    expect(calls).toEqual(["create", "seed", "select"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff rejects multiple specs or plans in the message", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-multi-"));
  try {
    const result = buildHandoffPrompt(root, "docs/a/plan.md docs/b/plan.md");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("multiple features in message");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff reports missing feature docs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-empty-"));
  try {
    const noDocs = buildHandoffPrompt(root, "no paths here");
    expect("error" in noDocs).toBe(true);
    if ("error" in noDocs)
      expect(noDocs.error).toContain("no docs/<slug>/ features found under docs/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Task 3: core handoff-destination contract ---

test("source and destination menu choice tuples match the shared interface", () => {
  expect(SOURCE_MENU_CHOICES).toEqual([
    "subagent-driven",
    "inline",
    "handoff",
    "review-spec",
    "review-plan",
  ]);
  expect([...DESTINATION_MENU_CHOICES]).toEqual([
    "subagent-driven",
    "inline",
    "review-spec",
    "review-plan",
  ]);
  expect(DESTINATION_MENU_CHOICES).not.toContain("handoff");
  expect([...SOURCE_MENU_CHOICES].filter((c) => c !== "handoff")).toEqual([
    ...DESTINATION_MENU_CHOICES,
  ]);
});

test("every generated handoff prompt contains the destination marker and a four-label allow-list", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-dest-prompt-"));
  try {
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# X\n\n**Branch:** `feature/x`\n");
    writeFileSync(
      path.join(root, "docs/x/plan.md"),
      "# X\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
    );
    const result = buildHandoffPrompt(root, "docs/x/plan.md");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.prompt).toContain(HANDOFF_DESTINATION_MARKER);
      for (const label of DESTINATION_MENU_LABELS) {
        expect(result.prompt).toContain(label);
      }
      // The destination allow-list never presents Handoff as a choice.
      const fromMarker = result.prompt.slice(result.prompt.indexOf(HANDOFF_DESTINATION_MARKER));
      expect(fromMarker).not.toMatch(/^\s*[-*] Handoff\s*$/m);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const approveHandoffFlow = (root: string, store: HostReceiptStore, sessionId: string) => {
  establishApprovedFlow(root, "x", store, sessionId);
  return { plan: "docs/x/plan.md" };
};

const effectiveState = (root: string) => {
  const effective = readEffectiveFlowState(root, "x");
  if (!effective.ok) throw new Error(effective.error);
  return effective.state;
};

test("markHandoffDestination sets the flag, resets the menu, and leaves execution pending", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-mark-"));
  try {
    const store = new HostReceiptStore();
    approveHandoffFlow(root, store, "mark-session");
    const result = markHandoffDestination(root, "x", "docs/x/plan.md");
    expect(result).toEqual({ ok: true });
    const state = effectiveState(root);
    expect(state.handoff_destination).toBe(true);
    expect(state.menu).toEqual({ presented: false, chosen: "", evidence: null });
    expect(state.execution).toEqual({ status: "pending", mode: null, evidence: expect.anything() });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("markHandoffDestination rejects an already marked destination", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-mark-twice-"));
  try {
    const store = new HostReceiptStore();
    approveHandoffFlow(root, store, "twice-session");
    expect(markHandoffDestination(root, "x", "docs/x/plan.md")).toEqual({ ok: true });
    const second = markHandoffDestination(root, "x", "docs/x/plan.md");
    expect(second).toMatchObject({ ok: false, code: "recursive_handoff" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("markHandoffDestination requires the source menu choice handoff", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-mark-inline-"));
  try {
    const store = new HostReceiptStore();
    establishApprovedFlow(root, "x", store, "inline-session");
    recordMenuChoice(
      root,
      "x",
      "docs/x/plan.md",
      "inline",
      menuEvidence(store, "inline-session", "inline"),
    );
    const result = markHandoffDestination(root, "x", "docs/x/plan.md");
    expect(result).toMatchObject({ ok: false, code: "handoff_not_chosen" });
    expect(effectiveState(root).handoff_destination).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordMenuChoice rejects a handoff choice on a marked destination", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-recursive-"));
  try {
    const store = new HostReceiptStore();
    approveHandoffFlow(root, store, "recursive-session");
    expect(markHandoffDestination(root, "x", "docs/x/plan.md")).toEqual({ ok: true });
    const result = recordMenuChoice(
      root,
      "x",
      "docs/x/plan.md",
      "handoff",
      menuEvidence(store, "recursive-session", "handoff"),
    );
    expect(result).toMatchObject({ ok: false, code: "recursive_handoff" });
    expect(effectiveState(root).handoff_destination).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordMenuChoice still allows destination choices on a marked flow", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-dest-choice-"));
  try {
    const store = new HostReceiptStore();
    approveHandoffFlow(root, store, "dest-choice-session");
    expect(markHandoffDestination(root, "x", "docs/x/plan.md")).toEqual({ ok: true });
    const result = recordMenuChoice(
      root,
      "x",
      "docs/x/plan.md",
      "subagent-driven",
      menuEvidence(store, "dest-choice-session", "subagent-driven"),
    );
    expect(result).toEqual({ ok: true });
    const state = effectiveState(root);
    expect(state.execution).toEqual({
      status: "active",
      mode: "subagent-driven",
      evidence: expect.anything(),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoffSession invokes afterSeed after seeding and before selection", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-afterseed-"));
  try {
    const store = new HostReceiptStore();
    approveHandoffFlow(root, store, "afterseed-session");
    const calls: string[] = [];
    const client = {
      session: {
        async create() {
          calls.push("create");
          return { data: { id: "child-aseed" } };
        },
        async promptAsync() {
          calls.push("seed");
          return { data: undefined };
        },
      },
      tui: {
        async selectSession() {
          calls.push("select");
          return { data: true };
        },
      },
    };
    const result = await handoffSession(client, {
      directory: root,
      title: "Continue x",
      prompt: "Continue",
      stay: false,
      afterSeed: async () => {
        calls.push("mark");
        return markHandoffDestination(root, "x", "docs/x/plan.md");
      },
    } satisfies HandoffRequest);
    expect(calls).toEqual(["create", "seed", "mark", "select"]);
    expect(result).toEqual({
      ok: true,
      data: { sessionID: "child-aseed", seeded: true, selected: true },
      error: null,
    });
    expect(effectiveState(root).handoff_destination).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create failure leaves the flow unmarked and the source menu choice intact", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-create-fail-"));
  try {
    const store = new HostReceiptStore();
    approveHandoffFlow(root, store, "create-fail-session");
    const client = {
      session: {
        async create() {
          throw new Error("no child");
        },
        async promptAsync() {
          return { data: undefined };
        },
      },
      tui: {
        async selectSession() {
          return { data: true };
        },
      },
    };
    const result = await handoffSession(client, {
      directory: root,
      title: "Continue x",
      prompt: "Continue",
      stay: false,
      afterSeed: () => markHandoffDestination(root, "x", "docs/x/plan.md"),
    } satisfies HandoffRequest);
    expect(result).toEqual({
      ok: false,
      data: { stage: "create" },
      error: "no child",
    });
    const state = effectiveState(root);
    expect(state.handoff_destination).toBe(false);
    expect(state.menu).toEqual({
      presented: true,
      chosen: "handoff",
      evidence: expect.anything(),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seed failure leaves the flow unmarked and the source menu choice intact", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-seed-fail-"));
  try {
    const store = new HostReceiptStore();
    approveHandoffFlow(root, store, "seed-fail-session");
    const client = {
      session: {
        async create() {
          return { data: { id: "child-seedfail" } };
        },
        async promptAsync() {
          throw new Error("seed rejected");
        },
      },
      tui: {
        async selectSession() {
          return { data: true };
        },
      },
    };
    const result = await handoffSession(client, {
      directory: root,
      title: "Continue x",
      prompt: "Continue",
      stay: false,
      afterSeed: () => markHandoffDestination(root, "x", "docs/x/plan.md"),
    } satisfies HandoffRequest);
    expect(result).toEqual({
      ok: false,
      data: { sessionID: "child-seedfail", seeded: false, selected: false, stage: "seed" },
      error: "seed rejected",
    });
    const state = effectiveState(root);
    expect(state.handoff_destination).toBe(false);
    expect(state.menu).toEqual({
      presented: true,
      chosen: "handoff",
      evidence: expect.anything(),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mark failure reports the mark stage and leaves the flow unmarked", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-mark-fail-"));
  try {
    const store = new HostReceiptStore();
    approveHandoffFlow(root, store, "mark-fail-session");
    const client = {
      session: {
        async create() {
          return { data: { id: "child-markfail" } };
        },
        async promptAsync() {
          return { data: undefined };
        },
      },
      tui: {
        async selectSession() {
          return { data: true };
        },
      },
    };
    const afterSeed: () => FlowGateResult = () => ({
      ok: false,
      code: "mark_failed",
      error: "cannot mark",
    });
    const result = await handoffSession(client, {
      directory: root,
      title: "Continue x",
      prompt: "Continue",
      stay: false,
      afterSeed,
    } satisfies HandoffRequest);
    expect(result).toEqual({
      ok: false,
      data: { sessionID: "child-markfail", seeded: true, selected: false, stage: "mark" },
      error: "cannot mark",
    });
    expect(effectiveState(root).handoff_destination).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selection failure keeps the already seeded and marked destination", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-handoff-select-fail-"));
  try {
    const store = new HostReceiptStore();
    approveHandoffFlow(root, store, "select-fail-session");
    const client = {
      session: {
        async create() {
          return { data: { id: "child-selectfail" } };
        },
        async promptAsync() {
          return { data: undefined };
        },
      },
      tui: {
        async selectSession() {
          throw new Error("no TUI");
        },
      },
    };
    const result = await handoffSession(client, {
      directory: root,
      title: "Continue x",
      prompt: "Continue",
      stay: false,
      afterSeed: () => markHandoffDestination(root, "x", "docs/x/plan.md"),
    } satisfies HandoffRequest);
    expect(result).toEqual({
      ok: false,
      data: {
        sessionID: "child-selectfail",
        seeded: true,
        selected: false,
        stage: "select",
      },
      error: "no TUI",
    });
    const state = effectiveState(root);
    expect(state.handoff_destination).toBe(true);
    expect(state.menu).toEqual({ presented: false, chosen: "", evidence: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
