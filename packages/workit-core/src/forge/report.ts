// `workit pr status` / `ci wait` / `ci rerun` logic (design §2.1, S10): one
// forge-neutral status document, the `next` priority, the CI-wait verdict,
// and rerun planning with the rerun-once rule.
import { aheadBehind, currentBranch, fetchRefs, hasCommit, headSha, resolveRef } from "../git/rev";
import { appendObserved, readLedger, type LedgerActor } from "../ledger";
import type { ResolvedForge } from "./resolve";
import { rerunCounts, recordReruns, withRerunLock, type RerunRow } from "./reruns";
import {
  failure,
  success,
  type ForgeCheck,
  type ForgePrStatus,
  type ForgeResult,
  type ForgeThread,
  type PrState,
  type RerunTarget,
} from "./types";

/**
 * What to do next, in priority order: conflicts > required rebase > threads
 * > CI > review > draft > merge queue > other merge blockers > READY.
 */
export type NextAction =
  | "MERGED"
  | "CLOSED"
  | "RESOLVE_CONFLICTS"
  | "REBASE"
  | "RESOLVE_THREADS"
  | "FIX_CI"
  | "WAITING_CI"
  | "ADDRESS_REVIEW"
  | "REVIEW"
  | "MARK_READY"
  | "IN_MERGE_QUEUE"
  | "NOT_MERGEABLE"
  | "READY";

/**
 * The next babysitting step for a `green`/`merged` endpoint, coarser than
 * `next`: `wait` is CI running (`workit ci wait`); `wait-forge` is CI done
 * but the forge still deciding (merge queue, mergeability computing);
 * `ready` means nothing is left for the agent (a human approval may still be
 * pending); null for a closed, unmerged PR.
 */
export type BabysitAction =
  | "wait"
  | "wait-forge"
  | "mark-ready"
  | "fix-ci"
  | "address-threads"
  | "update-branch"
  | "ready"
  | "merged";

export type FailingCheck = {
  name: string;
  url: string | null;
  runId: number | null;
  jobId: number | null;
  conclusion: string | null;
  /** Required by branch protection; an optional failure does not block the merge. */
  required: boolean | null;
  logTail: string[];
  logError?: string;
  rerunsOnHead: number;
};

export type BehindBase = {
  behind: number | null;
  ahead: number | null;
  baseSha: string | null;
  upToDate: boolean | null;
  /** Why the counts are null (fetch failed, commit not available). */
  error?: string;
};

export type ChecksState = "failing" | "pending" | "passing" | "none";

export type PrStatusDoc = {
  forge: "github" | "gitlab";
  repo: string;
  /** The push repository when it is a fork of `repo`. */
  headRepo: string | null;
  number: number;
  url: string;
  state: PrState;
  draft: boolean;
  base: string;
  head: { branch: string; sha: string; localSha: string | null; pushed: boolean | null };
  mergeable: "yes" | "no" | "unknown";
  mergeState: string | null;
  conflicts: boolean;
  rebaseRequired: boolean;
  inMergeQueue: boolean;
  behindBase: BehindBase | null;
  checks: {
    /** Over the checks that gate the merge (required ones when protection names them). */
    state: ChecksState;
    failing: FailingCheck[];
    pending: string[];
    passing: number;
    /** Required contexts that have not reported on this head; null when unknown. */
    missingRequired: string[] | null;
  };
  reviews: { decision: string | null; unresolvedThreads: ForgeThread[] };
  /** Every reason the PR cannot merge right now (empty when READY). */
  blockers: string[];
  identity: { login: string | null; credential: string; note?: string } | null;
  truncated: boolean;
  next: NextAction;
  babysit: BabysitAction | null;
};

/** Failing checks whose log tail is fetched; the rest list without a tail. */
export const MAX_LOG_TAILS = 5;

/**
 * The checks that gate the merge: the required ones when branch protection
 * names any; otherwise every check (an unprotected or unreadable branch is
 * treated conservatively).
 */
export function gatingChecks(status: ForgePrStatus): {
  checks: ForgeCheck[];
  /** True when branch protection decides which checks gate. */
  protected: boolean;
} {
  const required = status.checks.filter((check) => check.required === true);
  const protectionNamesChecks = (status.requiredContexts?.length ?? 0) > 0;
  return required.length > 0 || protectionNamesChecks
    ? { checks: required, protected: true }
    : { checks: status.checks, protected: false };
}

