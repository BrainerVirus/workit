import { afterEach, expect, setSystemTime, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as z from "zod";
import { main } from "@/packages/workit-cli/src/main";
import { boundedOutput, countWarnings } from "@/packages/workit-cli/src/verbs/check";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import type { Assessment } from "@/test/workit-core/task-fixtures";
import {
  CHECK_OBSERVATION_PATH,
  entrySchema,
  evidenceSchema,
  parseStoredRecord,
  taskRecordSchema,
} from "@/packages/workit-core/src/core/task-contract";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { scopePrefix, scopeSupport } from "@/packages/workit-core/src/core/resources";
import { SIGNAL_TTL_MS, sessionCompactContext } from "@/packages/workit-core/src/hooks/context";
import { evaluateEvidence } from "@/packages/workit-core/src/core/task-evaluation";
import { rawRecordOf, rewriteTaskLog } from "../workit-core/store-files";
import {
  assessment,
  caller,
  checkObservation,
  taskStartRequest,
} from "../workit-core/task-fixtures";
import { checksPath } from "@/test/workit-core/task-fixtures";

// S9b `workit check` (design §2.1 S9, §5 S9b acceptance; D5, D14).

const ROOT = path.resolve(import.meta.dir, "../..");
const BUN = process.execPath;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A repo on a feature branch whose `test` check is `bun -e <exit 0>`. */
const repo = (
  checks: Record<string, string[]> | null = { test: [BUN, "-e", "process.exit(0)"] },
) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-check-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "a.txt"), "one\n");
  if (checks) writeFileSync(checksPath(root), JSON.stringify({ checks }));
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature/x");
  return root;
};

const behavioral = (): Assessment["signals"] => ({
  ...assessment().signals,
  approachUnknown: { value: false, basis: "inferred", reason: "known", refs: [] },
  productChoiceOpen: { value: false, basis: "inferred", reason: "settled", refs: [] },
  behaviorChange: {
    value: true,
    basis: "observed",
    reason: "behavior",
    refs: [{ kind: "external", url: "https://example.test/r" }],
  },
  mechanicalLowRisk: { value: false, basis: "inferred", reason: "behavioral", refs: [] },
});

/** An active task with a close-time `testing` requirement (behavioral-verification). */
const startTask = (root: string) => {
  const store = new TaskStore(root);
  const core = new WorkitCore(store, {
    root,
    caller: caller({ actor: "agent" }),
    capabilities: [],
    constraints: [],
    now: () => new Date().toISOString(),
  });
  // The workspace may already exist (an implicit task): use its current revision.
  const started = core.task(taskStartRequest({ expectedWorkspaceRevision: undefined }));
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as { id: string }).id;
  const assessed = core.policy({
    schemaVersion: 1,
    action: "assess",
    taskId,
    assessment: assessment({ signals: behavioral() }),
  });
  if (!assessed.ok) throw new Error(assessed.error);
  const task = store.readTask(taskId);
  if (!task.ok || !task.data.policy) throw new Error("policy missing");
  const testing = task.data.policy.requirements.find((item) => item.dimension === "testing")!;
  expect(testing.before).toBe("close");
  const status = () => {
    const view = core.task({ schemaVersion: 1, action: "inspect", taskId, view: "summary" });
    if (!view.ok) throw new Error(view.error);
    return (
      view.data as {
        requirements: Array<{ requirementId: string; status: string; reason: string }>;
      }
    ).requirements.find((item) => item.requirementId === testing.id)!;
  };
  return { store, core, taskId, testing, status };
};

