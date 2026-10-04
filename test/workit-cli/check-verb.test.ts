import { afterEach, expect, setSystemTime, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as z from "zod";
import { main } from "@/packages/workit-cli/src/main";
import { TaskStore, WorkitCore, type Assessment } from "@/packages/workit-core/src/core";
import {
  CHECK_OBSERVATION_PATH,
  entrySchema,
  evidenceSchema,
  parseStoredRecord,
  taskRecordSchema,
} from "@/packages/workit-core/src/core/task-contract";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { SIGNAL_TTL_MS, sessionCompactContext } from "@/packages/workit-core/src/hooks/context";
import { evaluateEvidence } from "@/packages/workit-core/src/core/task-evaluation";
import {
  assessment,
  caller,
  checkObservation,
  taskStartRequest,
} from "../workit-core/task-fixtures";

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
  if (checks) writeFileSync(path.join(root, "workit.checks.json"), JSON.stringify({ checks }));
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
  const started = core.task(taskStartRequest());
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
  // The child's output went to stderr so stdout is exactly one envelope.
  expect(failing.stderr).toContain("1 fail: expected 2");

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
      ruleId: "behavioral-verification",
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
  const file = path.join(root, ".workit", "tasks", `${taskId}.json`);
  const stored = JSON.parse(readFileSync(file, "utf8"));
  for (const entry of stored.evidence)
    if (entry.data.observation) entry.provenance = { ...entry.provenance, kind: "imported" };
  writeFileSync(file, JSON.stringify(stored));
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

test("without a task, a check still lands in the ledger; with nothing configured or detected an ad-hoc check never satisfies the gate", async () => {
  const bare = repo(null);
  const ledgerOnly = await run(bare, ["check", "--json", "--", "true"]);
  expect(ledgerOnly.code).toBe(0);
  expect(ledgerOnly.json().data).toMatchObject({
    task: null,
    evidenceId: null,
    taskNote: expect.stringContaining("ledger only"),
  });
  expect(existsSync(path.join(bare, ".workit"))).toBe(false);
  const rows = readLedger(bare);
  if (!rows.ok) throw new Error(rows.error);
  expect(rows.value.rows).toEqual([
    expect.objectContaining({
      type: "check",
      observer: "workit_cli",
      name: null,
      result: "passed",
    }),
  ]);

  const { status } = startTask(bare);
  expect((await run(bare, ["check", "--json", "--", "true"])).code).toBe(0);
  expect(status()).toMatchObject({
    status: "unsatisfied",
    reason: expect.stringContaining(
      'add workit.checks.json (committed, so it shows in the diff), e.g. {"checks":{"test":',
    ),
  });
  // --shell runs are never configured, even with a matching name.
  writeFileSync(
    path.join(bare, "workit.checks.json"),
    JSON.stringify({ checks: { test: ["true"] } }),
  );
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
  const record = JSON.parse(
    readFileSync(path.join(root, ".workit", "tasks", `${taskId}.json`), "utf8"),
  );
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