export function missingRequired(status: ForgePrStatus): string[] | null {
  if (status.requiredContexts === null) return null;
  const seen = new Set(status.checks.map((check) => check.context));
  return status.requiredContexts.filter((context) => !seen.has(context));
}

export function checksState(
  checks: readonly ForgeCheck[],
  missing: readonly string[] | null = [],
): ChecksState {
  if (checks.some((check) => check.state === "failing")) return "failing";
  if (checks.some((check) => check.state === "pending") || (missing?.length ?? 0) > 0)
    return "pending";
  return checks.length > 0 ? "passing" : "none";
}

// GitLab detailed_merge_status values that mean "mergeable now".
const GITLAB_MERGEABLE = new Set(["mergeable"]);
// GitHub mergeStateStatus values that allow a merge (UNSTABLE: only
// non-required checks fail; HAS_HOOKS: pre-receive hooks will run).
const GITHUB_MERGEABLE = new Set(["clean", "unstable", "has_hooks"]);

export type NextInput = {
  forge: "github" | "gitlab";
  state: PrState;
  draft: boolean;
  conflicts: boolean;
  rebaseRequired: boolean;
  mergeable: "yes" | "no" | "unknown";
  mergeState: string | null;
  inMergeQueue: boolean;
  reviewDecision: string | null;
  threads: number;
  checks: ChecksState;
  /** Branch protection names the gating checks (else every check gates). */
  checksRequired?: boolean;
};

/** The ordered merge blockers; the first one is `next`. */
export function blockersOf(input: NextInput): Array<{ next: NextAction; reason: string }> {
  if (input.state === "merged") return [{ next: "MERGED", reason: "merged" }];
  if (input.state === "closed") return [{ next: "CLOSED", reason: "closed" }];
  const out: Array<{ next: NextAction; reason: string }> = [];
  const ms = input.mergeState ?? "";
  if (input.conflicts) out.push({ next: "RESOLVE_CONFLICTS", reason: "conflicts" });
  if (input.rebaseRequired) out.push({ next: "REBASE", reason: "behind_base_required" });
  if (input.threads > 0 || ms === "discussions_not_resolved")
    out.push({ next: "RESOLVE_THREADS", reason: "unresolved_threads" });
  if (input.checks === "failing")
    out.push({
      next: "FIX_CI",
      reason: input.checksRequired ? "required_checks_failing" : "checks_failing",
    });
  else if (
    input.checks === "pending" ||
    ms === "ci_still_running" ||
    (ms === "ci_must_pass" && input.checks !== "passing")
  )
    out.push({ next: "WAITING_CI", reason: "checks_pending" });
  if (input.reviewDecision === "changes_requested" || ms === "requested_changes")
    out.push({ next: "ADDRESS_REVIEW", reason: "changes_requested" });
  else if (input.reviewDecision === "review_required" || ms === "not_approved")
    out.push({ next: "REVIEW", reason: "review_required" });
  if (input.draft || ms === "draft" || ms === "draft_status")
    out.push({ next: "MARK_READY", reason: "draft" });
  if (input.inMergeQueue) out.push({ next: "IN_MERGE_QUEUE", reason: "in_merge_queue" });
  if (out.length === 0) {
    const allowed = input.forge === "github" ? GITHUB_MERGEABLE.has(ms) : GITLAB_MERGEABLE.has(ms);
    if (input.mergeable === "unknown")
      out.push({ next: "NOT_MERGEABLE", reason: "mergeability_unknown" });
    else if (!allowed)
      out.push({ next: "NOT_MERGEABLE", reason: `merge_state_${ms || "unknown"}` });
  }
  return out;
}

export function nextAction(input: NextInput): NextAction {
  return blockersOf(input)[0]?.next ?? "READY";
}

/**
 * Map `next` (plus the first blocker's reason) to one babysitting step. The
 * branch is updated only when the forge requires it (conflicts, a required
 * rebase): merely behind its base is still `ready`, so a busy base never
 * starts a rebase/CI loop or drops approvals. A draft reads `mark-ready` once
 * nothing else is open, even when a review is also pending.
 */