const run = async (cwd: string, argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "s-agent", WORKFLOW_WORKSPACE_ROOT: "" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

test("G `workit check -- bun test` exiting 1, T failing evidence with exit code, log digest, head and tree, and the before:close testing requirement stays unsatisfied", async () => {
  const root = repo();
  const { store, taskId, status } = startTask(root);
  const failing = await run(root, [
    "check",
    "--json",
    "--name",
    "test",
    "--",
    BUN,
    "-e",
    "console.log('1 fail: expected 2'); console.error('token=ghp_abcdefghijklmnopqrstuvwxyz123456'); process.exit(1)",
  ]);
  expect(failing.code).toBe(1);
  const envelope = failing.json();
  expect(envelope).toMatchObject({ ok: false, code: "failed", error: "exited 1" });
  const data = envelope.data;
  expect(data).toMatchObject({
    name: "test",
    configured: false,
    exitCode: 1,
    head: git(root, "rev-parse", "HEAD"),
    dirty: false,
    attested: false,
    task: { id: taskId, created: false },
  });
  expect(data.tree).toBe(git(root, "rev-parse", "HEAD^{tree}"));
  expect(data.logDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(data.logTail).toContain("1 fail: expected 2");
  // Captured output is redacted before it is stored or printed.
  expect(JSON.stringify(data.logTail)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
  const log = readFileSync(path.join(root, ".git", "workit", data.logRef), "utf8");
  expect(log).toContain("1 fail: expected 2");
  expect(log).not.toContain("ghp_abcdefghij");
  // Without --full nothing streams: the envelope's logTail is the only copy.
  expect(failing.stderr).not.toContain("1 fail: expected 2");

  const task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const entry = task.data.evidence.find((item) => item.id === data.evidenceId)!;
  expect(entry.provenance).toMatchObject({ kind: "host_observed", host: "workit_cli" });
  expect(entry.data).toMatchObject({
    kind: "check",
    result: "failed",
    exitCode: 1,
    observation: { observer: "workit_cli", tree: data.tree, head: data.head, attestation: null },
  });
  expect(task.data.critical).toContain(CHECK_OBSERVATION_PATH);
  expect(status()).toMatchObject({ status: "unsatisfied" });
  expect(data.stillUnsatisfied).toEqual([
    expect.objectContaining({
      ruleId: "check:test",
      unblock: expect.stringMatching(/^(workit|npx -y @brainervirus\/workit-cli@\S+) check test$/),
    }),
  ]);

  const rows = readLedger(root);
  if (!rows.ok) throw new Error(rows.error);
  expect(rows.value.rows.at(-1)).toMatchObject({
    id: data.ledgerRowId,
    type: "check",
    observer: "workit_cli",
    name: "test",
    result: "failed",
    exitCode: 1,
    tree: data.tree,
    branch: "feature/x",
  });
});

test("G `workit check -- true` while `test` is configured, T the testing requirement stays unsatisfied (configured:false); `workit check test` satisfies it until a file edit makes it stale", async () => {
  const root = repo();
  const { taskId, status } = startTask(root);
  const adhoc = await run(root, ["check", "--json", "--", "true"]);
  expect(adhoc.code).toBe(0);
  expect(adhoc.json().data).toMatchObject({ configured: false, satisfies: [] });
  expect(status()).toMatchObject({
    status: "unsatisfied",
    reason: expect.stringContaining("ad-hoc checks do not satisfy a configured gate"),
  });
  // A configured name with a different command is still ad-hoc.
  const renamed = await run(root, ["check", "--json", "--name", "test", "--", "true"]);
  expect(renamed.json().data).toMatchObject({ name: "test", configured: false, satisfies: [] });
  expect(status().status).toBe("unsatisfied");

  const named = await run(root, ["check", "test", "--json"]);
  expect(named.code).toBe(0);
  expect(named.json()).toMatchObject({ ok: true, code: "ok" });
  expect(named.json().data).toMatchObject({ name: "test", configured: true, stillUnsatisfied: [] });
  expect(named.json().data.satisfies).toHaveLength(1);
  expect(status()).toMatchObject({ status: "satisfied" });

  // G a passing check, then a file edit, T the requirement reads stale.
  writeFileSync(path.join(root, "a.txt"), "two\n");
  expect(status()).toMatchObject({
    status: "unsatisfied",
    reason: expect.stringContaining("stale"),
  });
  const handoff = await run(root, ["handoff", "--json"]);
  expect(handoff.json().data.checks).toEqual([
    expect.objectContaining({ name: "test", result: "passed", fresh: false }),
  ]);
  const rerun = await run(root, ["check", "test", "--json"]);
  expect(rerun.json().data.dirty).toBe(true);
  expect(status()).toMatchObject({ status: "satisfied" });

  // Only the CLI's own observation counts: the same entry imported from
  // another checkout is history, not evidence here.
  const stored = rawRecordOf(root, taskId);
  for (const entry of stored.evidence)
    if (entry.data.observation) entry.provenance = { ...entry.provenance, kind: "imported" };
  rewriteTaskLog(root, taskId, stored);
  expect(status().status).toBe("unsatisfied");
});

test("G an agent-recorded `evidence.record {kind:check,result:passed}`, T it does not satisfy the testing requirement and cannot carry an observation", async () => {
  const root = repo();
  const { core, taskId, testing, status } = startTask(root);
  const reported = {
    kind: "check" as const,
    claim: "tests pass",
    requirementIds: [testing.id],
    result: "passed" as const,
    summary: "tests pass",
    refs: [],
    exitCode: 0,
    reviewContext: null,
  };
  expect(core.evidence({ schemaVersion: 1, action: "record", taskId, evidence: reported }).ok).toBe(
    true,
  );
  expect(status()).toMatchObject({
    status: "unsatisfied",
    reason: expect.stringContaining("agent-reported checks are notes"),
  });
  const observation = checkObservation({
    name: "test",
    configured: true,
    argv: [BUN, "-e", "process.exit(0)"],
    tree: git(root, "rev-parse", "HEAD^{tree}"),
  });
  // An agent cannot smuggle a CLI observation through evidence.record.
  const forged = core.evidence({
    schemaVersion: 1,
    action: "record",
    taskId,
    evidence: { ...reported, observation },
  });
  expect(forged).toMatchObject({ ok: false, code: "invalid_input" });
  // Nor through observeCheck from a non-CLI host.
  const host = new WorkitCore(new TaskStore(root), {
    root,
    caller: caller({ host: "opencode", actor: "agent" }),
    capabilities: [],
    constraints: [],
    now: () => new Date().toISOString(),
  });
  expect(host.observeCheck({ taskId, observation })).toMatchObject({
    ok: false,
    code: "permission_denied",
  });
  expect(status().status).toBe("unsatisfied");
});

test("G a fresh branch with no task, W check runs, T a task bound to the branch exists and the run is in the ledger; with nothing configured or detected an ad-hoc check never satisfies the gate", async () => {
  const bare = repo(null);
  const first = await run(bare, ["check", "--json", "--", "true"]);
  expect(first.code).toBe(0);
  expect(first.json().data).toMatchObject({
    task: { id: expect.any(String), created: true },
    evidenceId: expect.any(String),
  });
  const implicitId = first.json().data.task.id;
  // The store lives in the git common dir; the checkout only carries the 2.x marker.
  expect(existsSync(path.join(bare, ".workit", "tasks"))).toBe(false);
  const bound = new TaskStore(bare).implicitTask({
    provenance: {
      kind: "agent_reported",
      host: "workit_cli",
      session: null,
      workerId: null,
    },
    create: false,
  });
  expect(bound).toMatchObject({
    ok: true,
    data: { created: false, key: { key: "feature/x", branch: "feature/x" } },
  });
  expect(bound.ok && bound.data?.task.id).toBe(implicitId);
  // The next run on the branch reuses it.
  expect((await run(bare, ["check", "--json", "--", "true"])).json().data.task).toEqual({
    id: implicitId,
    created: false,
  });
  const rows = readLedger(bare);
  if (!rows.ok) throw new Error(rows.error);
  const row = expect.objectContaining({
    type: "check",
    observer: "workit_cli",
    name: null,
    result: "passed",
  });
  expect(rows.value.rows).toEqual([row, row]);

  // An explicitly started task takes the branch over from the implicit one.
  const { status } = startTask(bare);
  expect((await run(bare, ["check", "--json", "--", "true"])).code).toBe(0);
  expect(status()).toMatchObject({
    status: "unsatisfied",
    reason: expect.stringContaining('add .workit/checks.json, e.g. {"checks":{"test":'),
  });
  // --shell runs are never configured, even with a matching name.
  writeFileSync(checksPath(bare), JSON.stringify({ checks: { test: ["true"] } }));
  const shell = await run(bare, ["check", "--json", "--shell", "--name", "test", "--", "true"]);
  expect(shell.json().data).toMatchObject({ configured: false });
  expect(status().status).toBe("unsatisfied");
  expect((await run(bare, ["check", "test", "--json"])).json().data.configured).toBe(true);
  expect(status().status).toBe("satisfied");
});

test("a forged configured observation whose argv is not the configured command does not satisfy", async () => {
  const root = repo();
  const { store, taskId, status } = startTask(root);
  const cli = new WorkitCore(store, {
    root,
    caller: caller({ actor: "cli" }),
    capabilities: [],
    constraints: [],
    now: () => new Date().toISOString(),
  });
  const tree = git(root, "rev-parse", "HEAD^{tree}");
  expect(
    cli.observeCheck({
      taskId,
      observation: checkObservation({ name: "test", configured: true, argv: ["true"], tree }),
    }).ok,
  ).toBe(true);
  expect(status()).toMatchObject({
    status: "unsatisfied",
    reason: expect.stringContaining("ad-hoc checks do not satisfy"),
  });
});

test("a check that changes the worktree reports modifiedWorktree and leaves stale evidence", async () => {
  const root = repo({ test: [BUN, "-e", "require('fs').writeFileSync('out.txt', 'x')"] });
  const { status } = startTask(root);
  const result = await run(root, ["check", "test", "--json"]);
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({ configured: true, modifiedWorktree: true });
  expect(status()).toMatchObject({
    status: "unsatisfied",
    reason: expect.stringContaining("stale"),
  });
});

test("per-turn context judges checks by the cheap signal, never hashes the tree, and its cache sees edits after the signal TTL", async () => {
  const root = repo();
  const { store } = startTask(root);
  const session = { host: "workit_cli", handle: "agent" };
  const context = {
    root,
    caller: caller({ actor: "agent" }),
    capabilities: [],
    constraints: [],
    now: () => new Date().toISOString(),
  };
  const turn = () => sessionCompactContext(store, session, context, "session-bound") ?? "";
  // A check on a worktree that is already dirty.
  writeFileSync(path.join(root, "a.txt"), "dirty before the check\n");
  expect((await run(root, ["check", "test", "--json"])).code).toBe(0);
  const objects = () => git(root, "count-objects", "-v");
  const before = objects();
  let clock = Date.now() + 60_000;
  setSystemTime(new Date(clock));
  try {
    expect(turn()).not.toContain("stale evidence");
    // Re-edit the already-dirty file: `git status` still says " M a.txt".
    writeFileSync(path.join(root, "a.txt"), "re-edited after the check, longer\n");
    // Within the TTL the cached signal (and context) is reused…
    expect(turn()).not.toContain("stale evidence");
    // …and once it lapses the re-edit surfaces as stale.
    clock += SIGNAL_TTL_MS + 1;
    setSystemTime(new Date(clock));
    expect(turn()).toContain("stale evidence");
  } finally {
    setSystemTime();
  }
  // No blob was written for the edited file by the per-turn path.
  expect(objects()).toBe(before);
});

test("usage: unknown names, --shell with argv, and the exit code mirrors the command", async () => {
  const root = repo();
  const missing = await run(root, ["check", "lint", "--json"]);
  expect(missing.code).toBe(1);
  expect(missing.json()).toMatchObject({ code: "not_found", unblock: "workit check test" });
  const shellArgv = await run(root, ["check", "--shell", "--json", "--", "echo", "hi"]);
  expect(shellArgv.code).toBe(2);
  const shell = await run(root, ["check", "--shell", "--json", "--", "exit 3"]);
  expect(shell.code).toBe(3);
  expect(shell.json().data).toMatchObject({ exitCode: 3, configured: false });
  const absent = await run(root, ["check", "--json", "--", "workit-no-such-binary-xyz"]);
  expect(absent.code).toBe(127);
  const slow = await run(root, ["check", "--json", "--timeout", "0.2", "--", "sleep", "5"]);
  expect(slow.code).toBe(4);
  expect(slow.json().data).toMatchObject({ timedOut: true });
  expect((await run(root, ["check", "--json"])).code).toBe(2);
  // A detached HEAD is still keyed to its worktree tree.
  git(root, "checkout", "-q", "--detach");
  const detached = await run(root, ["check", "test", "--json"]);
  expect(detached.json().data).toMatchObject({
    configured: true,
    tree: git(root, "rev-parse", "HEAD^{tree}"),
  });
});

test("concurrent checks on one task all record (omitted revisions retry, never revision_conflict)", async () => {
  const root = repo();
  const { store, taskId } = startTask(root);
  const runs = await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
          const child = spawn(
            BUN,
            [path.join(ROOT, "packages/workit-cli/src/main.ts"), "check", "test", "--json"],
            { cwd: root, env: { ...process.env, WORKFLOW_WORKSPACE_ROOT: "" } },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => (stdout += chunk));
          child.stderr.on("data", (chunk) => (stderr += chunk));
          child.on("close", (code) => resolve({ code, stdout, stderr }));
        }),
    ),
  );
  for (const result of runs) {
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.task).toEqual({ id: taskId, created: false });
  }
  const task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  expect(task.data.evidence.filter((entry) => entry.data.observation)).toHaveLength(4);
  const rows = readLedger(root);
  if (!rows.ok) throw new Error(rows.error);
  expect(rows.value.rows.filter((row) => row.type === "check")).toHaveLength(4);
}, 30_000);

