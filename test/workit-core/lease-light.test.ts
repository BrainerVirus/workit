// Retro R6 (#326, #418, #645): parallel workers starved behind full suites.
// Formatters and file-scoped linters never take the heavy-check lease, a
// fanout plan warns when more slices run the full suite than there are lease
// slots, and a wait that reaches its limit re-queues once in its place with
// an estimate before it fails naming the exact retry command.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { lightCommand } from "@/packages/workit-core/src/check-config";
import {
  acquireLease,
  type AcquireOptions,
  type LeaseRecord,
  type QueueStatus,
} from "@/packages/workit-core/src/core/resources";
import { fullSuiteVerify, leaseContention, type Slice } from "@/packages/workit-core/src/fanout";
import { heavyGate } from "@/packages/workit-core/src/hooks/heavy-gate";
import { appendObserved } from "@/packages/workit-core/src/ledger";
import {
  requeueMs,
  retryCommand,
  retryWaitMs,
  shellWord,
} from "@/packages/workit-cli/src/verbs/check";

setDefaultTimeout(90_000);

const BUN = process.execPath;
const MAIN = path.resolve(import.meta.dir, "../../packages/workit-cli/src/main.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

// ---------------------------------------------------------------------------
// light commands

test("Given formatters and linters on named files, When classified, Then each is light", () => {
  const root = temp("wk-light-");
  for (const [argv, kind] of [
    [["bunx", "oxfmt", "a.ts"], "formatter"],
    [["oxfmt"], "formatter"],
    [["npx", "-y", "prettier", "--write", "."], "formatter"],
    [["bun", "run", "format:check"], "formatter"],
    [["pnpm", "format"], "formatter"],
    [["cargo", "fmt", "--check"], "formatter"],
    [["uv", "run", "ruff", "format", "src"], "formatter"],
    [["npx", "eslint", "src/a.ts", "src/b.tsx"], "file-lint"],
    [["bunx", "oxlint", "--max-warnings", "0", "a.ts"], "file-lint"],
    [["pnpm", "exec", "biome", "lint", "a.ts"], "file-lint"],
    [["python3", "-m", "ruff", "check", "a.py"], "file-lint"],
  ] as const)
    expect(lightCommand(argv, root)?.kind, argv.join(" ")).toBe(kind);
});

test("Given linters over a directory or glob and test or build runs, When classified, Then none is light", () => {
  const root = temp("wk-light-");
  mkdirSync(path.join(root, "pkg.ts"));
  for (const argv of [
    ["npx", "eslint", "src"],
    ["npx", "eslint", "."],
    ["eslint", "src/**/*.ts"],
    ["eslint"],
    ["eslint", "pkg.ts"],
    ["biome", "check", "src"],
    ["bun", "test"],
    ["bun", "run", "lint"],
    ["bunx", "tsc", "--noEmit"],
    ["cargo", "test"],
  ])
    expect(lightCommand(argv, root), argv.join(" ")).toBeNull();
});

test("Given a file-scoped linter, When the shell gate plans it, Then it runs as typed, while the same linter over a directory still goes through the lease", () => {
  const root = temp("wk-light-gate-");
  mkdirSync(path.join(root, ".git"));
  const bin = temp("wk-light-bin-");
  writeFileSync(path.join(bin, "workit"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "workit"), 0o755);
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, WORKIT_STATE_DIR: temp("s-") };
  for (const host of ["claude_code", "opencode", "codex_cli", "cursor", "pi"] as const) {
    expect(heavyGate(root, "npx eslint src/a.ts", { host, env }), host).toEqual({ kind: "none" });
    expect(heavyGate(root, "npx eslint src", { host, env }).kind, host).not.toBe("none");
  }
});

// ---------------------------------------------------------------------------
// the re-queue

const ALIVE = { alive: () => true, boot: null } as const;

const holderLease = (check: string, cwd: string): LeaseRecord => {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    pid: process.pid,
    processStart: null,
    bootId: null,
    bootTime: null,
    pgid: null,
    pgidStart: null,
    maxAgeMs: null,
    check,
    cwd,
    session: "s-suite",
    startedAt: now,
    scope: null,
    heartbeatAt: now,
    maxHoldMs: 3_600_000,
  };
};