export function babysitAction(
  next: NextAction,
  reason: string | null,
  draft: boolean,
): BabysitAction | null {
  switch (next) {
    case "MERGED":
      return "merged";
    case "CLOSED":
      return null;
    case "RESOLVE_CONFLICTS":
    case "REBASE":
      return "update-branch";
    case "RESOLVE_THREADS":
    case "ADDRESS_REVIEW":
      return "address-threads";
    case "FIX_CI":
      return "fix-ci";
    case "WAITING_CI":
      return "wait";
    case "IN_MERGE_QUEUE":
      return "wait-forge";
    default:
      if (draft) return "mark-ready";
      if (next === "NOT_MERGEABLE" && reason === "mergeability_unknown") return "wait-forge";
      return "ready";
  }
}

/**
 * Count head against the base tip the API reported, locally. A pure read:
 * missing commits are fetched by id (no destination ref, no FETCH_HEAD), so
 * no ref in the shared repository moves.
 */
export function computeBehindBase(
  cwd: string,
  remotes: { base: string; head: string },
  baseSha: string | null,
  headSha_: string,
  options: { timeoutMs?: number } = {},
): ForgeResult<BehindBase> {
  const empty = { behind: null, ahead: null, upToDate: null };
  if (!baseSha)
    return success({ ...empty, baseSha: null, error: "the forge reported no base tip" });
  for (const [sha, remote] of [
    [baseSha, remotes.base],
    [headSha_, remotes.head],
  ] as const) {
    if (hasCommit(cwd, sha)) continue;
    const fetched = fetchRefs(cwd, remote, [sha], options);
    if (!fetched.ok && remote !== remotes.base) fetchRefs(cwd, remotes.base, [sha], options);
    if (!hasCommit(cwd, sha))
      return success({
        ...empty,
        baseSha,
        error: fetched.ok ? `${sha.slice(0, 12)} is not available locally` : fetched.error,
      });
  }
  const counts = aheadBehind(cwd, baseSha, headSha_);
  return success(
    counts ? { ...counts, baseSha } : { ...empty, baseSha, error: "ahead/behind did not resolve" },
  );
}

export type ReportOptions = {
  pr?: number | null;
  branch?: string | null;
  logLines?: number;
  /** Skip the behind-base count (ci wait polls). */
  behind?: boolean;
};

/** The PR/MR number for `--pr`, `--branch`, or the current branch. */
export function selectPr(
  cwd: string,
  resolved: ResolvedForge,
  options: ReportOptions,
): ForgeResult<number> {
  if (options.pr) return success(options.pr);
  const branch = options.branch ?? currentBranch(cwd);
  if (!branch)
    return failure("invalid_input", "HEAD is detached; pass --pr <n> or --branch <name>");
  const localSha = resolveRef(cwd, `refs/heads/${branch}`);
  const found = resolved.forge.findPr(branch, {
    owner: resolved.headRepo.split("/")[0] ?? null,
    projectId: resolved.headProjectId,
    sha: localSha,
  });
  if (!found.ok) return found;
  if (!found.data) {
    const noun = resolved.forge.kind === "github" ? "pull request" : "merge request";
    return failure(
      "not_found",
      `no ${noun} for branch ${branch} from ${resolved.headRepo} in ${resolved.forge.repo}`,
      "workit git push && workit pr create --fill  # or pass --pr <n>",
    );
  }
  return success(found.data.number);
}

