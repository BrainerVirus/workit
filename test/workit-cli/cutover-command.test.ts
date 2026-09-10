import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { runCutoverCommand } from "@/packages/workit-cli/src/cutover-cli";
import { runActionCommand, runTaskCommand } from "@/packages/workit-cli/src/task";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { taskStartRequest } from "@/test/workit-core/task-fixtures";

const tmp = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));

const capture = () => {
  let stdout = "";
  let stderr = "";
  return {
    out: { write: (chunk: string) => void (stdout += chunk) },
    err: { write: (chunk: string) => void (stderr += chunk) },
    read: () => ({ stdout, stderr }),
  };
};

const cutoverEnv = (home: string): NodeJS.ProcessEnv => ({ ...process.env, HOME: home });

// ---------------------------------------------------------------------------
// runCutoverCommand: unknown hosts and malformed resolutions fail loud.
// ---------------------------------------------------------------------------

test("cutover preview rejects unknown hosts with a usage error", async () => {
  const home = tmp("wk-cut-cmd-");
  try {
    const io = capture();
    const code = await runCutoverCommand(["preview", "--hosts=bogus", "--json"], {
      env: cutoverEnv(home),
      cwd: home,
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(2);
    expect(io.read().stderr).toContain("unknown cutover host(s): bogus");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cutover preview keeps the opencode/cursor default on an empty --hosts", async () => {
  const home = tmp("wk-cut-cmd-");
  try {
    const io = capture();
    const code = await runCutoverCommand(["preview", "--hosts=", "--json"], {
      env: cutoverEnv(home),
      cwd: home,
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(0);
    expect(JSON.parse(io.read().stdout)).toMatchObject({ hosts: ["opencode", "cursor"] });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cutover apply rejects malformed --resolution flags", async () => {
  const home = tmp("wk-cut-cmd-");
  try {
    const io = capture();
    const code = await runCutoverCommand(["apply", "--resolution=no-equals"], {
      env: cutoverEnv(home),
      cwd: home,
      out: io.out,
      err: io.err,
      stdinIsTTY: () => false,
    });
    expect(code).toBe(2);
    expect(io.read().stderr).toContain("malformed --resolution flag(s)");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cutover apply --json prints the machine-readable plan", async () => {
  const home = tmp("wk-cut-cmd-");
  try {
    const io = capture();
    // No --confirm on a non-TTY: the plan still prints as JSON before the
    // confirm gate stops the run, and nothing is written.
    const code = await runCutoverCommand(["apply", "--json"], {
      env: cutoverEnv(home),
      cwd: home,
      out: io.out,
      err: io.err,
      stdinIsTTY: () => false,
    });
    expect(code).toBe(2);
    const plan = JSON.parse(io.read().stdout);
    expect(Array.isArray(plan.managedFiles)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rollback parses flags in any position around the backup id", async () => {
  const home = tmp("wk-cut-cmd-");
  try {
    const first = capture();
    const second = capture();
    const env = cutoverEnv(home);
    const a = await runCutoverCommand(["rollback", "preview", "--json", "missing-id"], {
      env,
      cwd: home,
      out: first.out,
      err: first.err,
    });
    const b = await runCutoverCommand(["rollback", "preview", "missing-id", "--json"], {
      env,
      cwd: home,
      out: second.out,
      err: second.err,
    });
    expect(a).toBe(b);
    expect(first.read().stdout).toBe(second.read().stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rollback without a backup id is a usage error", async () => {
  const home = tmp("wk-cut-cmd-");
  try {
    const io = capture();
    const code = await runCutoverCommand(["rollback", "preview", "--json"], {
      env: cutoverEnv(home),
      cwd: home,
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(2);
    expect(io.read().stderr).toContain("rollback requires preview|apply and a backup id");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runActionCommand: @file payloads and a missing --task value.
// ---------------------------------------------------------------------------

test("action accepts @file payloads like the task surface", async () => {
  const root = tmp("wk-cut-cmd-");
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Workit Test"], { cwd: root });
    spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "fixture"], { cwd: root });
    const payloadFile = path.join(root, "payload.json");
    writeFileSync(payloadFile, JSON.stringify({ message: "commit" }), "utf8");
    const io = capture();
    const code = await runActionCommand(
      ["git.commit", "--payload", `@${payloadFile}`, "--preview", "--json"],
      { cwd: root, out: io.out, err: io.err, stdinIsTTY: () => false },
    );
    expect(code).toBe(0);
    expect(JSON.parse(io.read().stdout)).toMatchObject({
      ok: true,
      data: { operation: "git.commit" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("action with a valueless --task flag fails invalid_input instead of denying", async () => {
  const root = tmp("wk-cut-cmd-");
  try {
    const io = capture();
    const code = await runActionCommand(
      ["git.commit", "--payload", JSON.stringify({ message: "commit" }), "--preview", "--task"],
      { cwd: root, out: io.out, err: io.err, stdinIsTTY: () => false },
    );
    expect(code).toBe(2);
    expect(io.read().stderr).toContain("--task requires a value");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Consent happy path: headless --confirm with revisions pauses the task.
// ---------------------------------------------------------------------------

test("consented task pause with revisions succeeds headless", async () => {
  const root = tmp("wk-cut-cmd-");
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
    if (!started.ok) throw new Error(started.error);
    const id = (started.data as { id: string }).id;
    const revision = (started.data as { revision: string }).revision;
    const io = capture();
    const code = await runTaskCommand(
      [
        "task",
        "pause",
        "--task",
        id,
        "--revision",
        revision,
        "--payload",
        JSON.stringify({ reason: "sliced" }),
        "--confirm",
        "--json",
      ],
      { cwd: root, out: io.out, err: io.err, stdinIsTTY: () => false },
    );
    expect(code).toBe(0);
    expect(JSON.parse(io.read().stdout)).toMatchObject({ ok: true, data: { status: "paused" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
