// `workit lock` (issue #325): the machine-wide heavy-check lease under its
// own name. `status` shows who holds it and who is queued (#508), with each
// holder's time left and each waiter's estimated wait from the ledger's last
// measured runs (#326), first dropping what no longer holds or waits and
// marking stuck holders (#608);
// `reap` frees a stuck holder's slot, `cancel` drops queued waiters, `wait`
// waits for a free slot without taking it, `run` is `workit check --heavy`,
// and `heavy` lists, tests and extends which commands the shell hook gates
// (core/heavy.ts).
//
//   workit lock status
//   workit lock reap [<pid|session|dir>]
//   workit lock cancel [<pid|session|dir>]   # default: this session's waiters
//   workit lock wait [--timeout <dur>]
//   workit lock run [--shell] [--wait <dur> | --no-wait] [--timeout <s>] -- <cmd…>
//   workit lock heavy list | add <pattern> | remove <pattern> | test <cmd…>
import fs from "node:fs";
import path from "node:path";
import { CHECKS_FILE, lightCommand, loadCheckConfig } from "@workit-dev/core/src/check-config";
import { simpleCommand } from "@workit-dev/core/src/hooks/raw-git";
import {
  heavyCommand,
  heavyCommandsFile,
  heavyPlan,
  machinePatterns,
  parsePattern,
  repoPatterns,
} from "@workit-dev/core/src/core/heavy";
import {
  DEFAULT_MAX_HOLD_MS,
  describeHolder,
  fairOrder,
  formatWait,
  leaseDir,
  leaseQueue,
  leaseSlots,
  leaseWake,
  liveHolders,
  parseWait,
  readGrants,
  resolveResourceSettings,
  SILENT_MS,
  admittedHolders,
  formatBytes,
  type AdmittedEntry,
  type Budget,
  type QueueEntry,
  type SlotState,
} from "@workit-dev/core/src/core/resources";
import {
  cancelWaiters,
  parseTarget,
  pruneLease,
  reapStuck,
} from "@workit-dev/core/src/core/heavy-lease";
import {
  describeEstimate,
  estimateWait,
  ledgerDurations,
  remainingNote,
  type DurationOf,
} from "@workit-dev/core/src/core/heavy-eta";
import { hostSessionFromEnv } from "@workit-dev/core/src/host-session";
import { emit, fail, ok, type Io } from "../output";
import { recordReaped, workspaceResources } from "./check";

const USAGE =
  "workit lock status | reap [<pid|session|dir>] | cancel [<pid|session|dir>] | wait [--timeout <dur>] | run [--shell] [--wait <dur> | --no-wait] [--timeout <s>] -- <cmd…> | heavy list|add|remove|test";

async function settingsFor(io: Io) {
  const workspace = await workspaceResources(io);
  const config = loadCheckConfig(io.cwd);
  const resolved = resolveResourceSettings([
    { label: "workspaces.json", trust: "machine", value: workspace.value },
    { label: CHECKS_FILE, trust: "repo", value: config.resources },
  ]);
  return Object.assign(resolved.settings, { budget: resolved.budget });
}

/** Past this many slots, `lock status` lists only the held ones (a memory budget allows up to 64 holders). */
const LIST_FREE_UP_TO = 8;

/** "budget: 2 of 3 units, 9.6 GiB of 26.0 GiB memory (6.0 GiB reserve, automatic)". */
function budgetLine(budget: Budget, slots: SlotState[], admitted: AdmittedEntry[]): string {
  const live = held(slots).length;
  const units = slots
    .filter((slot) => slot.holder && !slot.stale)
    .reduce((sum, slot) => sum + (slot.units ?? 1), 0);
  const bytes =
    slots.reduce((sum, slot) => sum + (slot.holder && !slot.stale ? (slot.bytes ?? 0) : 0), 0) +
    admitted.reduce((sum, entry) => sum + (entry.stale ? 0 : (entry.record.bytes ?? 0)), 0);
  const memory = `${formatBytes(bytes)} of ${formatBytes(budget.memoryBytes)} memory (${formatBytes(budget.reserveBytes)} reserve, ${budget.reserveSource})`;
  if (budget.mode === "slots")
    return `budget: resources.slots counts checks (${live} of ${budget.units}); admitted holders take no slot, only ${memory}`;
  return budget.mode === "memory"
    ? `budget: ${memory}`
    : `budget: ${units} of ${budget.units} unit${budget.units === 1 ? "" : "s"}, ${memory}`;
}

