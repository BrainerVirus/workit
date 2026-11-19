// The natural fan-out calls a lead guesses, accepted (decision D2/D4):
//
// - `workit fanout worktree create <slice> [--branch <type>/<slug>]` with no
//   plan holding the slice: one unplanned slice gets a one-slice plan named
//   after it, on the branch given or the first of feature/, feat/, fix/
//   <slice> that branch policy allows (`defaultSliceBranch`) (a short
//   brief whose task is the lead's spawn prompt), through `planFanout`, so
//   branch policy, the ledger row and `fanout status` all apply. A slice a
//   registered plan already holds is made from that plan instead.
// - `--name <x>` that names no registered plan: the plan files in
//   `workit dir plans` whose names start with x (`planFileMatches`), which
//   the CLI registers when exactly one matches.
import fs from "node:fs";
import path from "node:path";
import { validateBranchNameFor } from "./core/branch";
import { repoDir } from "./core/repo-paths";
import {
  fanoutFail,
  listFanouts,
  planFanout,
  readFanout,
  type FanoutFile,
  type FanoutResult,
} from "./fanout";
import type { LedgerActor } from "./ledger";

/** Does `--name <value>` name a plan file (`*.json`, or a path to a file) rather than a plan? */
export const isPlanPath = (cwd: string, value: string): boolean => {
  if (value.endsWith(".json")) return true;
  if (!value.includes("/") && !value.includes(path.sep)) return false;
  try {
    return fs.statSync(path.resolve(cwd, value)).isFile();
  } catch {
    return false;
  }
};

/** `<plans dir>/<name>*.json` (`workit dir plans`), sorted; none outside a store. */
export function planFileMatches(cwd: string, name: string): string[] {
  try {
    const dir = repoDir("plans", cwd);
    if (dir instanceof Error) return [];
    return fs
      .readdirSync(dir)
      .filter((entry) => entry.startsWith(name) && entry.endsWith(".json"))
      .toSorted()
      .map((entry) => path.join(dir, entry));
  } catch {
    return [];
  }
}

/** The branch an unplanned slice gets: the first of feature/, feat/, fix/ the branch policy allows, else its suggestion. */
export function defaultSliceBranch(cwd: string, slice: string): string {
  for (const kind of ["feature", "feat", "fix"])
    if (validateBranchNameFor(cwd, `${kind}/${slice}`).ok) return `${kind}/${slice}`;
  const check = validateBranchNameFor(cwd, `feature/${slice}`);
  return (!check.ok && /use "([^"]+)"/u.exec(check.correction)?.[1]) || `feature/${slice}`;
}

/** The registered plan that holds slice `id`, if any. */
export function planHolding(cwd: string, id: string): FanoutFile | null {
  const all = listFanouts(cwd);
  return all.ok
    ? (all.data.find((plan) => plan.slices.some((slice) => slice.id === id)) ?? null)
    : null;
}

/**
 * The plan for one unplanned slice on `branch`: the registered plan that
 * already holds the slice (same branch), else a one-slice plan named after
 * it. A plan named like the slice that holds other slices is never replaced.
 */
export function adhocPlan(
  cwd: string,
  input: {
    slice: string;
    /** Null: `defaultSliceBranch`. */
    branch: string | null;
    base: string | null;
    tier: string | null;
    actor: LedgerActor;
  },
): FanoutResult<FanoutFile> {
  const all = listFanouts(cwd);
  if (!all.ok) return all;
  const branch = input.branch ?? defaultSliceBranch(cwd, input.slice);
  for (const plan of all.data) {
    const planned = plan.slices.find((slice) => slice.id === input.slice);
    if (!planned) continue;
    if (input.branch === null || planned.branch === branch) return { ok: true, data: plan };
    return fanoutFail(
      "invalid_input",
      `slice ${input.slice} is planned in fanout ${plan.name} on ${planned.branch}, not ${branch}`,
      `workit fanout worktree create ${input.slice} --name ${plan.name}`,
    );
  }
  if (all.data.some((plan) => plan.name === input.slice))
    return fanoutFail(
      "invalid_input",
      `fanout plan ${input.slice} exists and does not hold slice ${input.slice}`,
      `name the slice another way: workit fanout worktree create ${input.slice}-1 --branch ${branch}`,
    );
  const planned = planFanout(cwd, {
    raw: {
      name: input.slice,
      slices: [
        {
          id: input.slice,
          branch,
          tier: input.tier ?? "standard",
          reason: "parallel",
          scope: ["**"],
          goal: "the task in the lead's spawn prompt (an unplanned slice: no plan file)",
          acceptance: ["the outcomes the lead's spawn prompt names"],
          verify: ["the checks the lead's spawn prompt names, else workit check test"],
          forbidden: ["changes outside this worktree; push, merge or rebase unless the lead asks"],
        },
      ],
    },
    name: input.slice,
    trunk: input.base,
    actor: input.actor,
  });
  if (!planned.ok) return planned;
  const read = readFanout(cwd, planned.data.name);
  if (!read.ok) return read;
  return read.data
    ? { ok: true, data: read.data }
    : fanoutFail("failed", `fanout plan ${planned.data.name} was not stored`);
}