export function buildStatusDoc(
  cwd: string,
  resolved: ResolvedForge,
  status: ForgePrStatus,
  options: {
    logLines: number;
    behind: boolean;
    behindTimeoutMs?: number;
    identity?: PrStatusDoc["identity"];
  },
): ForgeResult<PrStatusDoc> {
  const { forge } = resolved;
  const reruns = rerunCounts(cwd, { repo: forge.repo, pr: status.number, head: status.head.sha });
  const gating = gatingChecks(status);
  const missing = missingRequired(status);
  const failing = status.checks.filter((check) => check.state === "failing");
  const failingDocs = failing.map((check, index): FailingCheck => {
    const doc: FailingCheck = {
      name: check.name,
      url: check.url,
      runId: check.runId,
      jobId: check.jobId,
      conclusion: check.conclusion,
      required: check.required,
      logTail: [],
      rerunsOnHead: reruns.get(check.name) ?? 0,
    };
    if (check.jobId !== null && options.logLines > 0 && index < MAX_LOG_TAILS) {
      const tail = forge.jobLogTail({ jobId: check.jobId, scope: check.scope }, options.logLines);
      if (tail.ok) doc.logTail = tail.data;
      else doc.logError = tail.error;
    }
    return doc;
  });
  const local =
    currentBranch(cwd) === status.head.branch
      ? headSha(cwd)
      : resolveRef(cwd, `refs/heads/${status.head.branch}`);
  let behindBase: BehindBase | null = null;
  if (options.behind && status.state === "open") {
    const counted = computeBehindBase(
      cwd,
      { base: resolved.baseRemote, head: resolved.remote },
      status.baseSha,
      status.head.sha,
      options.behindTimeoutMs === undefined ? {} : { timeoutMs: options.behindTimeoutMs },
    );
    if (!counted.ok) return counted;
    behindBase = counted.data;
  }
  const state = checksState(gating.checks, missing);
  const blockers = blockersOf({
    forge: forge.kind,
    state: status.state,
    draft: status.draft,
    conflicts: status.conflicts,
    rebaseRequired: status.rebaseRequired,
    mergeable: status.mergeable,
    mergeState: status.mergeState,
    inMergeQueue: status.inMergeQueue,
    reviewDecision: status.reviewDecision,
    threads: status.threads.length,
    checks: state,
    checksRequired: gating.protected,
  });
  return success({
    forge: forge.kind,
    repo: forge.repo,
    headRepo: resolved.fork ? resolved.headRepo : null,
    number: status.number,
    url: status.url,
    state: status.state,
    draft: status.draft,
    base: status.base,
    head: {
      branch: status.head.branch,
      sha: status.head.sha,
      localSha: local,
      pushed: local === null ? null : local === status.head.sha,
    },
    mergeable: status.mergeable,
    mergeState: status.mergeState,
    conflicts: status.conflicts,
    rebaseRequired: status.rebaseRequired,
    inMergeQueue: status.inMergeQueue,
    behindBase,
    checks: {
      state,
      failing: failingDocs,
      pending: status.checks
        .filter((check) => check.state === "pending")
        .map((check) => check.name),
      passing: status.checks.filter((check) => check.state === "passing").length,
      missingRequired: missing,
    },
    reviews: { decision: status.reviewDecision, unresolvedThreads: status.threads },
    blockers: status.state === "open" ? blockers.map((blocker) => blocker.reason) : [],
    identity: options.identity ?? null,
    truncated: status.truncated,
    next: blockers[0]?.next ?? "READY",
    babysit: babysitAction(
      blockers[0]?.next ?? "READY",
      blockers[0]?.reason ?? null,
      status.draft || blockers.some((blocker) => blocker.next === "MARK_READY"),
    ),
  });
}

/**
 * Record what the forge said about an open PR's checks as a CLI-observed
 * `pr.status` row (pr, branch, head, checks: passing|failing|pending), only
 * when it differs from the newest row for that PR and head, so polling never
 * floods the ledger. Hooks read it (stop control) without calling the forge.
 * A PR with no gating checks, or a closed one, is not recorded. Never fails
 * the verb: a ledger error only loses the row.
 */
export function recordPrStatus(cwd: string, doc: PrStatusDoc, actor: LedgerActor): void {
  const checks = doc.checks.state;
  if (
    doc.state !== "open" ||
    (checks !== "passing" && checks !== "failing" && checks !== "pending")
  )
    return;
  try {
    const ledger = readLedger(cwd);
    if (!ledger.ok) return;
    const last = ledger.value.rows.findLast(
      (row) =>
        row.type === "pr.status" &&
        row.observer === "workit_cli" &&
        row.pr === doc.number &&
        row.repo === doc.repo,
    );
    if (last && last.head === doc.head.sha && last.checks === checks) return;
    appendObserved(cwd, {
      type: "pr.status",
      actor,
      branch: doc.head.branch,
      head: doc.head.sha,
      pr: doc.number,
      repo: doc.repo,
      forge: doc.forge,
      checks,
    });
  } catch {
    // The row is an observation for hooks; the verb's answer stands without it.
  }
}

/** Select, read and document one PR/MR (recorded as a `pr.status` row when `actor` is given). */
export function prStatusReport(
  cwd: string,
  resolved: ResolvedForge,
  options: ReportOptions & { identity?: PrStatusDoc["identity"]; actor?: LedgerActor } = {},
): ForgeResult<{ doc: PrStatusDoc; raw: ForgePrStatus }> {
  const number = selectPr(cwd, resolved, options);
  if (!number.ok) return number;
  const status = resolved.forge.prStatus(number.data);
  if (!status.ok) return status;
  const doc = buildStatusDoc(cwd, resolved, status.data, {
    logLines: options.logLines ?? 60,
    behind: options.behind ?? true,
    identity: options.identity,
  });
  if (!doc.ok) return doc;
  if (options.actor) recordPrStatus(cwd, doc.data, options.actor);
  return success({ doc: doc.data, raw: status.data });
}