const held = (slots: SlotState[]) => slots.filter((slot) => slot.holder && !slot.stale);

/** The live waiters in serving order (round-robin per session). */
const servingOrder = (dir: string, slots: SlotState[], queue: QueueEntry[]): QueueEntry[] =>
  fairOrder(
    queue.filter((entry) => !entry.stale),
    held(slots).flatMap((slot) => (slot.holder ? [slot.holder] : [])),
    readGrants(dir),
  );

type Estimates = {
  /** Each live holder's time left from its check's last measured run (null: never measured). */
  slots: Array<{ slot: number; remainingMs: number | null; note: string | null }>;
  /** Each waiter's estimated wait, in serving order. */
  queue: Array<{ position: number; waitMs: number | null; unmeasured: string[]; note: string }>;
};

/** Time left per holder and the estimated wait per waiter (#326). */
function estimates(
  slots: SlotState[],
  waiting: QueueEntry[],
  count: number,
  durationOf: DurationOf,
  now = Date.now(),
): Estimates {
  const holders = held(slots).flatMap((slot) => (slot.holder ? [slot.holder] : []));
  return {
    slots: held(slots).flatMap((slot) => {
      if (!slot.holder) return [];
      const ms = durationOf(slot.holder);
      return [
        {
          slot: slot.slot,
          remainingMs:
            ms === null ? null : Math.max(0, ms - (now - Date.parse(slot.holder.startedAt))),
          note: remainingNote(slot.holder, durationOf, now),
        },
      ];
    }),
    queue: waiting.map((_, index) => {
      const estimate = estimateWait({
        slots: count,
        holders,
        ahead: waiting.slice(0, index).map((entry) => entry.holder),
        durationOf,
        now,
      });
      return {
        position: index + 1,
        waitMs: estimate.ms,
        unmeasured: estimate.ms === null ? estimate.unmeasured : [],
        note: describeEstimate(estimate),
      };
    }),
  };
}

function slotLines(slots: SlotState[], waiting: QueueEntry[], eta: Estimates): string[] {
  const busy = held(slots).length;
  const stuck = slots.some((slot) => slot.stuck);
  const left = (slot: number) => eta.slots.find((item) => item.slot === slot)?.note;
  const listed = slots.length > LIST_FREE_UP_TO ? slots.filter((slot) => slot.holder) : slots;
  return [
    `heavy-check lease: ${busy} of ${slots.length} slot${slots.length === 1 ? "" : "s"} held`,
    ...listed.map((slot) =>
      slot.holder
        ? `  slot ${slot.slot}: ${describeHolder(slot.holder)}${slot.stale ? ` (stale: ${slot.stale}; the next heavy check reclaims it)` : left(slot.slot) ? `; ${left(slot.slot)}` : ""}`
        : `  slot ${slot.slot}: free`,
    ),
    ...(stuck ? ["  a stuck? holder's slot is freed by: workit lock reap [<pid>]"] : []),
    `queue: ${waiting.length ? `${waiting.length} waiting, round-robin per session` : "empty"}`,
    ...waiting.map(
      (entry, index) => `  ${index + 1}. ${describeHolder(entry.holder)}; ${eta.queue[index].note}`,
    ),
  ];
}

async function status(io: Io): Promise<number> {
  const settings = await settingsFor(io);
  const maxHold = settings.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  const dir = leaseDir(io.env);
  const pruned = pruneLease(dir, settings.slots);
  const slots = leaseSlots(dir, settings.slots, {}, maxHold);
  const waiting = servingOrder(dir, slots, leaseQueue(dir));
  const eta = estimates(slots, waiting, settings.slots, ledgerDurations());
  const admitted = admittedHolders(dir);
  const budget = settings.budget;
  return emit(
    io,
    ok({
      dir,
      slots,
      budget: {
        mode: budget.mode,
        units: budget.units,
        memoryBytes: budget.memoryBytes,
        reserveBytes: budget.reserveBytes,
        reserve: budget.reserveSource,
      },
      admitted: admitted.map((entry) => ({
        ...describeAdmitted(entry),
        stale: entry.stale,
      })),
      queue: waiting.map((entry) => entry.holder),
      estimates: eta,
      pruned,
      waitMs: settings.waitMs,
      maxHoldMs: maxHold,
      light: settings.light,
    }),
    () => [
      ...pruned.map(
        (item) =>
          `workit: dropped ${item.kind === "slot" ? "a dead holder's slot" : item.kind === "admitted" ? "a dead admitted holder" : "a queued waiter"} (${item.reason}): ${describeHolder(item)}`,
      ),
      ...slotLines(slots, waiting, eta),
      budgetLine(budget, slots, admitted),
      `admitted (no slot): ${admitted.length ? admitted.length : "none"}`,
      ...admitted.map(
        (entry) =>
          `  ${describeHolder(describeAdmitted(entry))}${entry.stale ? ` (stale: ${entry.stale}; the next read drops it)` : ""}`,
      ),
    ],
  );
}