const holdSlot = (leases: string, record: LeaseRecord) => {
  mkdirSync(leases, { recursive: true });
  writeFileSync(path.join(leases, "slot-0.json"), `${JSON.stringify(record)}\n`);
};

const acquireOptions = (dir: string, overrides: Partial<AcquireOptions>): AcquireOptions => ({
  dir,
  slots: 1,
  check: "unit",
  cwd: "/repo/mine",
  session: "s-mine",
  waitMs: 60,
  pollMs: 5,
  probe: ALIVE,
  ...overrides,
});

test("Given every slot held, When the wait reaches its limit, Then onLimit re-queues it once in the same ticket and it fails only at the second limit", async () => {
  const leases = path.join(temp("wk-requeue-"), "leases");
  holdSlot(leases, holderLease("test", "/repo/suite"));
  const calls: QueueStatus[] = [];
  const tickets = new Set<string>();
  const result = await acquireLease(
    acquireOptions(leases, {
      onLimit: (status) => {
        calls.push(status);
        for (const name of readdirSync(path.join(leases, "queue"))) tickets.add(name);
        return 60;
      },
      onStatus: () => {
        for (const name of readdirSync(path.join(leases, "queue"))) tickets.add(name);
      },
      statusEveryMs: 10,
    }),
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].holders[0]?.check).toBe("test");
  expect(result.ok).toBe(false);
  if (result.ok || result.reason !== "timeout") throw new Error("expected a timeout");
  expect(result.requeuedAfterMs).toBeGreaterThanOrEqual(60);
  expect(result.waitedMs).toBeGreaterThanOrEqual(120);
  // One ticket the whole time: the re-queue kept its place.
  expect([...tickets].filter((name) => name.endsWith(".json"))).toHaveLength(1);
  expect(readdirSync(path.join(leases, "queue"))).toEqual([]);
});

test("Given a re-queued wait, When the slot frees during the second limit, Then it takes the slot", async () => {
  const leases = path.join(temp("wk-requeue-"), "leases");
  holdSlot(leases, holderLease("test", "/repo/suite"));
  const result = await acquireLease(
    acquireOptions(leases, {
      onLimit: () => {
        setTimeout(() => rmSync(path.join(leases, "slot-0.json"), { force: true }), 20);
        return 5_000;
      },
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) result.lease.release();
});

test("Given no onLimit, When the wait reaches its limit, Then it fails at once, unrequeued", async () => {
  const leases = path.join(temp("wk-requeue-"), "leases");
  holdSlot(leases, holderLease("test", "/repo/suite"));
  const result = await acquireLease(acquireOptions(leases, {}));
  expect(result).toMatchObject({ ok: false, reason: "timeout", requeuedAfterMs: null });
});

test("requeueMs keeps the limit, within what --timeout leaves a run", () => {
  expect(requeueMs(1_800_000, 0, 1_800_000)).toBe(1_800_000);
  expect(requeueMs(60_000, 600_000, 60_000)).toBe(60_000);
  expect(requeueMs(300_000, 600_000, 300_000)).toBe(290_000);
  expect(requeueMs(300_000, 310_000, 300_000)).toBe(0);
});

test("retryWaitMs suggests half again the estimate, at least 5m, else the limit reached", () => {
  expect(retryWaitMs({ ms: 600_000 }, 1_800_000)).toBe(900_000);
  expect(retryWaitMs({ ms: 1_000 }, 1_800_000)).toBe(300_000);
  expect(retryWaitMs({ ms: 0 }, 120_000)).toBe(120_000);
  expect(retryWaitMs({ ms: null, unmeasured: ["test"] }, 0)).toBe(1_800_000);
});

test("retryCommand repeats the invocation from its cwd with its wait replaced", () => {
  expect(retryCommand(["test", "--no-wait"], "/wt", 900_000)).toBe(
    "workit check --cwd /wt test --wait 15m",
  );
  expect(retryCommand(["--heavy", "--wait", "2", "--", "bun", "-e", "a b"], "/wt", 61_000)).toBe(
    "workit check --cwd /wt --heavy --wait 2m -- bun -e 'a b'",
  );
  expect(retryCommand(["--wait=30m", "--name", "x", "--", "--wait"], "/wt", 60_000)).toBe(
    "workit check --cwd /wt --name x --wait 1m -- --wait",
  );
});

// ---------------------------------------------------------------------------
// the CLI: a full suite holds every slot

const repo = (slots: number) => {
  const root = temp("wk-lease-light-");
  git(root, "init", "-q", "-b", "feature/light");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "T");
  writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
  git(root, "add", "a.ts");
  git(root, "commit", "-qm", "base");
  const state = temp("wk-lease-light-state-");
  const config = temp("wk-lease-light-config-");
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "here", glob: "**", resources: { scope: false, slots } }],
    }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKIT_SESSION_ID: "s-light",
    WORKIT_WORKSPACE_ROOT: "",
    WORKIT_STATE_DIR: state,
    WORKIT_CONFIG_DIR: config,
    WORKIT_LEASE: "",
  };
  for (const key of ["CLAUDECODE", "OPENCODE", "OPENCODE_SESSION_ID"]) delete env[key];
  return { root, env, leases: path.join(state, "leases") };
};

