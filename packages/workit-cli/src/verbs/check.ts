// `workit check` (design §2.1 S9, §2.2; D5, D14, D18): run a command and
// record what the CLI itself observed.
//
//   workit check <name> [--timeout <s>] [--task <id>] [--no-lease --reason <why>] [--json]   # the configured command
//   workit check [--name <n>] [--shell] [--heavy] [--wait <dur> | --no-wait] [--timeout <s>] [--task <id>] [--json] -- <cmd…>
//
// - The command runs without a shell (with --shell, pass one command string).
//   Its combined output goes to a bounded, redacted log blob; the agent sees
//   only the last OUTPUT_LINES lines of it (the failing tail, never the head)
//   and one summary line naming the full log's path (#426). --full streams
//   the output as it runs instead (to stderr under --json, so stdout stays
//   one envelope).
// - The run is keyed to the code (HEAD, worktree tree key, base + patch-id)
//   and recorded as `observer:"workit_cli"` evidence: always in the ledger
//   (`type:"check"`), and in a task: --task, else the implicit task of the
//   current branch, created by this run when there is none (D3). Attestation stays null until a
//   host hook attests the run.
// - It is *configured* only when the name is in the check config
//   (.workit/checks.json, else detected ecosystem defaults) and argv is exactly
//   that name's command, run from the repo top; --shell runs never are. Only
//   configured runs satisfy gates; `workit check -- true` never does.
// - The tree key is taken before and after the run: a command that changed
//   the worktree leaves stale evidence (`modifiedWorktree`).
// - A heavy check (a named check listed in `resources.heavy`, default
//   test/build; an ad-hoc one only with --heavy) first takes a machine-wide
//   lease (core/resources.ts), queueing round-robin per session for a free
//   slot (#608: `workit lock cancel` ends the wait, a stuck holder is shown
//   and can be reaped), and on
//   Linux with a delegated user systemd runs in its own `systemd-run --user
//   --scope` with MemoryMax and CPUQuota. `--json` reports `lease` and `scope`.
//   `--no-lease` skips both and needs `--reason`, recorded as `noLease`.
//   Light checks (`resources.light`, default lint/typecheck/format) never
//   take it, nor does an ad-hoc formatter or file-scoped linter, even with
//   --heavy (check-config.ts lightCommand; #418). A queued check prints a
//   status line every 30 s (holder, position, elapsed, and an estimated wait
//   from the ledger's last measured runs) and waits `--wait <dur>` ("90",
//   "90s", "30m"), else `resources.wait` (default 30 min); at that limit it
//   re-queues once in the same place, printing the estimate, and gives up
//   only at the second limit, naming the exact retry command. `--no-wait`
//   gives up at once (#508).
//   `--timeout` bounds the whole check, the lease wait included (#645): a
//   queued check never outlives the timeout its caller set.
// - Exit code: the command's own (4 on --timeout, on --no-wait with the lease
//   busy, or a lease wait that timed out, was cancelled or left less than
//   runFloorMs of --timeout to run, 2 on usage). Both timeouts exit 4 (the CLI
//   codes table has no free code, and any other code is a command's own):
//   `--json` tells them apart, `busy` with `data.lease` for the wait, `failed`
//   with `data.timedOut` for the command. When the
//   command passed but the evidence could not be recorded, the recording
//   error's code (busy 4, unavailable 5) so a green run is never mistaken for
//   recorded evidence.
import fs from "node:fs";
import path from "node:path";
import {
  CHECKS_FILE,
  checkCommand,
  checkRoot,
  gateCheckNames,
  lightCommand,
  loadCheckConfig,
  matchesNamedCheck,
  splitCommand,
  type CheckConfig,
  type LightCommand,
} from "@workit-dev/core/src/check-config";
import {
  TAIL_LINES,
  redactLog,
  runCheckCommand,
  storeLog,
  tailLines,
} from "@workit-dev/core/src/checks";
import { worktreeSignal, worktreeTree } from "@workit-dev/core/src/git/rev";
import pkg from "../../package.json" with { type: "json" };
import {
  MAX_LINE_BYTES,
  actorFromEnv,
  appendObserved,
  codeKey,
  storeRoot,
  type CodeKey,
} from "@workit-dev/core/src/ledger";
import { emit, fail, type EnvelopeCode, type Io } from "../output";
import { progressFor, type ProgressStep } from "../progress";
import { hostSessionFromEnv } from "@workit-dev/core/src/host-session";
import {
  acquireLease,
  describeHolder,
  formatWait,
  parseWait,
  firstNotice,
  heldLease,
  leaseDir,
  recordGroup,
  resolveResourceSettings,
  runScoped,
  scopePrefix,
  scopeSupport,
  updateLease,
  type HeldLease,
  type LeaseHolder,
  type QueueStatus,
  type Reclaimed,
  type ResourceSettings,
} from "@workit-dev/core/src/core/resources";
import { startHeartbeat } from "@workit-dev/core/src/core/heavy-lease";
import {
  describeEstimate,
  estimateWait,
  holdLimit,
  ledgerDurations,
  type WaitEstimate,
} from "@workit-dev/core/src/core/heavy-eta";
import { announce, BACKGROUND_HINT } from "./forge-common";
import { configDir } from "@workit-dev/core/src/core/workit-paths.mjs";

const USAGE =
  'workit check <name> [--full] [--wait <dur> | --no-wait] [--no-lease --reason "<why>"] | workit check [--name <n>] [--shell] [--heavy] [--full] [--wait <dur> | --no-wait] [--timeout <s>] [--task <id>] [--json] -- <cmd…>';
/**
 * Output lines a check prints by default: enough for a compiler error or a
 * failing test with its stack, far below a build log (#426). --full streams all.
 */
export const OUTPUT_LINES = 60;
/**
 * A check whose lease wait left it less than this of its --timeout (at most a
 * quarter of it) gives up as a wait timeout instead of starting a command it
 * would kill at once.
 */
const MIN_RUN_MS = 10_000;
const runFloorMs = (timeoutMs: number): number => Math.min(MIN_RUN_MS, Math.floor(timeoutMs / 4));
/** Lease age bound for a check without --timeout, where the holder cannot be identified. */
const MAX_UNVERIFIED_RUN_MS = 6 * 3_600_000;