const describeAdmitted = (entry: AdmittedEntry) => ({
  pid: entry.record.pid,
  check: entry.record.check,
  cwd: entry.record.cwd,
  session: entry.record.session,
  startedAt: entry.record.startedAt,
  kind: entry.record.kind ?? "admitted",
  ref: entry.record.ref ?? null,
  bytes: entry.record.bytes ?? 0,
});

const targetArg = (args: string[]): string | undefined => args.find((arg) => arg !== "--json");

async function reap(args: string[], io: Io): Promise<number> {
  const settings = await settingsFor(io);
  const maxHold = settings.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  const dir = leaseDir(io.env);
  const raw = targetArg(args);
  const pruned = pruneLease(dir, settings.slots);
  const reaped = reapStuck(dir, settings.slots, maxHold, {
    target: raw ? parseTarget(raw, io.cwd) : null,
  });
  const recorded = reaped.map((item) => {
    const row = recordReaped(io, item, "lock reap");
    return { ...item, ledgerRowId: row.ok ? String(row.value.id) : null };
  });
  return emit(io, ok({ dir, reaped: recorded, pruned }), () =>
    recorded.length || pruned.length
      ? [
          ...pruned.map(
            (item) =>
              `workit: dropped ${item.kind === "slot" ? "a dead holder's slot" : "a queued waiter"} (${item.reason}): ${describeHolder(item)}`,
          ),
          ...recorded.map(
            (item) =>
              `workit: reaped slot ${item.slot} (${item.reason}): ${describeHolder({ ...item, stuck: null })}; pid ${item.pid} still runs outside the lease${item.ledgerRowId ? `; ledger ${item.ledgerRowId}` : ""}`,
          ),
        ]
      : [
          `workit: no stuck holder${raw ? ` matching ${raw}` : ""} (a holder is stuck past ${formatWait(maxHold)} held, or ${formatWait(SILENT_MS)} without output or CPU)`,
        ],
  );
}

async function cancel(args: string[], io: Io): Promise<number> {
  const raw = targetArg(args) ?? hostSessionFromEnv(io.env).session ?? undefined;
  if (!raw)
    return emit(
      io,
      fail("invalid_input", "cancel needs a pid, session or directory outside a session", {
        unblock: "workit lock cancel <pid|session|dir>",
      }),
    );
  const dir = leaseDir(io.env);
  const cancelled = cancelWaiters(dir, parseTarget(raw, io.cwd), `workit lock cancel ${raw}`);
  return emit(io, ok({ dir, target: raw, cancelled }), () =>
    cancelled.length
      ? cancelled.map(
          (item) =>
            `workit: cancelled a queued ${describeHolder(item)}${item.how === "signal" ? " (an older workit: sent SIGTERM)" : item.how === "gone" ? " (already gone)" : ""}`,
        )
      : [`workit: no queued waiter matches ${raw}`],
  );
}

function timeoutOf(args: string[]): number | null | Error {
  const at = args.findIndex((arg) => arg === "--timeout" || arg.startsWith("--timeout="));
  if (at < 0) return null;
  const raw = args[at].includes("=") ? args[at].split("=")[1] : args[at + 1];
  return (
    parseWait(raw ?? "") ??
    new Error('--timeout must be seconds or a duration ("90", "90s", "30m", "1h")')
  );
}

/**
 * Wait for a free slot without taking one, woken when a slot frees (as a
 * queued heavy check is). Like a heavy check's wait, `resources.wait` is
 * waited once more at its limit, with an estimate; `--timeout` is one hard
 * bound.
 */
