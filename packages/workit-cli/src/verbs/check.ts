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
//   take it. A queued check prints a status line every 30 s (holder,
//   position, elapsed) and waits `--wait <dur>` ("90", "90s", "30m"), else
//   `resources.wait` (default 30 min); `--no-wait` gives up at once (#508).
// - Exit code: the command's own (4 on --timeout, on --no-wait with the lease
//   busy, or a lease wait that timed out or was cancelled, 2 on usage). When the
//   command passed but the evidence could not be recorded, the recording
//   error's code (busy 4, unavailable 5) so a green run is never mistaken for
//   recorded evidence.
import os from "node:os";
import path from "node:path";
import {
  CHECKS_FILE,
  checkCommand,
  checkRoot,
  gateCheckNames,
  loadCheckConfig,
  matchesNamedCheck,
  type CheckConfig,
} from "@brainervirus/workit-core/src/check-config";
import {
  TAIL_LINES,
  redactLog,
  runCheckCommand,
  storeLog,
  tailLines,
} from "@brainervirus/workit-core/src/checks";
import { worktreeSignal, worktreeTree } from "@brainervirus/workit-core/src/git/rev";
import pkg from "../../package.json" with { type: "json" };
import {
  MAX_LINE_BYTES,
  actorFromEnv,
  appendObserved,
  codeKey,
  storeRoot,
  type CodeKey,
} from "@brainervirus/workit-core/src/ledger";
import { emit, fail, type EnvelopeCode, type Io } from "../output";
import { progressFor, type ProgressStep } from "../progress";
import { hostSessionFromEnv } from "@brainervirus/workit-core/src/host-session";
import {
  acquireLease,
  describeHolder,
  formatWait,
  parseWait,
  firstNotice,
  heldLease,
  leaseDir,
  resolveResourceSettings,
  runScoped,
  scopePrefix,
  scopeSupport,
  updateLease,
  type HeldLease,
  type LeaseHolder,
  type Reclaimed,
  type ResourceSettings,
} from "@brainervirus/workit-core/src/core/resources";
import { startHeartbeat } from "@brainervirus/workit-core/src/core/heavy-lease";

const USAGE =
  'workit check <name> [--full] [--wait <dur> | --no-wait] [--no-lease --reason "<why>"] | workit check [--name <n>] [--shell] [--heavy] [--full] [--wait <dur> | --no-wait] [--timeout <s>] [--task <id>] [--json] -- <cmd…>';
/**
 * Output lines a check prints by default: enough for a compiler error or a
 * failing test with its stack, far below a build log (#426). --full streams all.
 */