test("an older reader that does not know the observation fails closed instead of stripping it", async () => {
  const root = repo();
  const { taskId } = startTask(root);
  expect((await run(root, ["check", "test", "--json"])).code).toBe(0);
  const record = rawRecordOf(root, taskId);
  // The reader before S9b: same task schema, evidence without `observation`.
  const older = taskRecordSchema.extend({
    evidence: z.array(entrySchema(evidenceSchema.omit({ observation: true }))),
  });
  expect(parseStoredRecord(older, record)).toMatchObject({
    success: false,
    critical: [CHECK_OBSERVATION_PATH],
  });
  // Without the declaration the same reader would silently drop it.
  const undeclared = { ...record, critical: undefined };
  expect(parseStoredRecord(older, undeclared)).toMatchObject({
    success: true,
    stripped: [CHECK_OBSERVATION_PATH],
  });
  // The current reader keeps it.
  expect(parseStoredRecord(taskRecordSchema, record)).toMatchObject({
    success: true,
    stripped: [],
  });
});

test("observed-check freshness: tree vs signal modes, modified worktree, and a closed task keeps its record", () => {
  const entry = (overrides: Partial<ReturnType<typeof checkObservation>> = {}) => ({
    id: "e",
    recordedAt: "2026-01-01T00:00:00Z",
    provenance: { kind: "host_observed", host: "workit_cli" },
    data: {
      kind: "check",
      result: "passed",
      requirementIds: [],
      observation: checkObservation({ tree: "t1", signal: "s1", ...overrides }),
    },
  });
  const task = (status: string, item = entry()) =>
    ({ status, evidence: [item], candidates: [], policy: null }) as never;
  const tree = (value: string) => ({ mode: "tree" as const, current: () => value });
  const signal = (value: string) => ({ mode: "signal" as const, current: () => value });
  expect(evaluateEvidence(task("active"), null, tree("t1"))[0].status).toBe("passed");
  expect(evaluateEvidence(task("active"), null, tree("t2"))[0].status).toBe("stale");
  expect(evaluateEvidence(task("active"), null, signal("s1"))[0].status).toBe("passed");
  expect(evaluateEvidence(task("active"), null, signal("t1"))[0].status).toBe("stale");
  expect(evaluateEvidence(task("active"), null)[0].status).toBe("stale");
  expect(
    evaluateEvidence(task("active", entry({ modifiedWorktree: true })), null, tree("t1"))[0].status,
  ).toBe("stale");
  expect(evaluateEvidence(task("closed"), null, tree("t2"))[0].status).toBe("passed");
});