/** How often a running check says it is still running, so a host never sees silence (#645). */
const CHECK_STATUS_MS = 60_000;
/** Tail lines kept on the task record (the envelope carries TAIL_LINES). */
const RECORD_TAIL_LINES = 20;
const RECORD_TAIL_CHARS = 200;

type Options = {
  name: string | null;
  shell: boolean;
  heavy: boolean;
  /** Stream the child's output as it runs instead of printing its tail. */
  full: boolean;
  noLease: boolean;
  /** Why the run skips the lease; required with --no-lease. */
  reason: string | null;
  /** The lease wait (ms): --wait, 0 for --no-wait; null keeps resources.wait. */
  waitMs: number | null;
  timeoutMs: number;
  task: string | null;
  base: string | null;
  positionals: string[];
  command: string[] | null;
};

function parse(argv: readonly string[]): Options | Error {
  const split = argv.indexOf("--");
  const head = split >= 0 ? argv.slice(0, split) : [...argv];
  const options: Options = {
    name: null,
    shell: false,
    heavy: false,
    full: false,
    noLease: false,
    reason: null,
    waitMs: null,
    timeoutMs: 0,
    task: null,
    base: null,
    positionals: [],
    command: split >= 0 ? argv.slice(split + 1) : null,
  };
  let noWait = false;
  for (let index = 0; index < head.length; index += 1) {
    const arg = head[index];
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? arg.split(/=(.*)/su) : [arg];
    const value = (): string | Error => {
      const next = inline ?? head[++index];
      return next === undefined || (inline === undefined && next.startsWith("--"))
        ? new Error(`${flag} requires a value`)
        : next;
    };
    if (flag === "--json") continue;
    if (flag === "--shell" || flag === "--full") {
      if (flag === "--shell") options.shell = true;
      else options.full = true;
      continue;
    }
    if (flag === "--heavy" || flag === "--no-lease") {
      if (flag === "--heavy") options.heavy = true;
      else options.noLease = true;
      continue;
    }
    if (flag === "--no-wait") {
      if (options.waitMs !== null && !noWait) return new Error("--no-wait goes without --wait");
      noWait = true;
      options.waitMs = 0;
      continue;
    }
    if (
      flag === "--name" ||
      flag === "--task" ||
      flag === "--base" ||
      flag === "--timeout" ||
      flag === "--wait" ||
      flag === "--reason"
    ) {
      const got = value();
      if (got instanceof Error) return got;
      if (flag === "--name") options.name = got;
      else if (flag === "--reason") options.reason = got.trim() || null;
      else if (flag === "--wait") {
        if (noWait) return new Error("--no-wait goes without --wait");
        const waitMs = parseWait(got);
        if (waitMs === null)
          return new Error('--wait must be seconds or a duration ("90", "90s", "30m", "1h")');
        options.waitMs = waitMs;
      } else if (flag === "--task") options.task = got;
      else if (flag === "--base") options.base = got;
      else {
        const seconds = Number(got);
        if (!Number.isFinite(seconds) || seconds <= 0)
          return new Error("--timeout must be a positive number of seconds");
        options.timeoutMs = Math.round(seconds * 1000);
      }
      continue;
    }
    if (arg.startsWith("-")) return new Error(`unknown option ${arg}`);
    options.positionals.push(arg);
  }
  if (options.noLease && !options.reason)
    return new Error(
      '--no-lease needs --reason "<why>": heavy commands share one machine-wide lease so parallel agents cannot exhaust memory and CPU',
    );
  if (options.reason && !options.noLease) return new Error("--reason goes with --no-lease");
  return options;
}

const posix = (value: string): string => value.split(path.sep).join("/") || ".";

type TaskOutcome = {
  task: { id: string; created: boolean } | null;
  note: string | null;
  evidenceId: string | null;
  satisfies: string[];
  stillUnsatisfied: Array<{ requirement: string; ruleId: string; reason: string; unblock: string }>;
  error: { code: EnvelopeCode; message: string } | null;
};

const ENGINE_CODES: Record<string, EnvelopeCode> = {
  busy: "busy",
  not_found: "not_found",
  invalid_input: "invalid_input",
  permission_denied: "blocked",
};

async function recordInTask(
  io: Io,
  storeDir: string,
  requested: string | null,
  observation: Record<string, unknown>,
  unblockFor: (dimension: string) => string,
): Promise<TaskOutcome> {
  const empty: TaskOutcome = {
    task: null,
    note: null,
    evidenceId: null,
    satisfies: [],
    stillUnsatisfied: [],
    error: null,
  };
  // The engine pulls zod; load it only here.
  const { TaskStore, WorkitCore } = await import("@workit-dev/core/src/core");
  const store = new TaskStore(storeDir);
  let taskId = requested;
  let created = false;
  if (!taskId) {
    // The implicit task of this branch (D3): created by its first recording.
    const actor = hostSessionFromEnv(io.env).session ?? "cli";
    const found = store.implicitTask({
      provenance: {
        kind: "host_observed",
        host: "workit_cli",
        session: { kind: "host", host: "workit_cli", handle: actor },
        workerId: null,
      },
    });
    if (!found.ok || !found.data)
      return {
        ...empty,
        note: "the task store is unavailable; recorded to the ledger only",
        error: {
          code: !found.ok && found.code === "busy" ? "busy" : "unavailable",
          message: found.ok ? "task store: no task" : `task store: ${found.code}: ${found.error}`,
        },
      };
    taskId = found.data.task.id;
    created = found.data.created;
  }
  const core = new WorkitCore(store, {
    root: store.root,
    caller: { host: "workit_cli", actor: hostSessionFromEnv(io.env).session ?? "cli" },
    provenanceKind: "host_observed",
    capabilities: [],
    constraints: [],
    now: () => new Date().toISOString(),
  });
  const recorded = core.observeCheck({
    taskId,
    observation: observation as Parameters<typeof core.observeCheck>[0]["observation"],
  });
  if (!recorded.ok)
    return {
      ...empty,
      task: { id: taskId, created },
      error: {
        code: ENGINE_CODES[recorded.code] ?? "unavailable",
        message: `${recorded.code}: ${recorded.error}`,
      },
    };
  const outcome: TaskOutcome = {
    ...empty,
    task: { id: taskId, created },
    evidenceId: recorded.data.id,
  };
  const view = core.task({ schemaVersion: 1, action: "inspect", taskId, view: "summary" });
  const task = store.readTask(taskId);
  if (!view.ok || !task.ok) return outcome;
  const requirements = (view.data as { requirements?: unknown }).requirements;
  if (!Array.isArray(requirements)) return outcome;
  const byId = new Map<string, NonNullable<typeof task.data.policy>["requirements"][number]>();
  for (const entry of task.data.policy?.requirements ?? [])
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  for (const item of requirements as Array<{
    requirementId: string;
    status: string;
    evidenceIds: string[];
    reason: string;
  }>) {
    const requirement = byId.get(item.requirementId);
    if (!requirement) continue;
    if (item.status === "satisfied" && item.evidenceIds.includes(recorded.data.id))
      outcome.satisfies.push(requirement.id);
    else if (
      (item.status === "unsatisfied" || item.status === "unavailable") &&
      (requirement.dimension === "testing" || requirement.dimension === "verification") &&
      requirement.before === "close"
    )
      outcome.stillUnsatisfied.push({
        requirement: requirement.id,
        ruleId: requirement.ruleId,
        reason: item.reason,
        unblock: unblockFor(requirement.dimension),
      });
  }
  return outcome;
}