async function wait(args: string[], io: Io): Promise<number> {
  const timeout = timeoutOf(args);
  if (timeout instanceof Error) return emit(io, fail("invalid_input", timeout.message));
  const settings = await settingsFor(io);
  const maxHold = settings.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  let limit = timeout ?? settings.waitMs;
  let requeuedAfterMs: number | null = null;
  const dir = leaseDir(io.env);
  const durationOf = ledgerDurations();
  const wake = leaseWake(dir);
  const started = Date.now();
  let told = false;
  try {
    for (;;) {
      const holders = [...liveHolders(dir, settings.slots, {}, maxHold).values()];
      const waitedMs = Date.now() - started;
      const again =
        requeuedAfterMs === null ? "" : ` (re-queued once after ${formatWait(requeuedAfterMs)})`;
      if (holders.length < settings.slots)
        return emit(
          io,
          ok({
            free: true,
            waitedMs,
            requeuedAfterMs,
            slots: leaseSlots(dir, settings.slots, {}, maxHold),
          }),
          () => [
            `workit: the heavy-check lease has a free slot${waitedMs ? ` after ${formatWait(waitedMs)}${again}` : ""}`,
          ],
        );
      const heldBy = holders.map((holder) => describeHolder(holder)).join("; ");
      const estimate = describeEstimate(
        estimateWait({ slots: settings.slots, holders, ahead: [], durationOf }),
      );
      if (waitedMs >= limit) {
        if (timeout === null && requeuedAfterMs === null && settings.waitMs > 0) {
          requeuedAfterMs = waitedMs;
          limit = waitedMs + settings.waitMs;
          io.stderr(
            `workit: waited ${formatWait(waitedMs)} for a free heavy-check lease slot: re-queued once for up to ${formatWait(settings.waitMs)} more; ${estimate}; held by ${heldBy}\n`,
          );
        } else
          return emit(
            io,
            fail(
              "busy",
              timeout === null
                ? `the heavy-check lease stayed busy for ${formatWait(waitedMs)}${again}; ${estimate}; held by ${heldBy}`
                : `the heavy-check lease stayed busy for ${formatWait(waitedMs)}, the whole --timeout; ${estimate}; held by ${heldBy}`,
              {
                data: {
                  free: false,
                  waitedMs,
                  requeuedAfterMs,
                  slots: leaseSlots(dir, settings.slots, {}, maxHold),
                },
                unblock: "workit lock status",
              },
            ),
          );
      }
      if (!told) {
        told = true;
        io.stderr(
          `workit: waiting for a free heavy-check lease slot (${settings.slots}): held by ${heldBy}; up to ${formatWait(limit)}${timeout === null && settings.waitMs > 0 ? ", then once more" : ""}; ${estimate}\n`,
        );
      }
      await wake.pause(Math.min(1000, Math.max(1, limit - waitedMs)));
    }
  } finally {
    wake.close();
  }
}

async function runHeavy(args: string[], io: Io): Promise<number> {
  const split = args.indexOf("--");
  const head = split < 0 ? args : args.slice(0, split);
  const unknown = head.find(
    (arg, index) =>
      arg !== "--shell" &&
      arg !== "--json" &&
      arg !== "--no-wait" &&
      !arg.startsWith("--timeout") &&
      !arg.startsWith("--wait") &&
      !((head[index - 1] === "--timeout" || head[index - 1] === "--wait") && !arg.startsWith("-")),
  );
  if (split < 0 || unknown)
    return emit(
      io,
      fail("invalid_input", unknown ? `unexpected ${unknown}` : "no command after --", {
        unblock: "workit lock run [--shell] [--wait <dur> | --no-wait] [--timeout <s>] -- <cmd…>",
      }),
    );
  const check = await import("./check");
  // Passed to check, not a lock flag.
  return check.run([`--heavy`, ...head, ...args.slice(split)], io);
}

type PatternFile = { patterns: string[] } & Record<string, unknown>;

function readPatterns(file: string): PatternFile {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const patterns = Array.isArray(record.patterns)
        ? record.patterns.filter((item): item is string => typeof item === "string")
        : [];
      return { ...record, patterns };
    }
  } catch {
    // Missing or unreadable: start empty.
  }
  return { patterns: [] };
}