const cli = (args: string[], root: string, env: NodeJS.ProcessEnv) =>
  new Promise<{ code: number | null; stderr: string; stdout: string; ms: number }>((resolve) => {
    const started = Date.now();
    const child = spawn(BUN, [MAIN, args[0], "--cwd", root, ...args.slice(1)], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk) => void (stderr += String(chunk)));
    child.stdout.on("data", (chunk) => void (stdout += String(chunk)));
    const killer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stderr, stdout, ms: Date.now() - started });
    });
  });

test("Given a full suite holding every slot, When `workit check --heavy -- <formatter> a.ts` runs, Then it runs at once without the lease and says why", async () => {
  // `bunx oxfmt a.ts` classifies as this same formatter (above); the run
  // goes through a package script so it needs no oxfmt binary on any OS.
  expect(lightCommand(["bunx", "oxfmt", "a.ts"])?.kind).toBe("formatter");
  const { root, env, leases } = repo(1);
  holdSlot(leases, holderLease("test", root));
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", private: true, scripts: { format: "echo formatted" } }),
  );
  const run = await cli(
    ["check", "--heavy", "--wait", "3", "--json", "--", BUN, "run", "format", "a.ts"],
    root,
    env,
  );
  expect(run.code, run.stderr).toBe(0);
  expect(run.stderr).toContain(
    "running at once without the heavy-check lease: `bun run format` only formats",
  );
  expect(run.stderr).not.toContain("waiting for the heavy-check lease");
  const envelope = JSON.parse(run.stdout) as { data: Record<string, unknown> };
  expect(envelope.data.lease).toBeNull();
  expect(envelope.data.light).toMatchObject({ kind: "formatter", tool: "bun format" });
  expect(envelope.data.logTail).toContain("formatted a.ts");
});

test("Given a full suite holding every slot, When a heavy check waits past its limit, Then it re-queues once printing the estimate and fails after the second limit with the exact retry command", async () => {
  const { root, env, leases } = repo(1);
  // The holder's check last ran 10 minutes: that is the estimate.
  appendObserved(root, {
    type: "check",
    actor: { host: "workit_cli", session: "s-suite", agentId: null },
    name: "test",
    result: "passed",
    timedOut: false,
    durationMs: 600_000,
  });
  holdSlot(leases, holderLease("test", root));
  const run = await cli(
    ["check", "--heavy", "--wait", "2", "--json", "--", BUN, "-e", "0"],
    root,
    env,
  );
  expect(run.code, run.stderr).toBe(4);
  expect(run.stderr).toMatch(
    /waited \d+s for the heavy-check lease at queue position 1: re-queued once in the same place for up to 2s more; estimated wait ~9m \d+s/u,
  );
  expect(run.stderr.match(/re-queued once/gu)).toHaveLength(1);
  const envelope = JSON.parse(run.stdout) as {
    error: string;
    unblock: string;
    data: { lease: { retry: string; requeuedAfterMs: number; estimatedWaitMs: number } };
  };
  expect(envelope.error).toMatch(/stayed busy for \d+s \(re-queued once after \d+s\)/u);
  const retry = `workit check --cwd ${shellWord(root)} --heavy --json --wait 15m -- ${shellWord(BUN)} -e 0`;
  expect(envelope.data.lease.retry).toBe(retry);
  expect(envelope.unblock).toContain(retry);
  expect(envelope.data.lease.requeuedAfterMs).toBeGreaterThanOrEqual(2_000);
  expect(run.ms).toBeGreaterThanOrEqual(4_000);
});

