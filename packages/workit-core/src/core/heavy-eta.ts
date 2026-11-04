// Wait estimates for the heavy-check lease (#326): how long until a waiter
// gets a slot, from each check's last measured duration in the ledger of the
// repo it runs in. Only the CLI imports this module; hooks never do.
import { readLedger } from "../ledger";
import { formatWait, type LeaseHolder } from "./resources";

/** The last measured run of a holder's or waiter's check, in ms, or null when there is none. */
export type DurationOf = (holder: Pick<LeaseHolder, "check" | "cwd">) => number | null;

/**
 * Each check's last measured duration per label (the check's name, or its
 * argv for an ad-hoc run), from the ledger at `cwd`. A passed run wins over
 * a later failed one, which may have stopped early; a timed-out run never counts.
 */
export function measuredDurations(cwd: string): Map<string, number> {
  const passed = new Map<string, number>();
  const any = new Map<string, number>();
  const read = readLedger(cwd);
  if (!read.ok) return passed;
  for (const row of read.value.rows) {
    if (row.type !== "check" || row.timedOut === true) continue;
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