export const OUTPUT_LINES = 60;
/** Lease age bound for a check without --timeout, where the holder cannot be identified. */
const MAX_UNVERIFIED_RUN_MS = 6 * 3_600_000;
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
  const { TaskStore, WorkitCore } = await import("@brainervirus/workit-core/src/core");
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
  const dir =
    env.WORKFLOW_TOOLKIT_CONFIG ??
    env.WORKFLOW_TOOLKIT_CONFIG_DIR ??
    path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config"), "workit");
  try {
    const { resolveWorkspaceFrom } = await import("@brainervirus/workit-core/src/core/workspaces");
    const workspace = resolveWorkspaceFrom(
      io.cwd,
      dir,
      env.WORKFLOW_WORKSPACE_NAME?.trim() || undefined,
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
): Promise<HeavyRun | number> {
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
  const acquired = await acquireLease({
    dir,
    slots: settings.slots,
    check: label,
    cwd: runCwd,
    session,
    waitMs: settings.waitMs,
    pollMs: 1000,
    // Where the holder cannot be identified (no /proc), its lease ends with
    // the check's timeout, else after MAX_UNVERIFIED_RUN_MS.
    maxAgeMs: (timeoutMs || MAX_UNVERIFIED_RUN_MS) + 60_000,
    maxHoldMs: settings.maxHoldMs,
    onStatus: (status) => {
      const slots = `${settings.slots} slot${settings.slots === 1 ? "" : "s"}`;
      const holders = status.holders.map((holder) => describeHolder(holder)).join("; ");
      if (progress.mode === "spinner") {
        const text = `Waiting for the heavy-check lease: held by ${holders || "nobody; waiters ahead"}, queue position ${status.position}`;
        if (waiting) waiting.label(text);
        else waiting = progress.start(text);
        return;
      }
      io.stderr(
        status.first
          ? `workit: waiting for the heavy-check lease (${slots}): held by ${holders || "nobody; waiters ahead"}; queued at position ${status.position}, waiting up to ${formatWait(settings.waitMs)} (--wait <dur> sets it)\n`
          : `workit: still queued for the heavy-check lease: position ${status.position}, ${formatWait(status.waitedMs)} of ${formatWait(settings.waitMs)} waited; held by ${holders || "nobody; waiters ahead"}\n`,
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
    emit(
      io,
      fail(
        "busy",
        settings.waitMs === 0
          ? `the heavy-check lease is busy (--no-wait): ${behind}`
          : `the heavy-check lease stayed busy for ${waited} (position ${acquired.position} in the queue): ${behind}`,
        {
          data: {
            lease: {
              waitedMs: acquired.waitedMs,
              holders: acquired.holders,
              position: acquired.position,
              queuedBehind: behind,
            },
          },
          unblock: stuck
            ? `workit lock reap (a holder looks stuck), then run it again`
            : `wait for ${holders || "the waiters ahead"} to finish (each holder's age is shown; a full test suite takes minutes), then run it again, or queue longer with --wait 30m`,
        },
      ),
    );
    return 4;
  }
  let lease: HeldLease | null = null;
  if (acquired.ok) lease = acquired.lease;
  // Fail open: an unwritable state dir must not stop the check.
  else io.stderr(`workit: running without the heavy-check lease: ${acquired.error}\n`);
  for (const stale of lease?.reclaimed ?? []) {
    io.stderr(
      `workit: reclaimed a ${stale.reaped ? "stuck" : "stale"} heavy-check lease (${stale.reason}): ${describeHolder(stale)}\n`,
    );
    if (stale.reaped) recordReaped(io, stale, "auto");
  }
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

export async function run(argv: string[], io: Io): Promise<number> {
  const options = parse(argv);
  if (options instanceof Error)
    return emit(io, fail("invalid_input", options.message, { unblock: USAGE }));
  const config: CheckConfig = loadCheckConfig(io.cwd);
  if (config.note) io.stderr(`note: ${config.note}\n`);
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
  const actor = actorFromEnv(io.env);
  const branchKey: CodeKey = codeKey(io.cwd, { base: options.base });
  // codeKey keys the tree only on a checked-out branch; a detached HEAD is
  // still a worktree whose state the run observed.
  const detached = branchKey.tree === null ? worktreeTree(io.cwd) : null;
  const key: CodeKey = detached
    ? { ...branchKey, tree: detached.key, dirty: detached.dirty }
    : branchKey;
  const signal = key.tree === null ? null : worktreeSignal(io.cwd);

  // Heavy checks queue for the machine lease and run in their own scope.
  let heavy: HeavyRun | null = null;
  if (!options.noLease && (options.heavy || options.command === null)) {
    const workspace = await workspaceResources(io);
    const { settings, warnings } = resolveResourceSettings([
      { label: "workspaces.json", trust: "machine", value: workspace.value },
      { label: CHECKS_FILE, trust: "repo", value: config.resources },
    ]);
    if (options.waitMs !== null) settings.waitMs = options.waitMs;
    for (const warning of [workspace.warning, ...warnings])
      if (warning) io.stderr(`workit: resources: ${warning}\n`);
    if (options.heavy || (name !== null && settings.heavy.includes(name))) {
      const prepared = await prepareHeavy(
        io,
        settings,
        name ?? command.join(" "),
        runCwd,
        options.timeoutMs,
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
  try {
    const scoped = await runScoped(
      (wrapper, sinks) =>
        runCheckCommand(command, {
          cwd: runCwd,
          shell: options.shell,
          timeoutMs: options.timeoutMs,
          env: heavy?.env ?? io.env,
          ...sinks,
          ...(wrapper ? { wrapper } : {}),
          // The check's group keeps the lease held if workit itself is killed.
          ...(lease ? { onSpawn: (pid: number) => updateLease(lease, { pgid: pid }) } : {}),
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
    heartbeat?.stop();
    lease?.release();
  }
  // Fail safe: a command that changed the worktree leaves stale evidence.
  const treeAfter = key.tree === null ? null : (worktreeTree(io.cwd)?.key ?? null);
  const modifiedWorktree = key.tree !== null && treeAfter !== key.tree;
  const store = storeRoot(io.cwd);
  const blob = store.ok ? storeLog(store.value.root, result.log) : null;
  const logPath = store.ok && blob ? path.join(store.value.root, blob.ref) : null;
  const tail = tailLines(result.log, TAIL_LINES);
  const passed = result.exitCode === 0 && !result.timedOut;
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
  const storeDir = io.env.WORKFLOW_WORKSPACE_ROOT || top;
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
      ? `timed out after ${options.timeoutMs} ms`
      : result.spawnError
        ? `cannot start ${command[0]}: ${result.spawnError}`
        : `exited ${result.exitCode}`
    : recordError?.message;
  const label = name ?? command.join(" ");
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
  if (!passed) return result.timedOut ? 4 : result.exitCode || 1;
  if (recordError)
    return recordError.code === "busy" ? 4 : recordError.code === "invalid_input" ? 2 : 5;
  return 0;
}