// ---------------------------------------------------------------------------
// fanout plan

const slice = (id: string, verify: string[]): Slice =>
  ({ id, verify, dependsOn: [], scope: [`${id}/**`] }) as unknown as Slice;

test("fullSuiteVerify finds heavy named checks and untargeted heavy runs, not targeted or light ones", () => {
  const root = temp("wk-verify-");
  mkdirSync(path.join(root, ".git"));
  const heavy = ["test", "build", "packaging"];
  expect(fullSuiteVerify("workit check typecheck; workit check test", heavy, root)).toBe(
    "workit check test",
  );
  expect(fullSuiteVerify("workit check --cwd /wt test", heavy, root)).toBe(
    "workit check --cwd /wt test",
  );
  expect(fullSuiteVerify("bun test", heavy, root)).toBe("bun test");
  expect(fullSuiteVerify("workit check --heavy -- bun run test", heavy, root)).toBe(
    "workit check --heavy -- bun run test",
  );
  for (const line of [
    "workit check typecheck; workit check lint",
    "bun test test/workit-core/a.test.ts",
    "workit check --name unit -- bun test test/a.test.ts",
    "workit check --heavy -- bunx oxfmt a.ts",
  ])
    expect(fullSuiteVerify(line, heavy, root), line).toBeNull();
});

test("leaseContention warns per wave only when more slices run a full suite than there are slots", () => {
  const root = temp("wk-verify-");
  mkdirSync(path.join(root, ".git"));
  const slices = ["a", "b", "c"].map((id) => slice(id, ["workit check test"]));
  const lease = { slots: 2, heavy: ["test"] };
  expect(leaseContention(slices, [["a", "b"], ["c"]], lease, root)).toEqual([]);
  const [warning] = leaseContention(slices, [["a", "b", "c"]], lease, root);
  expect(warning).toContain("3 slices (a, b, c) run a full suite in VERIFY");
  expect(warning).toContain("2 heavy-check lease slots");
});

test("Given a plan with 6 slices whose VERIFY runs the full test check and 2 lease slots, When `workit fanout plan` runs, Then it warns with the slot count and suggests targeted test files", async () => {
  const { root, env } = repo(2);
  git(root, "branch", "-M", "main");
  const ids = ["s1", "s2", "s3", "s4", "s5", "s6"];
  const plan = {
    name: "suite-heavy",
    trunk: "main",
    slices: ids.map((id) => ({
      id,
      branch: `feature/${id}`,
      tier: "standard",
      reason: "parallel",
      scope: [`${id}/**`],
      goal: `do ${id}`,
      acceptance: [`Given ${id}, When run, Then done`],
      verify: ["workit check typecheck; workit check test"],
      forbidden: ["nothing else"],
    })),
  };
  const file = path.join(temp("wk-plan-"), "plan.json");
  writeFileSync(file, JSON.stringify(plan));
  const run = await cli(["fanout", "plan", file], root, env);
  expect(run.code, run.stderr + run.stdout).toBe(0);
  const out = run.stdout + run.stderr;
  expect(out).toContain(
    "warning: 6 slices (s1, s2, s3, s4, s5, s6) run a full suite in VERIFY (`workit check test`), but this machine has 2 heavy-check lease slots: 4 of them queue",
  );
  expect(out).toContain("its targeted test files");

  const targeted = {
    ...plan,
    name: "suite-targeted",
    slices: plan.slices.map((item) => ({
      ...item,
      branch: `${item.branch}-t`,
      verify: [`workit check --name unit -- bun test test/${item.id}.test.ts`],
    })),
  };
  writeFileSync(file, JSON.stringify(targeted));
  const quiet = await cli(["fanout", "plan", file], root, env);
  expect(quiet.code, quiet.stderr + quiet.stdout).toBe(0);
  expect(quiet.stdout + quiet.stderr).not.toContain("run a full suite in VERIFY");
});
