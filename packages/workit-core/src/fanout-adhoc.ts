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
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { validateBranchNameFor } from "./core/branch";
import { repoDir } from "./core/repo-paths";
import {
  branchRef,
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

/**
 * A `--name` plan file as given; one that does not exist there is the single
 * file of that name in `workit dir plans` or in the checkout (tracked or not,
 * ignored files aside), else the path as given (its read error names it).
 */
export function locatePlanFile(cwd: string, value: string): string {
  const given = path.resolve(cwd, value);
  if (fs.existsSync(given)) return given;
  const base = path.basename(value);
  const inPlans = planFileMatches(cwd, base.replace(/\.json$/u, "")).filter(
    (file) => path.basename(file) === base,
  );
  if (inPlans.length === 1) return inPlans[0];
  const listed = spawnSync(
    "git",
    ["ls-files", "--full-name", "--cached", "--others", "--exclude-standard", "--", `*${base}`],
    { cwd, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
  );
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  const hits = [
    ...new Set(listed.stdout?.split("\n").filter((line) => path.basename(line) === base)),
  ];
  return hits.length === 1 && top.status === 0 ? path.join(top.stdout.trim(), hits[0]) : given;
}

/**
 * The registered plan a plan file already is: the one named like the file
 * (its `name`, else its basename) or holding the same slice ids, so `--name
 * <file>` registers a plan once and keeps what `fanout plan` stored.
 */
export function registeredPlanFor(cwd: string, raw: unknown, file: string): FanoutFile | null {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const name = typeof record.name === "string" ? record.name : path.basename(file, ".json");
  const ids = (Array.isArray(record.slices) ? record.slices : [])
    .map((slice) => (slice as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === "string")
    .toSorted();
  const same = (plan: FanoutFile): boolean =>
    ids.length > 0 &&
    plan.slices
      .map((slice) => slice.id)
      .toSorted()
      .join("\n") === ids.join("\n");
  const all = listFanouts(cwd);
  if (!all.ok) return null;
  return all.data.find((plan) => plan.name === name) ?? all.data.find(same) ?? null;
}

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

/**
 * The branch an unplanned slice gets: the first of feature/, feat/, fix/
 * <slice> the branch policy allows (else its suggestion), with `-2`, `-3`…
 * while that branch already exists (the lead's own branch may be the name).
 */
export function defaultSliceBranch(cwd: string, slice: string): string {
  const check = validateBranchNameFor(cwd, `feature/${slice}`);
  const name =
    ["feature", "feat", "fix"]
      .map((kind) => `${kind}/${slice}`)
      .find((candidate) => validateBranchNameFor(cwd, candidate).ok) ??
    ((!check.ok && /use "([^"]+)"/u.exec(check.correction)?.[1]) || `feature/${slice}`);
  for (let n = 2; ; n += 1) {
    const candidate = n === 2 ? name : `${name}-${n - 1}`;
    if (!branchRef(cwd, candidate) || n > 50) return candidate;
  }
}

/** Every registered plan that holds slice `id`. */
export function plansHolding(cwd: string, id: string): FanoutFile[] {
  const all = listFanouts(cwd);
  return all.ok ? all.data.filter((plan) => plan.slices.some((slice) => slice.id === id)) : [];
}

/** The registered plan that holds slice `id`, if any. */
export const planHolding = (cwd: string, id: string): FanoutFile | null =>
  plansHolding(cwd, id)[0] ?? null;

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
          verify: [
            "the checks the lead's spawn prompt names, else those `workit check --list` prints (none configured: say so in the report)",
          ],
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
