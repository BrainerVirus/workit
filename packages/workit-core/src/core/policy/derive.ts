// S17 slim policy: requirements derived deterministically from the four
// judgments plus project constraints (design §4.3), and the status of the
// rules that read the ledger or the plan instead of task evidence.
import { existsSync } from "node:fs";
import path from "node:path";
import { currentBranch } from "../../git/rev";
import { STRONG_RESULTS, checkVerdicts, readLedger, type ReadRow } from "../../ledger";
import type { VerificationMode } from "../../autonomy";
import {
  requirementId,
  sha256,
  type Constraint,
  type Judgment,
  type Requirement,
  type Scope,
  type TaskRecord,
} from "../task-contract";

export const RULES = {
  test: "check:test",
  self: "verdict:self",
  nonAuthor: "verdict:non-author",
  verified: "verdict:verified",
  product: "decision:product",
  plan: "plan",
} as const;

const derived = (spec: Omit<Requirement, "id">): Requirement => ({
  ...spec,
  id: requirementId({
    ruleId: spec.ruleId,
    scope: spec.scope,
    satisfaction: spec.satisfaction,
    before: spec.before,
    dependentAction: spec.dependentAction,
  }),
});

const sorted = (values: string[]) => [...new Set(values)].toSorted();
const normalizedScope = (scope: Scope): Scope => ({
  description: scope.description,
  paths: sorted(scope.paths),
  exclusions: sorted(scope.exclusions),
});

/**
 * | judgment                         | requirement                                  |
 * | behaviorChange                   | check:test (configured, fresh tree), close   |
 * | behaviorChange && risk = normal  | verdict:self (default) or verdict:non-author  |
 * |                                  | (workspace verification: independent), close |
 * | risk = high                      | verdict:verified (ledger), close             |
 * | productChoiceOpen                | decision:product, before write               |
 * | needsPlan or risk = high         | plan (doc ref, soft), before write           |
 * | always                           | project constraints                          |
 */
