// Standing-order deltas for running workers (#320, decision mvi7psa4). A
// worker's brief carries the orders in force when it was rendered; an order
// the lead adds or clears later reaches the worker on its next hooked tool
// call, once per revision (standing-signal.ts). A worker of a fanout is a
// subagent or child of one of its leads, a session id handed out under one
// (`<lead>:<x>`, `<lead>-w-<slice>`), or any session on one of its slice
// branches; the lead itself is never one.
import fs from "node:fs";
import path from "node:path";
import { currentBranch } from "../git/rev";
import { activeStanding, readLedger, type ReadRow } from "../ledger";
import {
  gitStoreDir,
  readStandingRev,
  readStandingSeen,
  standingSeenFile,
  writeStandingSeen,
} from "./standing-signal";
import type { HookInput } from "./protocol";

type Plan = { name: string; leads: string[]; branches: string[] };

const readPlans = (store: string): Plan[] => {
  const dir = path.join(store, "fanouts");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const plans: Plan[] = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Record<
        string,
        unknown
      >;
      if (typeof raw.name !== "string" || !Array.isArray(raw.slices)) continue;
      const texts = (value: unknown): string[] =>
        Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string" && item !== "")
          : [];
      plans.push({
        name: raw.name,
        leads: texts([raw.leadSession, ...texts(raw.formerLeads)]),
        branches: texts(
          raw.slices.map((slice) =>
            slice && typeof slice === "object" ? (slice as { branch?: unknown }).branch : null,
          ),
        ),
      });
    } catch {
      // An unreadable plan has no workers to tell.
    }
  }
  return plans;
};

/** The lead a subagent or child reports to, when the host names it. */
const leadOf = (input: HookInput): string | null =>
  input.session.parentId ??
  (input.session.agentId ? input.session.id : null) ??
  (input.session.id.includes(":") ? input.session.id.split(":")[0] : null);

const worksFor = (plan: Plan, input: HookInput, branch: () => string | null): boolean => {
  const session = input.session.id;
  if (plan.leads.includes(session) && !input.session.agentId) return false;
  const lead = leadOf(input);
  if (lead && plan.leads.includes(lead)) return true;
  if (plan.leads.some((each) => session.startsWith(`${each}-w-`))) return true;
  const current = branch();
  return current !== null && plan.branches.includes(current);
};

type Standing = { rev: string; orders: Map<string, ReadRow>; rows: readonly ReadRow[] };

/** Orders in force now for every fanout this agent works for, keyed by row id. */
const standingFor = (input: HookInput, store: string, rev: string): Standing => {
  const orders = new Map<string, ReadRow>();
  const ledger = readLedger(input.cwd);
  const rows = ledger.ok ? ledger.value.rows : [];
  let branch: string | null | undefined;
  const lazyBranch = () => (branch === undefined ? (branch = currentBranch(input.cwd)) : branch);
  for (const plan of readPlans(store))
    if (worksFor(plan, input, lazyBranch))
      for (const row of activeStanding(rows, plan.name, plan.leads.length ? plan.leads : null))
        orders.set(row.id, row);
  return { rev, orders, rows };
};

/** The same store path the launchers' fast paths compute, so they read the same seen file. */
const located = (input: HookInput) => {
  const store = input.session.id ? gitStoreDir(input.cwd) : null;
  const rev = store ? readStandingRev(store) : null;
  if (!store || rev === null) return null;
  return { store, rev, file: standingSeenFile(store, input.session.id, input.session.agentId) };
};

/**
 * A new subagent's brief already carries the orders in force: its baseline,
 * so only later changes reach it.
 */
export const seedStanding = (input: HookInput): void => {
  try {
    const where = located(input);
    if (!where) return;
    const now = standingFor(input, where.store, where.rev);
    writeStandingSeen(where.file, { rev: where.rev, ids: [...now.orders.keys()] });
  } catch {
    // Without a baseline the first delta recaps every order in force.
  }
};

const fanoutOf = (row: ReadRow): string => (typeof row.fanout === "string" ? row.fanout : "?");

/** The orders added and dropped since `ids`, as one model-visible block, or null. */
const changedSince = (now: Standing, ids: readonly string[]): string | null => {
  const known = new Set(ids);
  const added = [...now.orders.values()].filter((row) => !known.has(row.id));
  const byId = new Map(now.rows.map((row) => [row.id, row]));
  const dropped = ids
    .filter((id) => !now.orders.has(id))
    .map((id) => byId.get(id))
    .filter((row): row is ReadRow => row !== undefined);
  if (!added.length && !dropped.length) return null;
  const fanouts = [...new Set([...added, ...dropped].map(fanoutOf))].join(", ");
  const lines = [
    `Workit: the lead changed the standing orders for fanout ${fanouts} while you run. They apply to you now and override your brief's STANDING list.`,
    ...added.map((row) => `  - new: ${String(row.what)}`),
    ...dropped.map(
      (row) =>
        `  - no longer in force: ${String(row.what)}${row.stop ? " (the stop is lifted: continue your brief)" : ""}`,
    ),
  ];
  if (added.some((row) => row.stop === true))
    lines.push(
      "Stop now: make no further changes, close what you opened, and report to the lead with your branch, head SHA, what is done and what is not.",
    );
  return lines.join("\n");
};

/**
 * What changed since this agent last saw the standing orders; null when
 * nothing did or it works for no fanout. An agent seen for the first time is
 * told every order in force. Marks the revision seen, so a host that keeps
 * each answer in the transcript gets the block once.
 */
export const standingDelta = (input: HookInput): string | null => {
  try {
    const where = located(input);
    if (!where) return null;
    const seen = readStandingSeen(where.file);
    if (seen.rev === where.rev) return null;
    const now = standingFor(input, where.store, where.rev);
    writeStandingSeen(where.file, { rev: where.rev, ids: [...now.orders.keys()] });
    return changedSince(now, seen.ids);
  } catch {
    return null;
  }
};

const sinceStart = new Map<string, { rev: string; text: string | null }>();

/**
 * For a host that rebuilds its context on every model call (OpenCode): the
 * changes since this agent's first call, on every call while they stand.
 * The first call records the baseline (its brief carries those orders); the
 * ledger is read again only when the revision moves.
 */
export const standingSinceStart = (input: HookInput): string | null => {
  try {
    const store = input.session.id ? gitStoreDir(input.cwd) : null;
    if (!store) return null;
    const rev = readStandingRev(store) ?? "";
    const file = standingSeenFile(store, input.session.id, input.session.agentId);
    const cached = sinceStart.get(file);
    if (cached?.rev === rev) return cached.text;
    let text: string | null = null;
    if (rev) {
      const now = standingFor(input, store, rev);
      const seen = readStandingSeen(file);
      let ids = seen.ids;
      if (seen.rev === null) {
        // Seen before any order existed: every order is new to it.
        ids = cached ? [] : [...now.orders.keys()];
        writeStandingSeen(file, { rev, ids });
      }
      text = changedSince(now, ids);
    }
    sinceStart.set(file, { rev, text });
    if (sinceStart.size > 256) sinceStart.delete(sinceStart.keys().next().value!);
    return text;
  } catch {
    return null;
  }
};