/** Environment variables that change how checks run; recorded by name and value. */
const FINGERPRINT_VARS = ["CI", "NODE_ENV", "npm_config_script_shell", "NODE_OPTIONS", "SHELL"];

/** A minimal environment fingerprint for the observation (values redacted, bounded). */
function environmentFingerprint(env: NodeJS.ProcessEnv) {
  const vars: Record<string, string | null> = {};
  for (const name of FINGERPRINT_VARS) {
    const value = env[name];
    vars[name] = value === undefined ? null : redactLog(value).slice(0, 200);
  }
  return { platform: process.platform, arch: process.arch, vars };
}

/** A ledger row stays under MAX_LINE_BYTES: long argv entries are cut. */
function boundedArgv(argv: readonly string[]): { argv: string[]; truncated: boolean } {
  let cut = argv.map((item) => (item.length > 200 ? `${item.slice(0, 200)}…` : item));
  if (cut.length > 24) cut = [...cut.slice(0, 24), `… ${argv.length - 24} more`];
  const truncated = cut.length !== argv.length || cut.some((item, index) => item !== argv[index]);
  return { argv: cut, truncated };
}

const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

// Warning lines of common tools, anchored at the line start so prose that only
// contains the word is not counted: oxlint/rustc "warning[...]:" and "warning:", eslint stylish
// "3:5  warning  ...", piped oxlint/gcc "a.js:1:7: warning ...", tsc "warning TS6133", "⚠", "npm WARN"/"npm warn"/"WARN ", maven "[WARNING]", bun "warn:".
const WARNING_LINE =
  /^\s*(?:⚠|\[(?:WARN|WARNING|warn|warning)\]|(?:npm\s+)?(?:WARN\s|warn\s)|warn(?:ing)?(?:\[[^\]]*\])?:|\d+:\d+\s+warning\s|\S+\(\d+,\d+\):\s*warning\s|\S+:\d+:\d+:\s*warning\b)/;
// "warning: no warnings found", "warn: 0 warnings": a statement that there are none.
const NO_WARNINGS = /\b(?:no|0|zero|none)\s+warnings?\b/i;

/** How many lines of a check's output are tool warnings (a green check can still print them). */
export function countWarnings(log: string): number {
  return redactLog(log)
    .replace(ANSI_COLOR, "")
    .split("\n")
    .filter((line) => WARNING_LINE.test(line) && !NO_WARNINGS.test(line)).length;
}

/** The child's last stderr lines the bounded output always shows. */
const STDERR_TAIL_LINES = 10;
/** How much of the child's stderr is kept for that tail. */
const STDERR_KEEP_CHARS = 64 * 1024;

/** A line that names a failing test or error (Bun `(fail) name`, `FAIL`, `✗`, `error:`). */
const FAILURE_LINE = /^\s*(?:\(fail\)|FAIL\b|✗|error:)/u;
/** Failure marker lines listed from the omitted head. */
const MAX_FAILURE_LINES = 15;

/**
 * The last `lines` lines of a check's output, after one line saying how many
 * earlier ones were left out: a failure shows its failing tail, never the head.
 * stdout and stderr arrive on separate pipes, so under load the error a child
 * printed last can sit earlier in the merged log; the last stderr lines
 * (`stderr`) missing from the tail are shown after it, within the same budget.
 */
export function boundedOutput(log: string, lines: number, stderr = "", failed = false): string {
  const all = tailLines(log, Number.MAX_SAFE_INTEGER);
  if (all.length === 0) return "";
  // A failing run also lists the failure markers its omitted head holds.
  const markers = failed ? [...new Set(all.filter((line) => FAILURE_LINE.test(line)))] : [];
  const listed = markers.slice(0, MAX_FAILURE_LINES);
  const more = markers.length - listed.length;
  const failureRoom = listed.length ? listed.length + 2 + (more > 0 ? 1 : 0) : 0;
  let shown = all.slice(-Math.max(1, lines - failureRoom));
  const errors = tailLines(redactLog(stderr), STDERR_TAIL_LINES);
  let missing: string[] = [];
  if (errors.length) {
    const tail = new Set(shown);
    if (errors.some((line) => !tail.has(line))) {
      // Room for the stderr lines and their header, plus the omitted-lines header.
      shown = all.slice(-Math.max(1, lines - failureRoom - errors.length - 2));
      const kept = new Set(shown);
      missing = errors.filter((line) => !kept.has(line));
    }
  }
  const omitted = all.length - shown.length;
  const inTail = new Set([...shown, ...missing]);
  const failures = listed.filter((line) => !inTail.has(line));
  const failureFooter = failures.length
    ? `… failures from the omitted lines:\n${failures.join("\n")}\n${more > 0 ? `+${more} more failures in the log\n` : ""}`
    : "";
  const footer = missing.length
    ? `… the last stderr lines, which the merged log holds earlier:\n${missing.join("\n")}\n`
    : "";
  return `${omitted ? `… ${omitted} earlier line${omitted === 1 ? "" : "s"} omitted (the full log is named below; --full streams it)\n` : ""}${failureFooter}${shown.join("\n")}\n${footer}`;
}

