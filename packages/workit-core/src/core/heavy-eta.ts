// Wait estimates for the heavy-check lease (#326): how long until a waiter
// gets a slot, from each check's last measured duration in the ledger of the
// repo it runs in. Only the CLI imports this module; hooks never do.
import fs from "node:fs";
import { ledgerPath } from "../ledger";
import { DEFAULT_MAX_HOLD_MS, formatWait, type LeaseHolder } from "./resources";

/** The last measured run of a holder's or waiter's check, in ms, or null when there is none. */
export type DurationOf = (holder: Pick<LeaseHolder, "check" | "cwd">) => number | null;

/**
 * How much of the ledger's end measuredDurations reads: the last runs are what
 * an estimate wants, and a long-lived ledger must not be read whole on every
 * waiter's status line.
 */
export const ETA_TAIL_BYTES = 512 * 1024;

/** The complete lines in the last `bytes` of `file` (a cut first line is dropped). */
function tailRows(file: string, bytes: number): string[] {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const span = Math.min(size, Math.max(1, bytes));
    const buffer = Buffer.alloc(span);
    fs.readSync(fd, buffer, 0, span, size - span);
    const lines = buffer.toString("utf8").split("\n");
    if (span < size) lines.shift();
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Each check's last measured duration per label (the check's name, or its
 * argv for an ad-hoc run), from the last `tailBytes` of the ledger at `cwd`.
 * A passed run wins over a later failed one, which may have stopped early; a
 * timed-out run never counts.
 */
export function measuredDurations(cwd: string, tailBytes = ETA_TAIL_BYTES): Map<string, number> {
  const passed = new Map<string, number>();
  const any = new Map<string, number>();
  const file = ledgerPath(cwd);
  if (!file.ok) return passed;
  for (const line of tailRows(file.value, tailBytes)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!row || typeof row !== "object" || row.type !== "check" || row.timedOut === true) continue;
    const ms = row.durationMs;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) continue;
    const label =
      typeof row.name === "string"
        ? row.name
        : Array.isArray(row.argv)
          ? row.argv.map(String).join(" ")
          : null;
    if (!label) continue;
    any.set(label, ms);
    if (row.result === "passed") passed.set(label, ms);
  }
  for (const [label, ms] of any) if (!passed.has(label)) passed.set(label, ms);
  return passed;
}

/** A holder may run this many times its last measured run before it looks stuck. */
export const HOLD_MARGIN = 1.5;

/**
 * How long a check may hold its slot before it is shown `stuck?`: HOLD_MARGIN
 * times its last measured run, never below the configured limit (default
 * DEFAULT_MAX_HOLD_MS), which alone applies when it was never measured. The
 * lease carries it, so auto-reap's factor applies to it too.
 */
export function holdLimit(measuredMs: number | null, configuredMs = DEFAULT_MAX_HOLD_MS): number {
  if (measuredMs === null || !Number.isFinite(measuredMs) || measuredMs <= 0) return configuredMs;
  return Math.max(configuredMs, Math.round(measuredMs * HOLD_MARGIN));
}

/** A DurationOf that reads each repo's ledger once. */
export function ledgerDurations(read: (cwd: string) => Map<string, number> = measuredDurations) {
  const byRepo = new Map<string, Map<string, number>>();
  const durationOf: DurationOf = ({ check, cwd }) => {
    let known = byRepo.get(cwd);
    if (!known) {
      try {
        known = read(cwd);
      } catch {
        known = new Map();
      }
      byRepo.set(cwd, known);
    }
    return known.get(check) ?? null;
  };
  return durationOf;
}

export type WaitEstimate =
  | { ms: number }
  /** Checks with no measured run, so no estimate. */
  | { ms: null; unmeasured: string[] };

/**
 * When a waiter behind `ahead` (in serving order) gets one of `slots`: each
 * holder frees its slot when its last measured run would end (at once when it
 * is already past that), and each waiter ahead takes the slot that frees
 * first for its own measured run.
 */
export function estimateWait(input: {
  slots: number;
  holders: LeaseHolder[];
  ahead: LeaseHolder[];
  durationOf: DurationOf;
  now?: number;
}): WaitEstimate {
  const now = input.now ?? Date.now();
  const unmeasured = new Set<string>();
  const measure = (holder: LeaseHolder): number => {
    const ms = input.durationOf(holder);
    if (ms === null) unmeasured.add(holder.check);
    return ms ?? 0;
  };
  const free = input.holders.map((holder) =>
    Math.max(0, measure(holder) - (now - Date.parse(holder.startedAt))),
  );
  while (free.length < Math.max(1, input.slots)) free.push(0);
  for (const waiter of input.ahead) {
    free.sort((a, b) => a - b);
    free[0] += measure(waiter);
  }
  if (unmeasured.size) return { ms: null, unmeasured: [...unmeasured] };
  return { ms: Math.min(...free) };
}

/** "estimated wait ~9m (last measured runs)" or "no wait estimate yet (no measured run of test)". */
export function describeEstimate(estimate: WaitEstimate): string {
  if (estimate.ms === null)
    return `no wait estimate yet (no measured run of ${estimate.unmeasured.join(", ")})`;
  return estimate.ms === 0
    ? "estimated wait: any moment (the holders are past their last measured runs)"
    : `estimated wait ~${formatWait(estimate.ms)} (last measured runs)`;
}

/** "~3m left", "past its last 14m run", or null when the check was never measured. */
export function remainingNote(
  holder: LeaseHolder,
  durationOf: DurationOf,
  now = Date.now(),
): string | null {
  const ms = durationOf(holder);
  if (ms === null) return null;
  const left = ms - (now - Date.parse(holder.startedAt));
  return left > 0 ? `~${formatWait(left)} left` : `past its last ${formatWait(ms)} run`;
}