// Issue #282 slice 1: heavy checks take a machine-wide lease and run in their own scope.

/**
 * A repo whose .workit/checks.json carries `resources`, a private state dir for
 * the lease, and a private config dir whose workspaces.json gives the machine's
 * `resources` (default: no systemd scope, so most tests stay fast).
 */
const heavyRepo = (
  checks: Record<string, string[]>,
  resources: Record<string, unknown> = {},
  machine: Record<string, unknown> = { scope: false },
) => {
  const root = repo(null);
  writeFileSync(checksPath(root), JSON.stringify({ checks, resources }));
  const state = mkdtempSync(path.join(os.tmpdir(), "wk-lease-state-"));
  const config = mkdtempSync(path.join(os.tmpdir(), "wk-lease-config-"));
  dirs.push(state, config);
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({ workspaces: [{ name: "here", glob: "**", resources: machine }] }),
  );
  const env = {
    ...process.env,
    WORKIT_SESSION_ID: "s-heavy",
    WORKFLOW_WORKSPACE_ROOT: "",
    WORKFLOW_TOOLKIT_STATE: state,
    WORKFLOW_TOOLKIT_CONFIG_DIR: config,
    WORKIT_LEASE: "",
  };
  return { root, config, env, leases: path.join(state, "leases") };
};