/** `resources` of the workspaces.json entry matching `cwd`, read from io.env's config dir. */
export async function workspaceResources(
  io: Io,
): Promise<{ value: unknown; warning: string | null }> {
  const env = io.env;
  const dir = configDir(env);
  try {
    const { resolveWorkspaceFrom } = await import("@workit-dev/core/src/core/workspaces");
    const workspace = resolveWorkspaceFrom(
      io.cwd,
      dir,
      env.WORKIT_WORKSPACE_NAME?.trim() || undefined,
    ) as Record<string, unknown> | null;
    return { value: workspace?.resources, warning: null };
  } catch (error) {
    return { value: undefined, warning: `workspaces.json: ${(error as Error).message}` };
  }
}

type LeaseReport = {
  slot: number | null;
  waitedMs: number;
  /** The first holder this run waited on; null when the lease was free. */
  holder: LeaseHolder | null;
  reclaimed: Reclaimed[];
  /** Set when an outer heavy check already holds the lease for this process tree. */
  inherited: boolean;
};
type ScopeReport =
  | { unit: string; memoryMax: string; cpuQuota: string }
  | { unit: string | null; reason: string };

type HeavyRun = {
  lease: HeldLease | null;
  leaseReport: LeaseReport | null;
  scope: ScopeReport;
  wrapper: string[] | null;
  env: NodeJS.ProcessEnv;
};

/**
 * How long a wait that reached its limit keeps queueing (once): the limit
 * again, within what --timeout leaves a run; 0 when that is nothing.
 */
export function requeueMs(waitMs: number, timeoutMs: number, waitedMs: number): number {
  if (timeoutMs <= 0) return waitMs;
  return Math.max(0, Math.min(waitMs, timeoutMs - waitedMs - runFloorMs(timeoutMs)));
}

/** A wait that never measured the holders' runs suggests this --wait. */
const RETRY_WAIT_MS = 30 * 60_000;
/** The shortest --wait a retry suggests. */
const MIN_RETRY_WAIT_MS = 5 * 60_000;

/** The --wait a retry suggests: half again the estimated wait, else the limit it reached. */
export function retryWaitMs(estimate: WaitEstimate, waitMs: number): number {
  if (estimate.ms) return Math.max(MIN_RETRY_WAIT_MS, Math.ceil(estimate.ms * 1.5));
  return waitMs > 0 ? waitMs : RETRY_WAIT_MS;
}

/** One word of a retry command, single-quoted unless plain (POSIX shells and PowerShell read it alike). */
export const shellWord = (word: string): string =>
  /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/** `argv` (a `workit check` invocation in `cwd`) again, its wait replaced by `--wait <minutes>m`. */
export function retryCommand(argv: readonly string[], cwd: string, waitMs: number): string {
  const split = argv.indexOf("--");
  const head = split >= 0 ? argv.slice(0, split) : [...argv];
  const kept: string[] = [];
  for (let index = 0; index < head.length; index += 1) {
    const arg = head[index];
    if (arg === "--no-wait" || arg.startsWith("--wait=")) continue;
    if (arg === "--wait") {
      index += 1;
      continue;
    }
    kept.push(arg);
  }
  const wait = ["--wait", `${Math.ceil(waitMs / 60_000)}m`];
  const words = [
    "workit",
    "check",
    "--cwd",
    cwd,
    ...kept,
    ...wait,
    ...(split >= 0 ? argv.slice(split) : []),
  ];
  return words.map(shellWord).join(" ");
}

/** The argv of a --shell command string, or null when it uses shell syntax. */
const shellArgv = (text: string): string[] | null => {
  const argv = splitCommand(text);
  return argv instanceof Error ? null : argv;
};

/** "queued behind test, pid 12, session s1, 28m 12s, /wt" for a gave-up wait (#608). */
export function queuedBehind(holders: LeaseHolder[], position: number): string {
  const ahead = position - 1;
  const waiters = ahead > 0 ? `${ahead} waiter${ahead === 1 ? "" : "s"} ahead` : "";
  if (!holders.length) return `queued behind ${waiters || "nobody"}`;
  return `queued behind ${holders.map((holder) => describeHolder(holder)).join("; ")}${waiters ? `, then ${waiters}` : ""}`;
}

/** A ledger row naming a holder whose slot was freed while it still ran (#608). */
export function recordReaped(
  io: Io,
  holder: LeaseHolder & { reason: string },
  by: "auto" | "lock reap",
) {
  return appendObserved(io.cwd, {
    type: "lease.reaped",
    actor: actorFromEnv(io.env),
    by,
    pid: holder.pid,
    session: holder.session,
    check: holder.check,
    cwd: holder.cwd,
    startedAt: holder.startedAt,
    reason: holder.reason,
  });
}

/** Name each slot an acquire reclaimed, and record a reaped live holder (#608). */
function noteReclaimed(io: Io, reclaimed: readonly Reclaimed[]) {
  for (const stale of reclaimed) {
    io.stderr(
      `workit: reclaimed a ${stale.reaped ? "stuck" : "stale"} heavy-check lease (${stale.reason}): ${describeHolder(stale)}\n`,
    );
    if (stale.reaped) recordReaped(io, stale, "auto");
  }
}

/**
 * Take the machine lease (or reuse an outer run's) and pick the scope for a
 * heavy check. A number is the exit code when the wait timed out or was cancelled.
 */
