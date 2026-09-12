import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runActionCommand,
  runTaskCommand,
  TASK_ACTIONS,
  TASK_FAMILIES,
} from "@/packages/workit-cli/src/task";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  installPackedPackage,
  packWorkspacePackages,
  runInIsolation,
  isolatedEnv,
} from "@/test/shared/helpers/packages";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { taskStartRequest } from "@/test/workit-core/task-fixtures";

const id = "00000000-0000-4000-8000-000000000001";
const scope = { description: "checkout", paths: ["."], exclusions: [] };
const intent = { objective: "CLI task", scope, authorityRefs: [] };

const fixture = () => mkdtempSync(path.join(os.tmpdir(), "wk-task-cli-"));
const capture = () => {
  let stdout = "";
  let stderr = "";
  return {
    out: { write: (chunk: string) => void (stdout += chunk) },
    err: { write: (chunk: string) => void (stderr += chunk) },
    read: () => ({ stdout, stderr }),
  };
};

async function* bytes(value: Uint8Array, split = 1): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < value.length; offset += split)
    yield value.slice(offset, Math.min(value.length, offset + split));
}

test("the CLI exposes exactly the eight families and 24 actions", () => {
  expect(TASK_FAMILIES).toEqual([
    "task",
    "policy",
    "evidence",
    "finding",
    "decision",
    "worker",
    "writer",
    "state",
  ]);
  expect(Object.values(TASK_ACTIONS).flat()).toHaveLength(24);
});