const runEnv = async (cwd: string, argv: string[], env: NodeJS.ProcessEnv) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const cli = (cwd: string, argv: string[], env: NodeJS.ProcessEnv) => {
  const child = spawn(BUN, [path.join(ROOT, "packages/workit-cli/src/main.ts"), ...argv], {
    cwd,
    env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, stdout, stderr })),
  );
  return { child, done };
};

const until = async (condition: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const SLOW = (ms: number) => [BUN, "-e", `setTimeout(() => {}, ${ms})`];

const writeLease = (leases: string, record: Record<string, unknown>) => {
  mkdirSync(leases, { recursive: true });
  writeFileSync(
    path.join(leases, "slot-0.json"),
    JSON.stringify({
      bootId: null,
      processStart: null,
      startedAt: new Date().toISOString(),
      scope: null,
      ...record,
    }),
  );
};

test("G two `workit check test` runs in different worktrees, W the first holds the lease, T the second waits for it, then runs, and --json reports the wait and the holder", async () => {
  const one = heavyRepo({ test: SLOW(1500) });
  const two = repo(null);
  writeFileSync(checksPath(two), JSON.stringify({ checks: { test: SLOW(10) } }));
  const first = cli(one.root, ["check", "test", "--json"], one.env);
  await until(() => existsSync(path.join(one.leases, "slot-0.json")));
  const second = cli(two, ["check", "test", "--json"], one.env);
  const [a, b] = await Promise.all([first.done, second.done]);
  expect(a.code, a.stderr).toBe(0);
  expect(b.code, b.stderr).toBe(0);
  expect(JSON.parse(a.stdout).data.lease).toMatchObject({ slot: 0, waitedMs: 0, holder: null });
  const lease = JSON.parse(b.stdout).data.lease;
  expect(lease.waitedMs).toBeGreaterThan(0);
  expect(lease.holder).toMatchObject({
    pid: first.child.pid,
    check: "test",
    cwd: one.root,
    session: "s-heavy",
  });
  expect(b.stderr).toContain("waiting for the heavy-check lease (1 slot): held by test, pid");
  expect(existsSync(path.join(one.leases, "slot-0.json"))).toBe(false);
}, 30_000);

test("G the lease is held elsewhere, T an ad-hoc check runs without it, --heavy and `test` queue for it (exit 4 when the wait runs out), lint and --no-lease skip it", async () => {
  const { root, env, leases } = heavyRepo({ test: SLOW(10), lint: SLOW(10) }, { wait: 0 });
  writeLease(leases, {
    id: "00000000-0000-4000-8000-000000000009",
    pid: process.pid,
    check: "build",
    cwd: "/elsewhere",
    session: "s-other",
  });
  const adhoc = await runEnv(root, ["check", "--json", "--", ...SLOW(10)], env);
  expect(adhoc.code).toBe(0);
  expect(adhoc.json().data).toMatchObject({ lease: null, scope: null });
  const queued = await runEnv(root, ["check", "--heavy", "--json", "--", ...SLOW(10)], env);
  expect(queued.code).toBe(4);
  expect(queued.json()).toMatchObject({
    ok: false,
    code: "busy",
    data: { lease: { holders: [{ check: "build", cwd: "/elsewhere", session: "s-other" }] } },
  });
  expect((await runEnv(root, ["check", "test", "--json"], env)).code).toBe(4);
  const lint = await runEnv(root, ["check", "lint", "--json"], env);
  expect(lint.code).toBe(0);
  expect(lint.json().data.lease).toBeNull();
  const unleased = await runEnv(
    root,
    ["check", "test", "--no-lease", "--reason", "measuring the hold", "--json"],
    env,
  );
  expect(unleased.code).toBe(0);
  expect(unleased.json().data).toMatchObject({
    lease: null,
    noLease: { reason: "measuring the hold" },
  });
});

test("G a stale lease from a dead process, T `workit check test` reclaims it and says so", async () => {
  const { root, env, leases } = heavyRepo({ test: SLOW(10) });
  const dead = Number(
    spawnSync(BUN, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim(),
  );
  writeLease(leases, {
    id: "00000000-0000-4000-8000-00000000000a",
    pid: dead,
    check: "test",
    cwd: "/gone",
    session: null,
  });
  const result = await runEnv(root, ["check", "test", "--json"], env);
  expect(result.code, result.stderr).toBe(0);
  expect(result.json().data.lease.reclaimed).toEqual([
    expect.objectContaining({ pid: dead, cwd: "/gone", reason: `holder pid ${dead} is gone` }),
  ]);
  expect(result.stderr).toContain("reclaimed a stale heavy-check lease");
  // Released when the run ends.
  expect(existsSync(path.join(leases, "slot-0.json"))).toBe(false);
});

test("G an outer heavy check's WORKIT_LEASE, T a nested heavy check reuses that lease instead of deadlocking on it", async () => {
  const { root, env, leases } = heavyRepo({ test: SLOW(10) }, { wait: 0 });
  const id = "00000000-0000-4000-8000-00000000000b";
  writeLease(leases, { id, pid: process.pid, check: "test", cwd: "/outer", session: "s-heavy" });
  const nested = await runEnv(root, ["check", "test", "--json"], { ...env, WORKIT_LEASE: id });
  expect(nested.code, nested.stderr).toBe(0);
  expect(nested.json().data.lease).toMatchObject({ inherited: true, slot: null });
  // The outer lease is untouched.
  expect(existsSync(path.join(leases, "slot-0.json"))).toBe(true);
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
  test.skipIf(process.platform === "win32")(
    `G a heavy check holding the lease, W workit gets ${signal}, T the lease is released`,
    async () => {
      const { root, env, leases } = heavyRepo({ test: SLOW(30_000) });
      const running = cli(root, ["check", "test", "--json"], env);
      await until(() => existsSync(path.join(leases, "slot-0.json")));
      await new Promise((resolve) => setTimeout(resolve, 200));
      running.child.kill(signal);
      const result = await running.done;
      expect(result.code, result.stderr).not.toBe(0);
      expect(existsSync(path.join(leases, "slot-0.json"))).toBe(false);
    },
    30_000,
  );

test("G no user systemd (no manager socket), T a heavy check runs unscoped and says so once per session", async () => {
  const { root, env } = heavyRepo({ test: SLOW(10) }, {}, {});
  const runtime = mkdtempSync(path.join(os.tmpdir(), "wk-no-systemd-"));
  dirs.push(runtime);
  const bare = { ...env, XDG_RUNTIME_DIR: runtime };
  const first = await runEnv(root, ["check", "test", "--json"], bare);
  expect(first.code, first.stderr).toBe(0);
  expect(first.json().data.scope).toMatchObject({ unit: null });
  expect(first.stderr).toContain("heavy checks run without a memory/CPU limit here");
  const second = await runEnv(root, ["check", "test", "--json"], bare);
  expect(second.json().data.scope).toMatchObject({ unit: null });
  expect(second.stderr).not.toContain("without a memory/CPU limit");
});

test("G workspaces.json resources mark lint heavy, T `workit check lint` takes the lease", async () => {
  const { root, env, config } = heavyRepo({ lint: SLOW(10) });
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "here", glob: "**", resources: { heavy: ["lint"], scope: false } }],
    }),
  );
  const lint = await runEnv(root, ["check", "lint", "--json"], env);
  expect(lint.code, lint.stderr).toBe(0);
  expect(lint.json().data.lease).toMatchObject({ slot: 0, inherited: false });
});