async function prepareHeavy(
  io: Io,
  settings: ResourceSettings,
  label: string,
  runCwd: string,
  timeoutMs: number,
  retry: (waitMs: number) => string,
): Promise<HeavyRun | number> {
  // The wait is the check's own --timeout when that is shorter (#645).
  const waitByTimeout = timeoutMs > 0 && settings.waitMs >= timeoutMs;
  const waitSource = waitByTimeout ? "its --timeout" : "--wait <dur> sets it";
  const session = hostSessionFromEnv(io.env).session;
  const dir = leaseDir(io.env);
  const outer = heldLease(dir, io.env.WORKIT_LEASE);
  if (outer)
    return {
      lease: null,
      leaseReport: { slot: null, waitedMs: 0, holder: null, reclaimed: [], inherited: true },
      scope: { unit: outer.scope, reason: "inherited from the outer heavy check" },
      wrapper: null,
      env: io.env,
    };
  const progress = progressFor(io);
  let waiting: ProgressStep | null = null;
  const durationOf = ledgerDurations();
  const estimateFor = (status: Pick<QueueStatus, "holders" | "aheadOf">) =>
    estimateWait({
      slots: settings.slots,
      holders: status.holders,
      ahead: status.aheadOf,
      durationOf,
    });
  let lastEstimate: WaitEstimate | null = null;
  const acquired = await acquireLease({
    dir,
    slots: settings.slots,
    check: label,
    cwd: runCwd,
    session,
    waitMs: settings.waitMs,
    pollMs: 1000,
    // Where the holder cannot be identified (no process start time), its
    // lease ends with the check's timeout, else after MAX_UNVERIFIED_RUN_MS.
    maxAgeMs: (timeoutMs || MAX_UNVERIFIED_RUN_MS) + 60_000,
    // A check that measured 25 min is not stuck at 15 (#705 follow-up).
    maxHoldMs: settings.maxHoldMs,
    holdMs: holdLimit(durationOf({ check: label, cwd: runCwd }), settings.maxHoldMs),
    // #645: a wait bounded by the check's --timeout, or --no-wait, never re-queues.
    ...(settings.waitMs > 0 && !waitByTimeout
      ? {
          onLimit: (status: QueueStatus) => {
            const more = requeueMs(settings.waitMs, timeoutMs, status.waitedMs);
            if (more <= 0) return 0;
            lastEstimate = estimateFor(status);
            const holders = status.holders.map((holder) => describeHolder(holder)).join("; ");
            const text = `waited ${formatWait(status.waitedMs)} for the heavy-check lease at queue position ${status.position}: re-queued once in the same place for up to ${formatWait(more)} more; ${describeEstimate(lastEstimate)}; held by ${holders || "nobody; waiters ahead"}`;
            if (waiting) waiting.label(text);
            io.stderr(`workit: ${text}\n`);
            return more;
          },
        }
      : {}),
    onStatus: (status) => {
      const slots = `${settings.slots} slot${settings.slots === 1 ? "" : "s"}`;
      const holders = status.holders.map((holder) => describeHolder(holder)).join("; ");
      const estimate = describeEstimate(estimateFor(status));
      if (progress.mode === "spinner") {
        const text = `Waiting for the heavy-check lease: held by ${holders || "nobody; waiters ahead"}, queue position ${status.position}, ${estimate}`;
        if (waiting) waiting.label(text);
        else waiting = progress.start(text);
        return;
      }
      io.stderr(
        status.first
          ? `workit: waiting for the heavy-check lease (${slots}): held by ${holders || "nobody; waiters ahead"}; queued at position ${status.position}, waiting up to ${formatWait(settings.waitMs)} (${waitSource})${settings.waitMs > 0 && !waitByTimeout ? ", then once more in the same place" : ""}; ${estimate}\n`
          : `workit: still queued for the heavy-check lease: position ${status.position}, ${formatWait(status.waitedMs)} waited, ${estimate}; held by ${holders || "nobody; waiters ahead"}\n`,
      );
    },
  });
  (waiting as ProgressStep | null)?.end(acquired.ok ? "done" : "failed");
  if (!acquired.ok && acquired.reason === "cancelled") {
    emit(
      io,
      fail(
        "busy",
        `cancelled while queued for the heavy-check lease after ${formatWait(acquired.waitedMs)} (${acquired.by}); the check did not run`,
        {
          data: { lease: { cancelled: true, by: acquired.by, waitedMs: acquired.waitedMs } },
          unblock: `workit check ${label} (run it again when you want it)`,
        },
      ),
    );
    return 4;
  }
  if (!acquired.ok && acquired.reason === "timeout") {
    const holders = acquired.holders.map((holder) => describeHolder(holder)).join("; ");
    const waited = formatWait(acquired.waitedMs);
    const behind = queuedBehind(acquired.holders, acquired.position);
    const stuck = acquired.holders.some((holder) => holder.stuck);
    const requeued = acquired.requeuedAfterMs;
    const estimate = lastEstimate ?? estimateFor({ holders: acquired.holders, aheadOf: [] });
    const command = retry(retryWaitMs(estimate, settings.waitMs));
    emit(
      io,
      fail(
        "busy",
        settings.waitMs === 0
          ? `the heavy-check lease is busy (--no-wait): ${behind}`
          : waitByTimeout
            ? `the heavy-check lease stayed busy for ${waited}, the check's whole --timeout (position ${acquired.position} in the queue); the check did not run: ${behind}`
            : `the heavy-check lease stayed busy for ${waited}${requeued === null ? "" : ` (re-queued once after ${formatWait(requeued)})`}, position ${acquired.position} in the queue; the check did not run: ${behind}; ${describeEstimate(estimate)}`,
        {
          data: {
            lease: {
              waitedMs: acquired.waitedMs,
              holders: acquired.holders,
              position: acquired.position,
              queuedBehind: behind,
              requeuedAfterMs: requeued,
              estimatedWaitMs: estimate.ms,
              retry: command,
            },
          },
          unblock: stuck
            ? `workit lock reap (a holder looks stuck), then run it again: ${command}`
            : waitByTimeout
              ? `the lease wait counts toward --timeout: run it again with a longer --timeout (in a background shell when the host's tool timeout is shorter), or once ${holders || "the waiters ahead"} finish`
              : `run it again, queueing for the estimated wait: ${command}`,
        },
      ),
    );
    return 4;
  }
  if (acquired.ok && timeoutMs > 0 && timeoutMs - acquired.lease.waitedMs < runFloorMs(timeoutMs)) {
    const left = Math.max(0, timeoutMs - acquired.lease.waitedMs);
    // Its acquire may have freed a stuck holder: say so and record it, as a run would.
    noteReclaimed(io, acquired.lease.reclaimed);
    acquired.lease.release();
    emit(
      io,
      fail(
        "busy",
        `the heavy-check lease freed after ${formatWait(acquired.lease.waitedMs)} of the check's ${formatWait(timeoutMs)} --timeout, leaving ${formatWait(left)}, less than the ${formatWait(runFloorMs(timeoutMs))} a run needs; the check did not run`,
        {
          data: { lease: { waitedMs: acquired.lease.waitedMs, leftMs: left, starved: true } },
          unblock:
            "the lease wait counts toward --timeout: run it again with a longer --timeout (in a background shell when the host's tool timeout is shorter)",
        },
      ),
    );
    return 4;
  }
  let lease: HeldLease | null = null;
  if (acquired.ok) lease = acquired.lease;
  // Fail open: an unwritable state dir must not stop the check.
  else io.stderr(`workit: running without the heavy-check lease: ${acquired.error}\n`);
  noteReclaimed(io, lease?.reclaimed ?? []);
  const leaseReport: LeaseReport | null = lease
    ? {
        slot: lease.slot,
        waitedMs: lease.waitedMs,
        holder: lease.waitedOn[0] ?? null,
        reclaimed: lease.reclaimed,
        inherited: false,
      }
    : null;
  const env = lease ? { ...io.env, WORKIT_LEASE: lease.record.id } : io.env;
  const support = settings.scope
    ? scopeSupport(io.env)
    : ({ ok: false, reason: "resources.scope is false" } as const);
  if (!support.ok) {
    if (settings.scope && firstNotice(io.env, session, "no-scope"))
      io.stderr(
        `workit: heavy checks run without a memory/CPU limit here: ${support.reason} (said once per session)\n`,
      );
    return {
      lease,
      leaseReport,
      scope: { unit: null, reason: support.reason },
      wrapper: null,
      env,
    };
  }
  const unit = `workit-check-${(lease?.record.id ?? "nolease0").slice(0, 8)}-${process.pid}`;
  if (lease) updateLease(lease, { scope: `${unit}.scope` });
  return {
    lease,
    leaseReport,
    scope: { unit: `${unit}.scope`, memoryMax: settings.memoryMax, cpuQuota: settings.cpuQuota },
    wrapper: scopePrefix(unit, settings),
    env,
  };
}