export function deriveRequirements(
  judgment: Judgment,
  scope: Scope,
  constraints: Constraint[],
  /** The workspace's user-config verification mode (autonomy.ts). */
  verification: VerificationMode = "self",
): Requirement[] {
  const out: Requirement[] = [];
  const base = { scope, dependentAction: null };
  if (judgment.behaviorChange)
    out.push(
      derived({
        ...base,
        ruleId: RULES.test,
        dimension: "testing",
        reason: "Behavior changes: the configured test check must pass on the final tree.",
        satisfaction: "Run `workit check test` on the final tree.",
        before: "close",
        acceptanceAllowed: false,
      }),
    );
  if (judgment.behaviorChange && judgment.riskTier === "normal")
    out.push(
      verification === "independent"
        ? derived({
            ...base,
            ruleId: RULES.nonAuthor,
            dimension: "review",
            reason:
              "This workspace requires independent verification: a session that did not author the change records the verdict.",
            satisfaction:
              "An independent session records a passing verdict: `workit ledger verdict verified --how <what it exercised>`.",
            before: "close",
            acceptanceAllowed: false,
          })
        : derived({
            ...base,
            ruleId: RULES.self,
            dimension: "review",
            reason:
              "A behavior change needs a recorded verdict; the author's own is allowed and is shown as self-reviewed, never verified.",
            satisfaction:
              "After an observed passing `workit check test`, record `workit ledger verdict tests-verified --self --how <what you ran>` (or have a verifier record one).",
            before: "close",
            acceptanceAllowed: false,
          }),
    );
  if (judgment.riskTier === "high")
    out.push(
      derived({
        ...base,
        ruleId: RULES.verified,
        dimension: "review",
        reason: "High risk: an independent verifier must exercise the live surface.",
        satisfaction:
          "An independent verifier runs the real surface and records `workit ledger verdict verified --kind live --how <what it exercised>`.",
        before: "close",
        acceptanceAllowed: false,
      }),
    );
  if (judgment.productChoiceOpen)
    out.push(
      derived({
        ...base,
        ruleId: RULES.product,
        dimension: "decisions",
        reason:
          "A product or preference choice is open; the user decides it before code is written.",
        satisfaction:
          'Ask the user (with your recommendation), then record the answer: `workit ledger decision "<choice>" --why "<reason>"`.',
        before: "write",
        acceptanceAllowed: false,
      }),
    );
  if (judgment.needsPlan || judgment.riskTier === "high")
    out.push(
      derived({
        ...base,
        ruleId: RULES.plan,
        dimension: "artifacts",
        reason: judgment.needsPlan
          ? "The work needs a written plan or spec before implementation."
          : "High-risk work needs a written plan before implementation.",
        satisfaction:
          "Write the plan or spec (e.g. docs/plans/<slug>.md; docs and Markdown writes stay allowed), then record it: `workit policy assess --ref <path>`.",
        before: "write",
        acceptanceAllowed: true,
      }),
    );
  for (const constraint of constraints)
    for (const obligation of constraint.requires)
      out.push(
        derived({
          ruleId: `project-constraint:${constraint.id}:${obligation.kind}:${sha256({
            kind: obligation.kind,
            scope: normalizedScope(obligation.scope),
            refs: obligation.refs.map((ref) => JSON.stringify(ref)).toSorted(),
            method: obligation.method,
            before: obligation.before,
            dependentAction: obligation.dependentAction,
          })}`,
          dimension:
            obligation.method ??
            (obligation.kind === "check"
              ? "verification"
              : obligation.kind === "decision"
                ? "decisions"
                : "challenge"),
          scope: obligation.scope,
          reason: `${constraint.kind} constraint requires ${obligation.kind}: ${constraint.statement}`,
          satisfaction: `Satisfy the constraint obligation using its referenced ${obligation.kind}.`,
          before: obligation.before,
          dependentAction: obligation.dependentAction,
          acceptanceAllowed: constraint.acceptanceAllowed && obligation.kind !== "decision",
        }),
      );
  const seen = new Set<string>();
  return out.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

export const latestJudgment = (task: TaskRecord): Judgment | null =>
  task.judgments?.at(-1)?.data ?? null;

/** Lazily read ledger rows and the checked-out branch, once per evaluation. */
export type LedgerView = { branch: () => string | null; rows: () => readonly ReadRow[] };
export const ledgerView = (root: string): LedgerView => {
  let branch: string | null | undefined;
  let rows: readonly ReadRow[] | undefined;
  return {
    branch: () => (branch === undefined ? (branch = currentBranch(root)) : branch),
    rows: () => {
      if (rows === undefined) {
        const read = readLedger(root);
        rows = read.ok ? read.value.rows : [];
      }
      return rows;
    },
  };
};

export type RuleStatus = { met: boolean; reason: string; decisionIds: string[] };

/** A user decision recorded on the task, or a ledger decision on this branch since the task began. */
const productDecision = (task: TaskRecord, ledger: LedgerView): RuleStatus => {
  const decisions = task.decisions.filter(
    (entry) =>
      entry.data.revoked === null &&
      (entry.data.response === "approved" || entry.data.response === "stated") &&
      entry.data.purpose !== "limitation",
  );
  if (decisions.length)
    return {
      met: true,
      reason: "the user's decision is recorded on the task",
      decisionIds: decisions.map((entry) => entry.id),
    };
  const since = Date.parse(task.createdAt);
  const branch = ledger.branch();
  // Outside git (no branch) the checkout's own ledger rows carry no branch either.
  const row = ledger
    .rows()
    .findLast(
      (item) =>
        item.type === "decision" &&
        !item.superseded &&
        (item.branch ?? null) === branch &&
        Date.parse(item.at) >= since,
    );
  return row
    ? { met: true, reason: `ledger decision ${row.id} records the choice`, decisionIds: [] }
    : {
        met: false,
        reason:
          'open product choice: ask the user, then `workit ledger decision "<choice>" --why "<reason>"` (or re-judge productChoiceOpen=false if it is not open)',
        decisionIds: [],
      };
};

/** The latest judgment cites an existing doc or a URL, or an artifact passed. */
const planRecorded = (task: TaskRecord, root: string): RuleStatus => {
  const cited = (latestJudgment(task)?.refs ?? []).find(
    (ref) =>
      ref.kind === "external" || (ref.kind === "file" && existsSync(path.resolve(root, ref.path))),
  );
  if (cited)
    return {
      met: true,
      reason: `plan recorded: ${cited.kind === "file" ? cited.path : cited.kind === "external" ? cited.url : ""}`,
      decisionIds: [],
    };
  const artifact = task.evidence.some(
    (entry) => entry.data.kind === "artifact" && entry.data.result === "passed",
  );
  return artifact
    ? { met: true, reason: "a passing artifact records the plan", decisionIds: [] }
    : {
        met: false,
        reason:
          "no plan recorded: write it (docs/ and Markdown writes stay allowed), then `workit policy assess --ref <path>`",
        decisionIds: [],
      };
};

/**
 * Verdict rules over the D18 ledger. `type-check-only` never proves a
 * behavior change. `verdict:self` takes the author's own current `--self`
 * verdict (shown as self-reviewed) or an independent one; `verdict:non-author`
 * an accepted independent one; `verdict:verified` an accepted independent
 * `verified` verdict of kind `live`.
 */
const verdict = (requirement: Requirement, root: string, ledger: LedgerView): RuleStatus => {
  const branch = ledger.branch();
  if (!branch)
    return { met: false, reason: "no branch is checked out to hold a verdict", decisionIds: [] };
  const check = checkVerdicts(root, branch, ledger.rows());
  const failing = check.accepted.reasons.includes("failing_verdict");
  const strong = (entry: (typeof check.verdicts)[number]) =>
    STRONG_RESULTS.has(String(entry.verdict.result));
  const met =
    !failing &&
    (requirement.ruleId === RULES.verified
      ? check.verdicts.find(
          (entry) =>
            entry.accepted && entry.kind === "live" && String(entry.verdict.result) === "verified",
        )
      : requirement.ruleId === RULES.nonAuthor
        ? check.verdicts.find((entry) => entry.accepted && strong(entry))
        : check.verdicts.find((entry) => entry.current && strong(entry)));
  if (met)
    return {
      met: true,
      reason: `${met.accepted ? "accepted independent" : "self-reviewed (author's own)"} ${String(met.verdict.result)} verdict ${met.verdict.id}`,
      decisionIds: [],
    };
  const why = failing
    ? "a current independent verdict fails"
    : check.verdicts.some((entry) => entry.current && entry.verdict.result === "type-check-only")
      ? "type-check-only does not prove a behavior change"
      : (check.accepted.reasons.join(", ") || "no_verdict").replace(/_/g, " ");
  const unblock =
    requirement.ruleId === RULES.self
      ? "record your own verdict after an observed `workit check test`: `workit ledger verdict tests-verified --self --how <what you ran>` (shown as self-reviewed), or have a verifier record one"
      : `an independent session records \`workit ledger verdict verified${requirement.ruleId === RULES.verified ? " --kind live" : ""} --how <what it exercised>\``;
  return { met: false, reason: `${why}: ${unblock}`, decisionIds: [] };
};

/** Status of a derived rule that is not decided by task evidence; null for every other rule. */
export function derivedRuleStatus(
  task: TaskRecord,
  requirement: Requirement,
  root: string,
  ledger: LedgerView,
): RuleStatus | null {
  switch (requirement.ruleId) {
    case RULES.product:
      return productDecision(task, ledger);
    case RULES.plan:
      return planRecorded(task, root);
    case RULES.self:
    case RULES.nonAuthor:
    case RULES.verified:
      return verdict(requirement, root, ledger);
    default:
      return null;
  }
}

export type WriteBlocker = { ruleId: string; reason: string };

/**
 * Unmet before-write requirements of a task (S17 write gate). Only derived
 * rules are decided here, cheaply and without capturing a candidate;
 * constraint write obligations stay advisory.
 */
export function writeBlockers(task: TaskRecord, root: string): WriteBlocker[] {
  if (task.status === "closed" || !task.policy) return [];
  const ledger = ledgerView(root);
  return task.policy.requirements.flatMap((requirement) => {
    if (requirement.before !== "write") return [];
    const status = derivedRuleStatus(task, requirement, root, ledger);
    return status && !status.met ? [{ ruleId: requirement.ruleId, reason: status.reason }] : [];
  });
}