function writePatterns(file: string, value: PatternFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

const commandText = (args: string[]): string => {
  const split = args.indexOf("--");
  return (split < 0 ? args : args.slice(split + 1)).join(" ").trim();
};

async function heavy(args: string[], io: Io): Promise<number> {
  const [action, ...rest] = args.filter((arg) => arg !== "--json");
  const file = heavyCommandsFile(io.env);
  if (action === "list")
    return emit(
      io,
      ok({ file, machine: machinePatterns(io.env), repo: repoPatterns(io.cwd) }),
      (data) => [
        "built in: test runners, builds and bundlers, lint and typecheck, installs, image builds, Sonar, browser tests (JS, Go, Rust, JVM, .NET, Python, Ruby, PHP, Elixir, Swift, C)",
        `machine (${data.file}): ${data.machine.length ? data.machine.join(", ") : "none"}`,
        `repo (checks config resources.heavyCommands): ${data.repo.length ? data.repo.join(", ") : "none"}`,
      ],
    );
  if (action === "add" || action === "remove") {
    const pattern = commandText(rest);
    if (!parsePattern(pattern))
      return emit(
        io,
        fail("invalid_input", `${action} needs a command pattern`, {
          unblock: `workit lock heavy ${action} '<command words>'`,
        }),
      );
    const current = readPatterns(file);
    const normalized = pattern.split(/\s+/u).join(" ");
    const has = current.patterns.includes(normalized);
    const patterns =
      action === "add"
        ? has
          ? current.patterns
          : [...current.patterns, normalized]
        : current.patterns.filter((item) => item !== normalized);
    try {
      if (patterns !== current.patterns) writePatterns(file, { ...current, patterns });
    } catch (error) {
      return emit(io, fail("unavailable", `cannot write ${file}: ${(error as Error).message}`));
    }
    const changed = action === "add" ? !has : has;
    return emit(io, ok({ file, pattern: normalized, changed, patterns }), () => [
      action === "add"
        ? `workit: ${changed ? "added" : "already had"} heavy pattern "${normalized}" (machine-wide, ${file})`
        : `workit: ${changed ? "removed" : "had no"} heavy pattern "${normalized}"`,
    ]);
  }
  if (action === "test") {
    const command = commandText(rest);
    if (!command)
      return emit(
        io,
        fail("invalid_input", "test needs a command", {
          unblock: "workit lock heavy test -- <cmd…>",
        }),
      );
    const single = simpleCommand(command, "posix", 0, true);
    const light = single ? lightCommand(single, io.cwd) : null;
    const match = light ? null : heavyCommand(command, { cwd: io.cwd, env: io.env });
    // Host permission rules are the hook's to read; this answers without them.
    const plan = light
      ? ({ kind: "none" } as const)
      : heavyPlan(command, { cwd: io.cwd, env: io.env, rules: null });
    return emit(
      io,
      ok({
        command,
        heavy: Boolean(match),
        reason: match?.reason ?? null,
        source: match?.source ?? null,
        light: light?.reason ?? null,
        rewrite: plan.kind === "rewrite" ? plan.command : null,
        split: plan.kind === "split" ? plan.reason : null,
      }),
      (data) =>
        data.light
          ? [
              `light (${data.light}): the shell hook leaves it alone, and workit check runs it without the lease even with --heavy`,
            ]
          : !data.heavy
            ? ["light: the shell hook leaves it alone"]
            : data.rewrite
              ? [`heavy (${data.reason}): the shell hook runs it as ${data.rewrite}`]
              : data.split
                ? [`heavy (${data.reason}): the shell hook denies the chain: ${data.split}`]
                : [`heavy (${data.reason}): outside a git checkout the shell hook leaves it alone`],
    );
  }
  return emit(
    io,
    fail("invalid_input", `unknown lock heavy action ${action ?? "(none)"}`, {
      unblock: "workit lock heavy list|add <pattern>|remove <pattern>|test -- <cmd…>",
    }),
  );
}

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "status") return status(io);
  if (sub === "reap") return reap(rest, io);
  if (sub === "cancel") return cancel(rest, io);
  if (sub === "wait") return wait(rest, io);
  if (sub === "run") return runHeavy(rest, io);
  if (sub === "heavy") return heavy(rest, io);
  return emit(
    io,
    fail("invalid_input", `unknown lock subcommand ${sub ?? "(none)"}`, { unblock: USAGE }),
  );
}