/**
 * `workit check <group>`: run each member of a configured group (the `ci` group
 * is what CI runs) as its own recorded check, light ones first so they never
 * wait behind a heavy member's lease, and fail naming the members that failed.
 */
async function runGroup(
  io: Io,
  argv: string[],
  group: string,
  members: string[],
  config: CheckConfig,
): Promise<number> {
  const workspace = await workspaceResources(io);
  const { settings } = resolveResourceSettings([
    { label: "workspaces.json", trust: "machine", value: workspace.value },
    { label: CHECKS_FILE, trust: "repo", value: config.resources },
  ]);
  const isHeavy = (name: string) => settings.heavy.includes(name);
  const ordered = [...members.filter((m) => !isHeavy(m)), ...members.filter(isHeavy)];
  // The group name is the only positional; every other token is a flag (or its value) each member takes.
  const passthrough = argv.filter((arg) => arg !== group);
  const failed: string[] = [];
  for (const member of ordered) {
    io.stderr(
      `workit: check ${group}: running ${member} (${ordered.indexOf(member) + 1}/${ordered.length})\n`,
    );
    const code = await run([member, ...passthrough], io);
    if (code !== 0) failed.push(member);
  }
  if (failed.length) {
    io.stderr(
      `workit: check ${group}: FAILED ${failed.join(", ")} (${ordered.length - failed.length}/${ordered.length} passed)\n`,
    );
    return 1;
  }
  io.stderr(`workit: check ${group}: all ${ordered.length} passed (${ordered.join(", ")})\n`);
  return 0;
}