test("CLI external action previews its exact descriptor and refuses headless mutation", async () => {
  const root = fixture();
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Workit Test"], { cwd: root });
    writeFileSync(path.join(root, "tracked.txt"), "fixture\n");
    spawnSync("git", ["add", "tracked.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const preview = capture();
    expect(
      await runActionCommand(
        [
          "git.commit",
          "--payload",
          JSON.stringify({ message: "chore(test): commit" }),
          "--preview",
          "--json",
        ],
        {
          cwd: root,
          out: preview.out,
          err: preview.err,
          stdinIsTTY: () => false,
        },
      ),
    ).toBe(0);
    expect(JSON.parse(preview.read().stdout)).toMatchObject({
      ok: true,
      data: { operation: "git.commit" },
    });
    const denied = capture();
    expect(
      await runActionCommand(
        [
          "git.commit",
          "--payload",
          JSON.stringify({ message: "chore(test): commit" }),
          "--confirm",
          "--json",
        ],
        {
          cwd: root,
          out: denied.out,
          err: denied.err,
          stdinIsTTY: () => false,
        },
      ),
    ).toBe(1);
    expect(JSON.parse(denied.read().stdout)).toMatchObject({ ok: false, code: "needs_input" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI context.read returns Git context without confirmation or metadata writes", async () => {
  const root = fixture();
  try {
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      spawnSync("git", args, { cwd: root });
    writeFileSync(path.join(root, "fixture.txt"), "fixture\n");
    spawnSync("git", ["add", "fixture.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const before = readFileSync(path.join(root, ".git/HEAD"), "utf8");
    const out = capture();
    expect(
      await runActionCommand(
        ["context.read", "--payload", JSON.stringify({ kind: "git" }), "--json"],
        { cwd: root, out: out.out, err: out.err },
      ),
    ).toBe(0);
    const value = JSON.parse(out.read().stdout);
    expect(value).toMatchObject({
      ok: true,
      data: { kind: "git", context: { workspace_root: root } },
    });
    expect(readFileSync(path.join(root, ".git/HEAD"), "utf8")).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI context.read rejects option-like ranges without creating files", async () => {
  const root = fixture();
  const injected = path.join(os.tmpdir(), `workit-cli-context-output-${process.pid}`);
  rmSync(injected, { force: true });
  try {
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      spawnSync("git", args, { cwd: root });
    writeFileSync(path.join(root, "fixture.txt"), "fixture\n");
    spawnSync("git", ["add", "fixture.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const out = capture();
    expect(
      await runActionCommand(
        [
          "context.read",
          "--payload",
          JSON.stringify({ kind: "changelog", range: `--output=${injected}` }),
          "--json",
        ],
        { cwd: root, out: out.out, err: out.err },
      ),
    ).toBe(1);
    expect(JSON.parse(out.read().stdout)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(existsSync(injected)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(injected, { force: true });
  }
});

test("CLI changelog.apply uses the writer for success regardless of scope", async () => {
  const roots: string[] = [];
  const setup = (assignedScope: { description: string; paths: string[]; exclusions: string[] }) => {
    const root = fixture();
    roots.push(root);
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Workit Test"],
    ])
      spawnSync("git", args, { cwd: root });
    writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n");
    spawnSync("git", ["add", "CHANGELOG.md"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const store = new TaskStore(root);
    const core = new WorkitCore(store, {
      root,
      caller: { host: "workit_cli", actor: "cli" },
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:00Z",
    });
    const started = core.task(
      taskStartRequest({ intent: { ...taskStartRequest().intent, scope: assignedScope } }),
    );
    if (!started.ok) throw new Error(started.error);
    const task = store.readTask((started.data as { id: string }).id);
    const workspace = store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("task setup failed");
    if (
      !core.writer({
        schemaVersion: 1,
        action: "acquire",
        taskId: task.data.id,
        expectedRevision: task.data.revision,
        expectedWorkspaceRevision: workspace.data.revision,
        workerId: null,
      }).ok
    )
      throw new Error("writer setup failed");
    return root;
  };
  try {
    const allowedRoot = setup(scope);
    const successOut = capture();
    expect(
      await runActionCommand(
        [
          "changelog.apply",
          "--payload",
          JSON.stringify({ entries: [{ category: "Added", text: "CLI changelog action" }] }),
          "--confirm",
          "--json",
        ],
        {
          cwd: allowedRoot,
          actor: "cli",
          out: successOut.out,
          err: successOut.err,
          stdinIsTTY: () => true,
          confirm: async () => true,
        },
      ),
    ).toBe(0);
    expect(JSON.parse(successOut.read().stdout)).toMatchObject({ ok: true });
    expect(readFileSync(path.join(allowedRoot, "CHANGELOG.md"), "utf8")).toContain(
      "CLI changelog action",
    );

    const narrowRoot = setup({ description: "src only", paths: ["src"], exclusions: [] });
    const narrowOut = capture();
    expect(
      await runActionCommand(
        [
          "changelog.apply",
          "--payload",
          JSON.stringify({ entries: [{ category: "Added", text: "narrow scope still applies" }] }),
          "--confirm",
          "--json",
        ],
        {
          cwd: narrowRoot,
          actor: "cli",
          out: narrowOut.out,
          err: narrowOut.err,
          stdinIsTTY: () => true,
          confirm: async () => true,
        },
      ),
    ).toBe(0);
    expect(JSON.parse(narrowOut.read().stdout)).toMatchObject({ ok: true });
    expect(readFileSync(path.join(narrowRoot, "CHANGELOG.md"), "utf8")).toContain(
      "narrow scope still applies",
    );
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("CLI TTY route prints the bound descriptor before confirmation", async () => {
  const root = fixture();
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Workit Test"], { cwd: root });
    writeFileSync(path.join(root, "tracked.txt"), "fixture\n");
    spawnSync("git", ["add", "tracked.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const store = new TaskStore(root);
    const core = new WorkitCore(store, {
      root,
      caller: { host: "workit_cli", actor: "cli" },
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:00Z",
    });
    expect(core.task(taskStartRequest()).ok).toBe(true);
    const started = store.listTasks();
    const writerWorkspace = store.readWorkspace();
    if (!started.ok || started.data.length !== 1 || !writerWorkspace.ok || !writerWorkspace.data)
      throw new Error("writer state missing");
    const writerTask = store.readTask(started.data[0].id);
    if (!writerTask.ok) throw new Error("writer task missing");
    expect(
      core.writer({
        schemaVersion: 1,
        action: "acquire",
        taskId: writerTask.data.id,
        expectedRevision: writerTask.data.revision,
        expectedWorkspaceRevision: writerWorkspace.data.revision,
        workerId: null,
      }),
    ).toMatchObject({ ok: true });
    writeFileSync(path.join(root, "change.txt"), "change\n");
    spawnSync("git", ["add", "change.txt"], { cwd: root });
    const out = capture();
    expect(
      await runActionCommand(
        [
          "git.commit",
          "--payload",
          JSON.stringify({ message: "chore(test): tty commit" }),
          "--confirm",
        ],
        {
          cwd: root,
          actor: "cli",
          out: out.out,
          err: out.err,
          stdinIsTTY: () => true,
          confirm: async () => true,
        },
      ),
    ).toBe(0);
    expect(out.read().stdout).toContain("External action preview:");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every closed family/action pair reaches the structured core parser", async () => {
  const root = fixture();
  try {
    for (const family of TASK_FAMILIES) {
      for (const action of TASK_ACTIONS[family]) {
        const stream = capture();
        const code = await runTaskCommand([family, action, "--json"], {
          cwd: root,
          out: stream.out,
          err: stream.err,
        });
        expect(code === 0 || code === 1, `${family}.${action}`).toBe(true);
        expect(JSON.parse(stream.read().stdout).schemaVersion).toBe(1);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task start, list, and read-only inspect work through the CLI", async () => {
  const root = fixture();
  try {
    const first = capture();
    expect(
      await runTaskCommand(
        [
          "task",
          "start",
          "--payload",
          JSON.stringify({ expectedWorkspaceRevision: null, intent }),
          "--json",
        ],
        { cwd: root, out: first.out, err: first.err },
      ),
    ).toBe(0);
    const started = JSON.parse(first.read().stdout);
    expect(started).toMatchObject({ ok: true, schemaVersion: 1 });
    const taskId = started.data.id as string;
    const taskPath = path.join(root, ".workit", "tasks", `${taskId}.json`);
    const before = readFileSync(taskPath, "utf8");
    expect(JSON.parse(before).intent.provenance.kind).toBe("agent_reported");

    const inspected = capture();
    expect(
      await runTaskCommand(["task", "inspect", "--task", taskId, "--view", "full", "--json"], {
        cwd: root,
        out: inspected.out,
        err: inspected.err,
      }),
    ).toBe(0);
    expect(JSON.parse(inspected.read().stdout)).toMatchObject({ ok: true, schemaVersion: 1 });
    expect(readFileSync(path.join(root, ".workit", "tasks", `${taskId}.json`), "utf8")).toBe(
      before,
    );

    const listed = capture();
    expect(
      await runTaskCommand(["task", "list"], { cwd: root, out: listed.out, err: listed.err }),
    ).toBe(0);
    expect(listed.read().stdout).toContain(taskId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("payload files and stdin preserve nested JSON and reject conflicts", async () => {
  const root = fixture();
  try {
    const payloadPath = path.join(root, "start.json");
    writeFileSync(payloadPath, JSON.stringify({ expectedWorkspaceRevision: null, intent }));
    const fromFile = capture();
    expect(
      await runTaskCommand(["task", "start", "--payload", `@${payloadPath}`, "--json"], {
        cwd: root,
        out: fromFile.out,
        err: fromFile.err,
      }),
    ).toBe(0);
    expect(JSON.parse(fromFile.read().stdout)).toMatchObject({ ok: true });

    const stdinRoot = fixture();
    const fromStdin = capture();
    try {
      expect(
        await runTaskCommand(["task", "start", "--payload", "-", "--json"], {
          cwd: stdinRoot,
          stdin: JSON.stringify({ expectedWorkspaceRevision: null, intent }),
          out: fromStdin.out,
          err: fromStdin.err,
        }),
      ).toBe(0);
      expect(JSON.parse(fromStdin.read().stdout)).toMatchObject({ ok: true });
    } finally {
      rmSync(stdinRoot, { recursive: true, force: true });
    }

    const conflict = capture();
    expect(
      await runTaskCommand(
        [
          "task",
          "inspect",
          "--task",
          id,
          "--payload",
          JSON.stringify({ taskId: id.replace(/1$/, "2"), view: "summary" }),
          "--json",
        ],
        { cwd: root, out: conflict.out, err: conflict.err },
      ),
    ).toBe(1);
    expect(JSON.parse(conflict.read().stdout)).toMatchObject({ ok: false, code: "invalid_input" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("payload decoding is fatal UTF-8 and preserves split multibyte characters", async () => {
  const root = fixture();
  try {
    const payload = JSON.stringify({
      expectedWorkspaceRevision: null,
      intent: { ...intent, objective: "café 🧪" },
    });
    const stdinResult = capture();
    expect(
      await runTaskCommand(["task", "start", "--payload", "-", "--json"], {
        cwd: root,
        stdin: bytes(new TextEncoder().encode(payload)),
        out: stdinResult.out,
        err: stdinResult.err,
      }),
    ).toBe(0);
    const started = JSON.parse(stdinResult.read().stdout);
    expect(started.data.objective).toBe("café 🧪");

    const fileRoot = fixture();
    try {
      const file = path.join(fileRoot, "payload.json");
      writeFileSync(file, new TextEncoder().encode(payload));
      const fileResult = capture();
      expect(
        await runTaskCommand(["task", "start", "--payload", `@${file}`, "--json"], {
          cwd: fileRoot,
          out: fileResult.out,
          err: fileResult.err,
        }),
      ).toBe(0);
      expect(JSON.parse(fileResult.read().stdout).data.objective).toBe("café 🧪");
    } finally {
      rmSync(fileRoot, { recursive: true, force: true });
    }

    const invalidFile = path.join(root, "bad.json");
    writeFileSync(invalidFile, Uint8Array.from([0xff, 0xfe]));
    for (const input of [
      {
        args: ["task", "list", "--payload", "-", "--json"],
        stdin: bytes(Uint8Array.from([0xc3, 0x28])),
      },
      { args: ["task", "list", "--payload", `@${invalidFile}`, "--json"], stdin: undefined },
    ]) {
      const invalid = capture();
      expect(
        await runTaskCommand(input.args, {
          cwd: root,
          stdin: input.stdin,
          out: invalid.out,
          err: invalid.err,
        }),
      ).toBe(1);
      expect(JSON.parse(invalid.read().stdout)).toMatchObject({ ok: false, code: "invalid_input" });
      expect(invalid.read().stderr).toBe("");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--json is order-independent for every parser failure", async () => {
  const root = fixture();
  try {
    for (const args of [
      ["task", "list", "--bogus", "x", "--json"],
      ["task", "list", "--json", "--bogus", "x"],
      ["task", "list", "--json", "--json"],
      ["task", "not-an-action", "--json"],
      ["not-a-family", "list", "--json"],
    ]) {
      const result = capture();
      expect(await runTaskCommand(args, { cwd: root, out: result.out, err: result.err })).toBe(2);
      expect(JSON.parse(result.read().stdout)).toMatchObject({ ok: false, schemaVersion: 1 });
      expect(result.read().stderr).toBe("");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("headless resume consent stays needs_input and malformed CLI input is nonzero", async () => {
  const root = fixture();
  try {
    const missingConsent = capture();
    expect(
      await runTaskCommand(
        [
          "task",
          "resume",
          "--task",
          id,
          "--payload",
          JSON.stringify({ authorityRefs: [] }),
          "--json",
        ],
        { cwd: root, out: missingConsent.out, err: missingConsent.err },
      ),
    ).toBe(1);
    expect(JSON.parse(missingConsent.read().stdout)).toMatchObject({
      ok: false,
      code: "needs_input",
    });

    const malformed = capture();
    expect(
      await runTaskCommand(["task", "list", "--payload", "{bad", "--json"], {
        cwd: root,
        out: malformed.out,
        err: malformed.err,
      }),
    ).toBe(1);
    expect(JSON.parse(malformed.read().stdout)).toMatchObject({ ok: false, code: "invalid_input" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff exports task state and compact context without docs", async () => {
  const root = fixture();
  try {
    const start = capture();
    await runTaskCommand(
      [
        "task",
        "start",
        "--payload",
        JSON.stringify({ expectedWorkspaceRevision: null, intent }),
        "--json",
      ],
      { cwd: root, out: start.out, err: start.err },
    );
    const taskId = JSON.parse(start.read().stdout).data.id as string;
    const handoff = capture();
    expect(
      await runTaskCommand(["handoff", "--task", taskId], {
        cwd: root,
        out: handoff.out,
        err: handoff.err,
      }),
    ).toBe(0);
    expect(handoff.read().stdout).toContain("Destination context");
    expect(handoff.read().stdout).toContain("CLI task");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff rejects a mutation between export and inspect", async () => {
  const root = fixture();
  try {
    const start = capture();
    await runTaskCommand(
      [
        "task",
        "start",
        "--payload",
        JSON.stringify({ expectedWorkspaceRevision: null, intent }),
        "--json",
      ],
      { cwd: root, out: start.out, err: start.err },
    );
    const taskId = JSON.parse(start.read().stdout).data.id as string;
    const handoff = capture();
    const code = await runTaskCommand(["handoff", "--task", taskId, "--json"], {
      cwd: root,
      out: handoff.out,
      err: handoff.err,
      afterExport: () => {
        const store = new TaskStore(root);
        const task = store.readTask(taskId);
        if (!task.ok) throw new Error(task.error);
        const changed = store.mutateTask(taskId, task.data.revision, (current, context) => ({
          ok: true,
          schemaVersion: 1,
          revision: context.revision,
          workspaceRevision: null,
          data: { ...current, progress: { ...current.progress, summary: "changed" } },
        }));
        if (!changed.ok) throw new Error(changed.error);
      },
    });
    expect(code).toBe(1);
    expect(JSON.parse(handoff.read().stdout)).toMatchObject({
      ok: false,
      code: "revision_conflict",
    });
    expect(handoff.read().stdout).not.toContain("Destination context");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packed task list runs on Node without a Bun runtime", () => {
  const packs = packWorkspacePackages();
  const packageInfo = packs.find((pack) => pack.packageName === "@brainervirus/workit-cli")!;
  const install = mkdtempSync(path.join(os.tmpdir(), "wk-task-packed-"));
  try {
    const nodeModules = path.join(install, "node_modules");
    mkdirSync(nodeModules, { recursive: true });
    const packageDir = installPackedPackage(nodeModules, packageInfo);
    const root = path.join(install, "project");
    mkdirSync(root, { recursive: true });
    const entry = path.join(packageDir, "dist", "index.js");
    const run = runInIsolation(
      install,
      "node",
      [entry, "task", "list", "--json"],
      isolatedEnv(path.join(install, "home"), { WORKFLOW_WORKSPACE_ROOT: root }),
    );
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, schemaVersion: 1, data: [] });
    expect(run.stderr).toBe("");
  } finally {
    rmSync(install, { recursive: true, force: true });
  }
}, 120_000);

test("writer acquire --actor stamps the session handle a hook can match", async () => {
  const root = fixture();
  try {
    const store = new TaskStore(root);
    const core = new WorkitCore(store, {
      root,
      caller: { host: "workit_cli", actor: "cli" },
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:00Z",
    });
    const started = core.task(taskStartRequest());
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    const id = (started.data as { id: string }).id;
    const task = store.readTask(id);
    const workspace = store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
    const io = capture();
    const code = await runTaskCommand(
      [
        "writer",
        "acquire",
        "--task",
        id,
        "--revision",
        task.data.revision,
        "--workspace-revision",
        workspace.data.revision,
        "--payload",
        JSON.stringify({ workerId: null }),
        "--actor",
        "session-9",
        "--confirm",
        "--json",
      ],
      { cwd: root, out: io.out, err: io.err, stdinIsTTY: () => false },
    );
    expect(code).toBe(0);
    expect(JSON.parse(io.read().stdout)).toMatchObject({ ok: true });
    const owner = store.readWorkspace();
    expect(owner.ok && owner.data?.writer?.owner).toMatchObject({
      taskId: id,
      workerId: null,
      session: { host: "workit_cli", handle: "session-9" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
