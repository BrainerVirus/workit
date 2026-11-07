import type { ResolvedForge } from "./resolve";
import { failure, type ForgeCheck, type ForgeResult, type RefChecks } from "./types";

/**
 * Why the base is red, judged against the run before it: `flaky` when every
 * failing check passed on the previous base commit, `broken` when one of them
 * failed there too, `unknown` when the previous run could not tell.
 */
export type BaseRedCause =
  | { kind: "flaky"; checks: ForgeCheck[] }
  | { kind: "broken"; checks: ForgeCheck[] }
  | { kind: "unknown"; note: string };

export function classifyBaseRed(
  failing: readonly ForgeCheck[],
  previous: ForgeResult<RefChecks>,
): BaseRedCause {
  if (!previous.ok)
    return { kind: "unknown", note: `the previous run could not be read (${previous.error})` };
  const before = new Map(previous.data.checks.map((check) => [check.name, check.state]));
  const broken = failing.filter((check) => before.get(check.name) === "failing");
  if (broken.length) return { kind: "broken", checks: broken };
  if (failing.every((check) => before.get(check.name) === "passing"))
    return { kind: "flaky", checks: [...failing] };
  return {
    kind: "unknown",
    note: "the previous run did not report every failing check, so a flake cannot be told apart",
  };
}

/**
 * The checks of the base commit before the head (`<base>~1`), the previous
 * run on a squash-merged base. GitHub resolves the revision expression; GitLab
 * reads pipelines by branch name only, so it reports no previous run.
 */
export function previousBaseChecks(resolved: ResolvedForge, base: string): ForgeResult<RefChecks> {
  if (resolved.forge.kind !== "github")
    return failure("unavailable", `${resolved.forge.kind} has no previous-run read`);
  // Advisory only: a read that throws must never change the base_red refusal.
  try {
    return resolved.forge.branchChecks(`${base}~1`);
  } catch (error) {
    return failure("failed", `the previous ${base} run read threw (${String(error)})`);
  }
}

const quote = (name: string): string => `"${name.replaceAll('"', '\\"')}"`;

const named = (checks: readonly ForgeCheck[]): string =>
  checks.map((check) => (check.url ? `${check.name} (${check.url})` : check.name)).join(", ");

/** The sentence the refusal adds and the next step it hands the lead. */
export function baseRedNextStep(
  base: string,
  cause: BaseRedCause,
  override: string,
): { detail: string; unblock: string } {
  if (cause.kind === "flaky")
    return {
      detail: `likely flaky: ${named(cause.checks)} passed on the previous ${base} run`,
      unblock: `workit ci rerun --ref ${base} ${cause.checks.map((check) => `--check ${quote(check.name)}`).join(" ")} --reason flake  # then merge once ${base} is green`,
    };
  if (cause.kind === "broken")
    return {
      detail: `${base} is broken: ${named(cause.checks)} also failed on the previous ${base} run, so a rerun will not help`,
      unblock: `fix ${base} first; or, if the user accepts it: ${override}`,
    };
  return {
    detail: `flake or not is unknown: ${cause.note}`,
    unblock: `workit ci rerun --ref ${base} --failed --reason flake  # a flake on ${base}: merge once it is green; a real failure: fix ${base} first, or, if the user accepts it: ${override}`,
  };
}