export async function run(argv: string[], io: Io): Promise<number> {
  const options = parse(argv);
  if (options instanceof Error)
    return emit(io, fail("invalid_input", options.message, { unblock: USAGE }));
  const config: CheckConfig = loadCheckConfig(io.cwd);
  if (config.note) io.stderr(`note: ${config.note}\n`);
  const requested = options.command === null ? options.positionals[0] : undefined;
  if (
    requested !== undefined &&
    options.positionals.length === 1 &&
    !config.error &&
    !config.checks.some((item) => item.name === requested)
  ) {
    const members = config.groups[requested];
    if (members && !options.name && !options.shell)
      return runGroup(io, argv, requested, members, config);
    if (requested === "ci")
      return emit(
        io,
        fail(
          "invalid_input",
          `no \`ci\` group is declared; configured checks: ${config.checks.map((item) => item.name).join(", ") || "none"}`,
          {
            data: { configured: config.checks.map((item) => item.name), source: config.source },
            unblock: `declare the checks CI runs in ${CHECKS_FILE}: {"checks":{…},"groups":{"ci":[${config.checks
              .slice(0, 3)
              .map((item) => `"${item.name}"`)
              .join(",")}]}}`,
          },
        ),
      );
  }
  const top = checkRoot(io.cwd);
  let command: string[];
  let runCwd = io.cwd;
  let name = options.name;
  if (options.command === null) {
    // `workit check <name>`: the configured command, from the repo top.
    if (options.positionals.length !== 1 || options.name || options.shell)
      return emit(
        io,
        fail("invalid_input", "pass a check name, or a command after --", { unblock: USAGE }),
      );
    name = options.positionals[0];
    if (config.error)
      return emit(io, fail("invalid_input", `check config is invalid: ${config.error}`));
    const check = config.checks.find((item) => item.name === name);
    if (!check)
      return emit(
        io,
        fail("not_found", `no configured check named "${name}"`, {
          data: { configured: config.checks.map((item) => item.name), source: config.source },
          unblock: config.checks.length
            ? `workit check ${config.checks.map((item) => item.name).join("|")}`
            : `add {"checks":{"${name}":"<command>"}} to .workit/checks.json, or run workit check --name ${name} -- <cmd…>`,
        }),
      );
    command = check.argv;
    runCwd = config.root;
  } else {
    if (options.positionals.length)
      return emit(
        io,
        fail("invalid_input", `unexpected argument ${options.positionals[0]} before --`, {
          unblock: USAGE,
        }),
      );
    command = options.command;
    if (!command.length)
      return emit(io, fail("invalid_input", "no command after --", { unblock: USAGE }));
    if (options.shell && command.length !== 1)
      return emit(
        io,
        fail(
          "invalid_input",
          '--shell takes the command as one string: workit check --shell -- "<cmd>"',
        ),
      );
  }
  const relCwd = posix(path.relative(top, runCwd));
  const configured = !options.shell && matchesNamedCheck(config, name, command, relCwd);
  // Say before the run, not after it, that an ad-hoc run of a configured
  // name will not satisfy that name's gate.
  const shadowed =
    !configured && name !== null ? config.checks.find((item) => item.name === name) : undefined;
  if (shadowed)
    io.stderr(
      `note: "${name}" is configured as \`${shadowed.argv.join(" ")}\`; this ad-hoc run does not satisfy a configured gate (run workit check ${name})\n`,
    );
  const label = name ?? command.join(" ");
  // The store is resolved once, before the run: re-resolving a checkout the
  // command removed would recreate it as a new per-directory store (#835).
  const store = storeRoot(io.cwd);
  announce(
    io,
    `check ${label}: starting (${options.timeoutMs ? `timeout ${Math.ceil(options.timeoutMs / 1000)}s` : "no timeout; --timeout <s> sets one"}); the result prints when it ends, a status line every ${CHECK_STATUS_MS / 1000}s until then; ${BACKGROUND_HINT}`,
  );
  const actor = actorFromEnv(io.env);
  const branchKey: CodeKey = codeKey(io.cwd, { base: options.base });
  // codeKey keys the tree only on a checked-out branch; a detached HEAD is
  // still a worktree whose state the run observed.
  const detached = branchKey.tree === null ? worktreeTree(io.cwd) : null;
  const key: CodeKey = detached
    ? { ...branchKey, tree: detached.key, dirty: detached.dirty }
    : branchKey;
  const signal = key.tree === null ? null : worktreeSignal(io.cwd);

  // Heavy checks queue for the machine lease and run in their own scope;
  // formatters and file-scoped linters never do, even with --heavy (#418).
  let heavy: HeavyRun | null = null;
  let light: LightCommand | null = null;
  if (!options.noLease && (options.heavy || options.command === null)) {
    const workspace = await workspaceResources(io);
    const { settings, warnings } = resolveResourceSettings([
      { label: "workspaces.json", trust: "machine", value: workspace.value },
      { label: CHECKS_FILE, trust: "repo", value: config.resources },
    ]);
    if (options.waitMs !== null) settings.waitMs = options.waitMs;
    // #645: a queued check must not outlive the timeout its caller set.
    if (options.timeoutMs > 0) settings.waitMs = Math.min(settings.waitMs, options.timeoutMs);
    for (const warning of [workspace.warning, ...warnings])
      if (warning) io.stderr(`workit: resources: ${warning}\n`);
    const takesLease = options.heavy || (name !== null && settings.heavy.includes(name));
    const adHoc = options.command === null ? null : options.shell ? shellArgv(command[0]) : command;
    light = takesLease && adHoc ? lightCommand(adHoc, runCwd) : null;
    if (light)
      io.stderr(
        `workit: running at once without the heavy-check lease: ${light.reason}, and formatters and file-scoped linters finish in seconds, so they never queue behind a full suite\n`,
      );
    else if (takesLease) {
      const prepared = await prepareHeavy(
        io,
        settings,
        name ?? command.join(" "),
        runCwd,
        options.timeoutMs,
        (waitMs) => retryCommand(argv, io.cwd, waitMs),
      );
      if (typeof prepared === "number") return prepared;
      heavy = prepared;
    }
  }
  if (options.noLease)
    io.stderr(`workit: running without the heavy-check lease: ${options.reason}\n`);
  const lease = heavy?.lease ?? null;
  const heartbeat = lease ? startHeartbeat(lease) : null;
  const beat = <T extends unknown[]>(sink: (...args: T) => void) =>
    heartbeat
      ? (...args: T) => {
          heartbeat.touch();
          sink(...args);
        }
      : sink;
  let result: Awaited<ReturnType<typeof runCheckCommand>>;
  let stderrTail = "";
  // The time queued for the lease counts toward --timeout (#645).
  const queuedMs = heavy?.leaseReport?.waitedMs ?? 0;
  // prepareHeavy gave up when the wait left less than runFloorMs.
  const runTimeoutMs = options.timeoutMs ? Math.max(1, options.timeoutMs - queuedMs) : 0;
  const runStarted = Date.now();
  const statusTimer = setInterval(
    () =>
      announce(
        io,
        `check ${label}: still running after ${Math.round((Date.now() - runStarted) / 1000)}s (pid ${process.pid})`,
      ),
    CHECK_STATUS_MS,
  );
  statusTimer.unref?.();
  try {
    const scoped = await runScoped(
      (wrapper, sinks) =>
        runCheckCommand(command, {
          cwd: runCwd,
          shell: options.shell,
          timeoutMs: runTimeoutMs,
          env: heavy?.env ?? io.env,
          ...sinks,
          ...(wrapper ? { wrapper } : {}),
          // The check's group keeps the lease held if workit itself is killed.
          ...(lease ? { onSpawn: (pid: number) => recordGroup(lease, pid) } : {}),
        }),
      heavy?.wrapper ?? null,
      options.full
        ? { onStdout: beat(io.json ? io.stderr : io.stdout), onStderr: beat(io.stderr) }
        : // One bounded writer (below) is the only path from the child to the agent.
          {
            onStdout: beat(() => {}),
            onStderr: beat((text: string) => {
              stderrTail = (stderrTail + text).slice(-STDERR_KEEP_CHARS);
            }),
          },
    );
    result = scoped.result;
    if (heavy && scoped.fallback) {
      io.stderr(
        `workit: the memory/CPU scope could not start (${scoped.fallback}); ran without it\n`,
      );
      heavy.scope = { unit: null, reason: `systemd-run failed: ${scoped.fallback}` };
    }
  } finally {
    clearInterval(statusTimer);
    heartbeat?.stop();
    lease?.release();
  }
  const passed = result.exitCode === 0 && !result.timedOut;
  const commandExit = passed ? 0 : result.timedOut ? 4 : result.exitCode || 1;
  // #835: a checkout removed while the command ran gets no record at all, so
  // no write can recreate its path; the command's exit code still stands.
  if (!fs.existsSync(top)) {
    const message = `${top} no longer exists (removed while the check ran); the result was not recorded`;
    if (io.json)
      io.stdout(
        `${JSON.stringify({ ok: false, code: passed ? "unavailable" : "failed", data: { name, argv: command, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, recorded: false, removed: top }, error: message })}\n`,
      );
    else {
      if (!options.full) io.stdout(boundedOutput(result.log, OUTPUT_LINES, stderrTail, !passed));
      io.stderr(`workit check ${label}: ${message}\n`);
    }
    return commandExit;
  }
  // Fail safe: a command that changed the worktree leaves stale evidence.
  const treeAfter = key.tree === null ? null : (worktreeTree(io.cwd)?.key ?? null);
  const modifiedWorktree = key.tree !== null && treeAfter !== key.tree;
  const blob = store.ok ? storeLog(store.value.root, result.log) : null;
  const logPath = store.ok && blob ? path.join(store.value.root, blob.ref) : null;
  const tail = tailLines(result.log, TAIL_LINES);
  const bounded = boundedArgv(command);
  const row = {
    type: "check",
    actor,
    ...key,
    name,
    configured,
    argv: bounded.argv,
    shell: options.shell,
    cwd: relCwd,
    result: passed ? "passed" : "failed",
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    logDigest: blob?.digest ?? null,
    logRef: blob?.ref ?? null,
    attestation: null,
  };
  // Keep the row inside the ledger's single-write bound.
  const ledger = appendObserved(
    io.cwd,
    JSON.stringify(row).length + 200 > MAX_LINE_BYTES
      ? { ...row, argv: [bounded.argv[0], "…"] }
      : row,
    store.ok ? { store: store.value } : {},
  );
  const observation = {
    observer: "workit_cli",
    name,
    configured,
    argv: command,
    shell: options.shell,
    cwd: relCwd,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    head: key.head,
    tree: key.tree,
    dirty: key.dirty,
    signal,
    treeAfter,
    modifiedWorktree,
    base: key.base,
    patchId: key.patchId,
    environment: environmentFingerprint(io.env),
    logDigest: blob?.digest ?? null,
    logRef: blob?.ref ?? null,
    logTail: tailLines(result.log, RECORD_TAIL_LINES).map((line) =>
      line.length > RECORD_TAIL_CHARS ? `${line.slice(0, RECORD_TAIL_CHARS)}…` : line,
    ),
    ledgerRowId: ledger.ok ? String(ledger.value.id) : null,
    attestation: null,
  };
  const unblockFor = (dimension: string): string => {
    const version = (pkg as { version: string }).version;
    if (config.error) return `fix ${CHECKS_FILE}, then ${checkCommand("<name>", version)}`;
    const names = gateCheckNames(config, dimension);
    return names.length
      ? checkCommand(names[0], version)
      : `add ${CHECKS_FILE} (e.g. {"checks":{"test":"<your test command>"}}), then ${checkCommand("test", version)}`;
  };
  const storeDir = io.env.WORKIT_WORKSPACE_ROOT || top;
  const task: TaskOutcome = await recordInTask(io, storeDir, options.task, observation, unblockFor);

  const warnings = countWarnings(result.log);
  const data = {
    evidenceId: task.evidenceId,
    ledgerRowId: observation.ledgerRowId,
    name,
    argv: command,
    configured,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    head: key.head,
    tree: key.tree,
    dirty: key.dirty,
    modifiedWorktree,
    base: key.base,
    patchId: key.patchId,
    logDigest: observation.logDigest,
    logRef: observation.logRef,
    logPath,
    logTail: tail,
    outputBytes: result.outputBytes,
    warnings,
    logTruncated: result.truncated,
    task: task.task,
    lease: heavy?.leaseReport ?? null,
    scope: heavy?.scope ?? null,
    ...(light ? { light } : {}),
    ...(options.noLease ? { noLease: { reason: options.reason } } : {}),
    ...(task.note ? { taskNote: task.note } : {}),
    satisfies: task.satisfies,
    stillUnsatisfied: task.stillUnsatisfied,
    attested: false,
  };
  const recordError = !ledger.ok
    ? { code: ledger.code as EnvelopeCode, message: `ledger: ${ledger.error}` }
    : task.error;
  const code: EnvelopeCode = !passed ? "failed" : recordError ? recordError.code : "ok";
  const error = !passed
    ? result.timedOut
      ? `timed out after ${options.timeoutMs} ms${queuedMs ? ` (${queuedMs} ms of it queued for the heavy-check lease)` : ""}`
      : result.spawnError
        ? `cannot start ${command[0]}: ${result.spawnError}`
        : `exited ${result.exitCode}`
    : recordError?.message;
  const summary = `workit check ${label}: ${passed ? "passed, exit 0" : (error ?? "failed")} in ${result.durationMs} ms (${configured ? "configured" : "ad-hoc"}${warnings ? `; warnings: ${warnings}` : ""}${name && !configured && config.checks.some((item) => item.name === name) ? `; not the configured command for "${name}"` : ""}); ${task.evidenceId ? `evidence ${task.evidenceId} on task ${task.task?.id}` : (task.note ?? (task.error ? `task: ${task.error.message}` : "ledger only"))}; log: ${logPath ?? "not stored"}`;
  if (io.json)
    io.stdout(
      `${JSON.stringify({ ok: code === "ok", code, data, ...(error ? { error } : {}), ...(task.stillUnsatisfied[0] ? { unblock: task.stillUnsatisfied[0].unblock } : {}) })}\n`,
    );
  else {
    if (!options.full) io.stdout(boundedOutput(result.log, OUTPUT_LINES, stderrTail, !passed));
    io.stderr(`${summary}\n`);
    if (recordError && passed) io.stderr(`workit: ${recordError.message}\n`);
    // The pre-run note already said an ad-hoc run of a configured name leaves its gate open.
    if (!shadowed)
      for (const gap of task.stillUnsatisfied)
        io.stderr(`  still unsatisfied: ${gap.ruleId}: ${gap.reason}\n`);
  }
  if (!passed) return commandExit;
  if (recordError)
    return recordError.code === "busy" ? 4 : recordError.code === "invalid_input" ? 2 : 5;
  return 0;
}