// ---------------------------------------------------------------------------
// ci wait

export type WaitState = "ready" | "waiting" | "failed" | "blocked";

export type WaitVerdict = { state: WaitState; reason: string; unblock?: string };

/** Checks never appeared: after this grace a PR known to need none reads ready. */
export const NO_CHECKS_GRACE_MS = 90_000;

/**
 * CI verdict for the PR head. Only gating checks count; a closed or merged
 * PR is never "ready". No checks at all is ready only after the grace and
 * only when the forge says nothing is required.
 */
export function waitVerdict(
  doc: PrStatusDoc,
  options: { head?: string | null; elapsedMs: number; noChecksGraceMs?: number },
): WaitVerdict {
  if (doc.state !== "open")
    return {
      state: "blocked",
      reason: `pr_${doc.state}`,
      unblock: `the ${doc.forge === "github" ? "PR" : "MR"} is ${doc.state}; nothing to wait for`,
    };
  if (options.head && !doc.head.sha.startsWith(options.head))
    return { state: "waiting", reason: "head_mismatch" };
  const checks = doc.checks.state;
  if (checks === "failing") return { state: "failed", reason: "checks_failing" };
  // Before "pending": CI never runs on a conflicting PR, so waiting cannot help (M8).
  if (doc.conflicts && checks !== "passing")
    return {
      state: "blocked",
      reason: "conflicts",
      unblock: `rebase onto ${doc.base} and push; CI does not run on a conflicting PR`,
    };
  if (checks === "pending") return { state: "waiting", reason: "checks_pending" };
  if (checks === "passing") return { state: "ready", reason: "checks_passing" };
  const ciRequired =
    doc.checks.missingRequired === null ||
    doc.mergeState === "ci_must_pass" ||
    doc.mergeState === "ci_still_running";
  if (ciRequired) return { state: "waiting", reason: "no_checks_yet" };
  if (options.elapsedMs < (options.noChecksGraceMs ?? NO_CHECKS_GRACE_MS))
    return { state: "waiting", reason: "no_checks_yet" };
  return { state: "ready", reason: "no_checks" };
}

/**
 * Poll delays: `interval`, growing 1.5x per poll up to max(interval, 2 min).
 * Deterministic, so a wait's poll count is predictable from its timeout.
 */
export function pollDelay(intervalMs: number, poll: number): number {
  const cap = Math.max(intervalMs, 120_000);
  return Math.min(cap, Math.round(intervalMs * 1.5 ** poll));
}

// ---------------------------------------------------------------------------
// ci rerun

export type RerunPlan = {
  checks: ForgeCheck[];
  targets: RerunTarget[];
  /** Selected checks the forge cannot rerun (external statuses). */
  skipped: string[];
};

export function planRerun(
  status: ForgePrStatus,
  selection: { failed: boolean; names: readonly string[] },
): ForgeResult<RerunPlan> {
  let checks: ForgeCheck[];
  if (selection.names.length > 0) {
    const unknown = selection.names.filter(
      (name) => !status.checks.some((check) => check.name === name),
    );
    if (unknown.length)
      return failure(
        "invalid_input",
        `unknown check ${unknown.map((name) => JSON.stringify(name)).join(", ")}; known: ${status.checks.map((check) => check.name).join(", ") || "none"}`,
      );
    checks = status.checks.filter((check) => selection.names.includes(check.name));
    const running = checks.filter((check) => check.state === "pending");
    if (running.length)
      return failure(
        "busy",
        `still running: ${running.map((check) => check.name).join(", ")}`,
        "workit ci wait",
      );
  } else {
    checks = status.checks.filter((check) => check.state === "failing");
  }
  if (checks.length === 0)
    return failure("not_found", `no failing checks on head ${status.head.sha.slice(0, 12)}`);
  const rerunnable = checks.filter((check) => check.jobId !== null && check.runId !== null);
  const skipped = checks.filter((check) => !rerunnable.includes(check)).map((check) => check.name);
  const targets: RerunTarget[] = [];
  if (selection.names.length === 0) {
    // One "rerun failed jobs" per workflow run / pipeline. The forge refuses
    // it while the run still has jobs in progress (GitHub: HTTP 403).
    const busy = status.checks.filter(
      (check) =>
        check.state === "pending" &&
        check.runId !== null &&
        rerunnable.some((failing) => failing.runId === check.runId),
    );
    if (busy.length)
      return failure(
        "busy",
        `the failed jobs' run is still in progress (${busy.map((check) => check.name).join(", ")})`,
        "workit ci wait, then rerun",
      );
    const seen = new Set<number>();
    for (const check of rerunnable)
      if (!seen.has(check.runId!)) {
        seen.add(check.runId!);
        targets.push({ kind: "failed_in_run", runId: check.runId!, scope: check.scope });
      }
  } else {
    for (const check of rerunnable)
      targets.push({ kind: "job", jobId: check.jobId!, scope: check.scope });
  }
  if (targets.length === 0)
    return failure(
      "unavailable",
      `${skipped.join(", ")} cannot be rerun from here (not a CI job); rerun it on the forge`,
    );
  return success({ checks: rerunnable, targets, skipped });
}

