import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTaskCommand, TASK_ACTIONS, TASK_FAMILIES } from "../../packages/workit-cli/src/task";
import { mkdirSync } from "node:fs";
import {
  installPackedPackage,
  packWorkspacePackages,
  runInIsolation,
  isolatedEnv,
} from "../shared/helpers/packages";
import { TaskStore } from "../../packages/workit-core/src/core";

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