/** Does a scope actually start here? (The skip guard for the real systemd path.) */
const probe = scopePrefix(`workit-probe-${process.pid}`, { memoryMax: "1G", cpuQuota: "50%" });
const userSystemd =
  process.platform === "linux" &&
  scopeSupport(process.env).ok &&
  spawnSync(probe[0], [...probe.slice(1), "true"], { stdio: "ignore", timeout: 10_000 }).status ===
    0;

test.skipIf(!userSystemd)(
  "G a delegated user systemd, T `workit check test` runs in a workit scope with the configured limits",
  async () => {
    const { root, env } = heavyRepo(
      {
        test: [
          "sh",
          "-c",
          'cg=$(cut -d: -f3 /proc/self/cgroup); echo "$cg"; cat "/sys/fs/cgroup$cg/memory.max"',
        ],
      },
      { memoryMax: "2G", cpuQuota: 2 },
      {},
    );
    const result = await runEnv(root, ["check", "test", "--json"], env);
    expect(result.code, result.stderr).toBe(0);
    const data = result.json().data;
    expect(data.scope).toMatchObject({ memoryMax: "2147483648", cpuQuota: "200%" });
    expect(data.scope.unit).toMatch(/^workit-check-[0-9a-f]{8}-\d+\.scope$/u);
    expect(data.logTail).toHaveLength(2);
    expect(data.logTail[0]).toEndWith(`/${data.scope.unit}`);
    expect(data.logTail[1]).toBe("2147483648");
  },
  20_000,
);

