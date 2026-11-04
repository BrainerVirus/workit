// Fanout slices with `dependsOn` are stacks (W2.37). A slice whose base is
// another slice's branch starts on that branch (`fanout worktree create`), and
// the chain from its bottom slice up to it is recorded as a `workit stack`
// named `<fanout>/<bottom slice>`. Once the parent lands (a squash merge
// included), `workit stack sync` rebases the child onto the trunk with
// `--onto <the parent tip it was built on>`, so the parent's commits drop out.
//
// A fork (two children of one parent) is a second stack, named after the
// child. `fanout status` lists the recorded stacks and the planned chains not
// recorded yet, bottom first.
import { branchRef, type FanoutFile, type Slice } from "./fanout";
import { listStacks, recordStack, type StackFile } from "./stack";

const parentOf = (plan: FanoutFile, slice: Slice): Slice | undefined =>
  slice.base === plan.trunk
    ? undefined
    : plan.slices.find((other) => other.id !== slice.id && other.branch === slice.base);

/** The slices from the bottom of `slice`'s chain up to it, through parent branches. */
export function stackPath(plan: FanoutFile, slice: Slice): Slice[] {
  const chain = [slice];
  const seen = new Set([slice.id]);
  for (let parent = parentOf(plan, slice); parent; parent = parentOf(plan, parent)) {
    if (seen.has(parent.id)) break;
    seen.add(parent.id);
    chain.unshift(parent);
  }
  return chain;
}

/** One chain per slice nobody stacks on, when it has a parent slice: bottom first. */
function plannedChains(plan: FanoutFile): Slice[][] {
  const parents = new Set(
    plan.slices.map((slice) => parentOf(plan, slice)?.id).filter((id) => id !== undefined),
  );
  return plan.slices
    .filter((slice) => !parents.has(slice.id))
    .map((slice) => stackPath(plan, slice))
    .filter((chain) => chain.length > 1);
}

/** The recorded stacks of this fanout (named `<fanout>/…`). */
function fanoutStacks(cwd: string, plan: FanoutFile): StackFile[] {
  const all = listStacks(cwd);
  return all.ok ? all.data.filter((stack) => stack.name.startsWith(`${plan.name}/`)) : [];
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export type SliceStack =
  | { ok: true; name: string; slices: string[] }
  | { ok: false; error: string; unblock: string };

/**
 * Record the stack `slice` was just started in: extend the stack that ends at
 * its parent, refresh one that already holds it, else start
 * `<fanout>/<bottom slice>` (`<fanout>/<slice>` when that name is taken by a
 * sibling chain). Null when the slice is not stacked. Branches below the
 * first one that exists locally (landed and deleted) are left out.
 */
export function recordSliceStack(cwd: string, plan: FanoutFile, slice: Slice): SliceStack | null {
  const full = stackPath(plan, slice);
  const first = full.findIndex((item) => branchRef(cwd, item.branch) !== null);
  const chain = first < 0 ? [] : full.slice(first);
  if (chain.length < 2) return null;
  const branches = chain.map((item) => item.branch);
  const stacks = fanoutStacks(cwd, plan);
  const listOf = (stack: StackFile) => stack.branches.map((entry) => entry.branch);
  const holding = stacks.find((stack) => listOf(stack).includes(slice.branch));
  const below = stacks.find((stack) => sameList(listOf(stack), branches.slice(0, -1)));
  const bottom = `${plan.name}/${chain[0].id}`;
  const name =
    holding?.name ??
    below?.name ??
    (stacks.some((stack) => stack.name === bottom) ? `${plan.name}/${slice.id}` : bottom);
  const list = holding ? listOf(holding) : branches;
  const recorded = recordStack(cwd, { name, trunk: plan.trunk, branches: list });
  if (!recorded.ok)
    return {
      ok: false,
      error: `stack ${name} was not recorded: ${recorded.error}`,
      unblock: recorded.unblock ?? `workit stack plan --name ${name} ${list.join(" ")}`,
    };
  const ids = new Map(plan.slices.map((item) => [item.branch, item.id]));
  return { ok: true, name, slices: list.map((branch) => ids.get(branch) ?? branch) };
}

export type FanoutStackRow = {
  /** The recorded stack's name; null for a planned chain not recorded yet. */
  name: string | null;
  /** Slice ids (a branch outside the plan by name), bottom first. */
  slices: string[];
};

/** The recorded stacks of `plan`, then each planned chain no recorded stack equals. */
export function fanoutStackRows(cwd: string, plan: FanoutFile): FanoutStackRow[] {
  const ids = new Map(plan.slices.map((slice) => [slice.branch, slice.id]));
  const recorded = fanoutStacks(cwd, plan).map((stack) => ({
    name: stack.name,
    slices: stack.branches.map((entry) => ids.get(entry.branch) ?? entry.branch),
  }));
  const planned = plannedChains(plan)
    .map((chain) => chain.map((slice) => slice.id))
    .filter((chain) => !recorded.some((row) => sameList(row.slices, chain)))
    .map((slices) => ({ name: null, slices }));
  return [...recorded, ...planned];
}