export type RerunOutcome = {
  pr: number;
  head: string;
  reason: string;
  forced: boolean;
  rerun: Array<{ name: string; runId: number | null; jobId: number | null }>;
  skipped: string[];
  recorded: boolean;
};

/**
 * Apply the rerun-once rule, trigger the reruns, and record one row per check
 * whose rerun the forge accepted.
 */
export function executeRerun(
  cwd: string,
  resolved: ResolvedForge,
  status: ForgePrStatus,
  options: { failed: boolean; names: readonly string[]; reason: string; force: boolean },
): ForgeResult<RerunOutcome> {
  if (status.state !== "open")
    return failure("blocked", `${status.state} PR: CI cannot be rerun`, "nothing to do");
  const plan = planRerun(status, options);
  if (!plan.ok) return plan;
  const locked = withRerunLock(cwd, () => rerunLocked(cwd, resolved, status, plan.data, options));
  return (
    locked ??
    failure("busy", "another ci rerun is in progress for this repository", "retry in a moment")
  );
}

function rerunLocked(
  cwd: string,
  resolved: ResolvedForge,
  status: ForgePrStatus,
  plan: RerunPlan,
  options: { failed: boolean; names: readonly string[]; reason: string; force: boolean },
): ForgeResult<RerunOutcome> {
  const { forge } = resolved;
  const counts = rerunCounts(cwd, { repo: forge.repo, pr: status.number, head: status.head.sha });
  const repeated = plan.checks.filter((check) => (counts.get(check.name) ?? 0) > 0);
  if (repeated.length && !options.force)
    return failure(
      "blocked",
      `rerun_limit: ${repeated.map((check) => check.name).join(", ")} already rerun once on head ${status.head.sha.slice(0, 12)}`,
      "treat it as a real failure and fix it; if it is a confirmed flake, rerun with --force",
    );
  const accepted: ForgeCheck[] = [];
  for (const target of plan.targets) {
    const done = forge.rerun(target);
    if (!done.ok) {
      recordAccepted(cwd, resolved, status, accepted, options);
      return failure(
        done.code,
        accepted.length
          ? `${done.error} (already rerun: ${accepted.map((check) => check.name).join(", ")})`
          : done.error,
        done.unblock,
      );
    }
    accepted.push(
      ...plan.checks.filter((check) =>
        target.kind === "failed_in_run"
          ? check.runId === target.runId
          : check.jobId === target.jobId,
      ),
    );
  }
  const recorded = recordAccepted(cwd, resolved, status, accepted, options);
  return success({
    pr: status.number,
    head: status.head.sha,
    reason: options.reason,
    forced: options.force,
    rerun: accepted.map((check) => ({ name: check.name, runId: check.runId, jobId: check.jobId })),
    skipped: plan.skipped,
    recorded,
  });
}

function recordAccepted(
  cwd: string,
  resolved: ResolvedForge,
  status: ForgePrStatus,
  accepted: readonly ForgeCheck[],
  options: { reason: string; force: boolean },
): boolean {
  const at = new Date().toISOString();
  const rows: RerunRow[] = accepted.map((check) => ({
    v: 1,
    at,
    type: "ci.rerun",
    forge: resolved.forge.kind,
    repo: resolved.forge.repo,
    pr: status.number,
    head: status.head.sha,
    check: check.name,
    reason: options.reason,
    forced: options.force,
  }));
  return recordReruns(cwd, rows);
}