const leaseFile = (leases: string) => {
  try {
    return JSON.parse(readFileSync(path.join(leases, "slot-0.json"), "utf8"));
  } catch {
    return null;
  }
};

test.skipIf(process.platform === "win32")(
  "G a heavy check whose workit is SIGKILLed, T its check keeps running and a second heavy check still waits; once the check's group exits the lease is reclaimed",
  async () => {
    const { root, env, leases } = heavyRepo({ test: SLOW(30_000) }, { wait: 0 });
    const running = cli(root, ["check", "test", "--json"], env);
    await until(() => typeof leaseFile(leases)?.pgid === "number");
    const pgid: number = leaseFile(leases).pgid;
    running.child.kill("SIGKILL");
    await running.done;
    try {
      const second = await runEnv(root, ["check", "test", "--json"], env);
      expect(second.code, second.stderr).toBe(4);
      expect(second.json()).toMatchObject({ code: "busy" });
    } finally {
      process.kill(-pgid, "SIGKILL");
    }
    await until(() => {
      try {
        process.kill(-pgid, 0);
        return false;
      } catch {
        return true;
      }
    });
    // `test` itself sleeps 30 s; a short --heavy run shows the reclaim.
    const after = await runEnv(root, ["check", "--heavy", "--json", "--", ...SLOW(10)], env);
    expect(after.code, after.stderr).toBe(0);
    expect(after.json().data.lease.reclaimed[0]).toMatchObject({ check: "test" });
  },
  60_000,
);

test.skipIf(process.platform !== "linux")(
  "G a WORKIT_LEASE leaked from an unrelated live process, T the check does not skip the queue",
  async () => {
    const { root, env, leases } = heavyRepo({ test: SLOW(10) }, { wait: 0 });
    const sibling = spawn(BUN, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      const id = "00000000-0000-4000-8000-0000000000f1";
      writeLease(leases, { id, pid: sibling.pid, check: "test", cwd: "/sibling", session: "s-x" });
      const forged = await runEnv(root, ["check", "test", "--json"], { ...env, WORKIT_LEASE: id });
      expect(forged.code).toBe(4);
      expect(forged.json().data.lease.holders[0]).toMatchObject({ cwd: "/sibling" });
    } finally {
      sibling.kill("SIGKILL");
    }
  },
);

test("G a repo .workit/checks.json that raises slots, T the machine's one slot still holds and the repo is told", async () => {
  const { root, env, leases } = heavyRepo({ test: SLOW(10) }, { wait: 0, slots: 4 });
  writeLease(leases, {
    id: "00000000-0000-4000-8000-0000000000f2",
    pid: process.pid,
    check: "build",
    cwd: "/elsewhere",
    session: "s-other",
  });
  const result = await runEnv(root, ["check", "test", "--json"], env);
  expect(result.code).toBe(4);
  expect(result.stderr).toContain(
    "workit: resources: .workit/checks.json: slots: is machine-wide; set it in your workspaces.json",
  );
});

test("G a repo with only a root workit.checks.json, W `workit check test` runs, T it still runs and the note names .workit/checks.json", async () => {
  const root = repo(null);
  writeFileSync(
    path.join(root, "workit.checks.json"),
    JSON.stringify({ checks: { test: [BUN, "-e", "process.exit(0)"] } }),
  );
  const ran = await run(root, ["check", "test"]);
  expect(ran.code).toBe(0);
  expect(ran.stderr).toContain("note: workit.checks.json is deprecated");
  expect(ran.stderr).toContain(".workit/checks.json");
});

test("G a repo with only .workit/checks.json, W `workit check test` runs, T it runs that config with no note", async () => {
  const root = repo();
  const ran = await run(root, ["check", "test"]);
  expect(ran.code).toBe(0);
  expect(ran.stderr).not.toContain("note:");
});

test("G a check printing 500 lines then failing, T the agent sees its failing tail, a count of the omitted head and one summary line with the log path; --full streams it all", async () => {
  const root = repo();
  const script =
    "for (let i = 1; i <= 500; i++) console.log('line ' + i); console.error('boom at the end'); process.exit(3)";
  const bounded = await run(root, ["check", "--", BUN, "-e", script]);
  expect(bounded.code).toBe(3);
  const printed = bounded.stdout.split("\n");
  expect(printed[0]).toContain("441 earlier lines omitted");
  expect(printed.length).toBeLessThanOrEqual(62);
  expect(bounded.stdout).toContain("boom at the end");
  expect(bounded.stdout).toContain("line 500");
  expect(bounded.stdout).not.toContain("line 1\n");
  const summary = bounded.stderr.match(/workit check .*: exited 3 in \d+ ms .*; log: (\S+)/u);
  expect(summary).not.toBeNull();
  expect(readFileSync(summary![1], "utf8")).toContain("line 1\n");

  const full = await run(root, ["check", "--full", "--", BUN, "-e", script]);
  expect(full.stdout).toContain("line 1\n");
  expect(full.stdout).not.toContain("earlier lines omitted");
});

test("G a merged log where the child's last stderr line landed early (separate pipes under load), T the bounded output still shows it and stays within the line budget", () => {
  const stdout = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`);
  const log = ["boom at the end", ...stdout].join("\n") + "\n";
  const shown = boundedOutput(log, 60, "boom at the end\n");
  expect(shown).toContain("boom at the end");
  expect(shown).toContain("line 500");
  expect(shown.split("\n").filter(Boolean).length).toBeLessThanOrEqual(61);
  // Already in the tail: nothing is repeated.
  const inTail = boundedOutput(`${stdout.join("\n")}\nboom at the end\n`, 60, "boom at the end\n");
  expect(inTail.match(/boom at the end/gu)).toHaveLength(1);
});

test("G `test` configured, W an ad-hoc `--name test` run, T it says before running that it will not satisfy the gate, and not again after", async () => {
  const root = repo();
  startTask(root);
  const ran = await run(root, ["check", "--name", "test", "--", "true"]);
  expect(ran.code).toBe(0);
  const note = ran.stderr.indexOf('note: "test" is configured as');
  expect(note).toBeGreaterThanOrEqual(0);
  expect(note).toBeLessThan(ran.stderr.indexOf("workit check test:"));
  expect(ran.stderr).not.toContain("still unsatisfied");
});

test("G a linked worktree without .workit/checks.json, W `workit check test`, T it runs the main checkout's configured check from the worktree", async () => {
  const root = repo();
  const linked = path.join(mkdtempSync(path.join(os.tmpdir(), "workit-check-linked-")), "wt");
  dirs.push(path.dirname(linked));
  git(root, "worktree", "add", "-q", "-b", "feature/linked", linked);
  expect(existsSync(path.join(linked, ".workit", "checks.json"))).toBe(false);
  const ran = await run(linked, ["check", "test", "--json"]);
  expect(ran.code).toBe(0);
  expect(ran.json().data).toMatchObject({ name: "test", configured: true });
});

test("countWarnings counts tool warning lines, not prose", () => {
  const fixtures: Array<[string, string, number]> = [
    [
      "oxlint",
      "  ⚠ eslint(no-unused-vars): x is unused\n  ⚠ eslint(no-console): no\nFound 2 warnings.",
      2,
    ],
    ["eslint", "/a.ts\n  3:5  warning  Unexpected any  no-explicit-any\n  4:1  error  bad  x", 1],
    ["tsc", "src/a.ts(1,7): warning TS6133: 'x' is declared but never used.", 1],
    ["bun", "warn: something is deprecated\nwarning: also", 2],
    ["npm", "npm WARN deprecated left-pad@1.0.0\nnpm warn old lockfile", 2],
    ["maven", "[WARNING] The POM is missing\n[INFO] BUILD SUCCESS", 1],
    ["colored", "\u001b[33mwarning:\u001b[0m careful", 1],
    [
      "oxlint piped",
      "a.js:1:7: warning eslint(no-unused-vars): Variable 'a' is declared but never used.\nb.js:2:1: error eslint(no-debugger): x",
      1,
    ],
    ["gcc", "main.c:3:5: warning: unused variable 'x' [-Wunused-variable]", 1],
    ["none found", "warning: no warnings found\nwarn: 0 warnings", 0],
    ["prose", "we warn users that a warning: appears later\nno warnings here", 0],
  ];
  for (const [name, log, count] of fixtures)
    expect([name, countWarnings(log)]).toEqual([name, count]);
});
