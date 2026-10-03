// `workit pr status` / `ci wait` / `ci rerun` logic (design §2.1, S10): one
// forge-neutral status document, the pstack `next` priority, the CI-wait
// verdict, and rerun planning with the rerun-once rule.
import { aheadBehind, currentBranch, fetchRefs, hasCommit, headSha, resolveRef } from "../git/rev";
import type { ResolvedForge } from "./resolve";
import { rerunCounts, recordReruns, type RerunRow } from "./reruns";
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

export type NextAction =
  | "RESOLVE_CONFLICTS"
  | "REBASE"
  | "RESOLVE_THREADS"
  | "FIX_CI"
  | "WAITING_CI"
  | "READY"
  | "MERGED"
  | "CLOSED";

export type FailingCheck = {
  name: string;
  url: string | null;
  runId: number | null;
  jobId: number | null;
  conclusion: string | null;
  logTail: string[];
  logError?: string;
  rerunsOnHead: number;
};

export type BehindBase = {
  behind: number | null;
  ahead: number | null;
  baseSha: string | null;
  upToDate: boolean | null;
  /** Why the counts are null (fetch failed, head not available locally). */
  error?: string;
};

export type ChecksState = "failing" | "pending" | "passing" | "none";

export type PrStatusDoc = {
  forge: "github" | "gitlab";
  repo: string;
  number: number;
  url: string;
  state: PrState;
  draft: boolean;
  base: string;
  head: { branch: string; sha: string; localSha: string | null; pushed: boolean | null };
  mergeable: "yes" | "no" | "unknown";
  conflicts: boolean;
  rebaseRequired: boolean;
  behindBase: BehindBase | null;
  checks: {
    state: ChecksState;
    failing: FailingCheck[];
    pending: string[];
    passing: number;
  };
  reviews: { decision: string | null; unresolvedThreads: ForgeThread[] };
  truncated: boolean;
  next: NextAction;
};

/** Failing checks whose log tail is fetched; the rest list without a tail. */
export const MAX_LOG_TAILS = 5;

export function checksState(checks: readonly ForgeCheck[]): ChecksState {
  if (checks.some((check) => check.state === "failing")) return "failing";
  if (checks.some((check) => check.state === "pending")) return "pending";
  return checks.length > 0 ? "passing" : "none";
}

/** pstack priority: conflicts > required rebase > threads > CI. */
export function nextAction(status: {
  state: PrState;
  conflicts: boolean;
  rebaseRequired: boolean;
  threads: number;
  checks: ChecksState;
}): NextAction {
  if (status.state === "merged") return "MERGED";
  if (status.state === "closed") return "CLOSED";
  if (status.conflicts) return "RESOLVE_CONFLICTS";
  if (status.rebaseRequired) return "REBASE";
  if (status.threads > 0) return "RESOLVE_THREADS";
  if (status.checks === "failing") return "FIX_CI";
  if (status.checks === "pending") return "WAITING_CI";
  return "READY";
}

/** Observe `base` on the push remote and count head against it, locally. */
export function computeBehindBase(
  cwd: string,
  remote: string,
  base: string,
  head: { branch: string; sha: string },
): BehindBase {
  const tracking = `refs/remotes/${remote}/${base}`;
  const fetched = fetchRefs(cwd, remote, [`+refs/heads/${base}:${tracking}`]);
  const empty = { behind: null, ahead: null, upToDate: null };
  if (!fetched.ok) return { ...empty, baseSha: null, error: fetched.error };
  const baseSha = resolveRef(cwd, tracking);
  if (!baseSha) return { ...empty, baseSha: null, error: `${tracking} did not resolve` };
  // The PR head may not be local (`--pr` for someone else's branch): fetch it
  // without creating a ref. A fork head is not on this remote.
  if (!hasCommit(cwd, head.sha)) fetchRefs(cwd, remote, [`refs/heads/${head.branch}`]);
  const counts = hasCommit(cwd, head.sha) ? aheadBehind(cwd, baseSha, head.sha) : null;
  if (!counts)
    return { ...empty, baseSha, error: `head ${head.sha.slice(0, 12)} is not available locally` };
  return { ...counts, baseSha };
}

export type ReportOptions = {
  pr?: number | null;
  branch?: string | null;
  logLines?: number;
  /** Skip the base fetch and ahead/behind count (ci wait polls). */
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
  const found = resolved.forge.findPr(branch);
  if (!found.ok) return found;
  if (!found.data) {
    const noun = resolved.forge.kind === "github" ? "pull request" : "merge request";
    return failure(
      "not_found",
      `no ${noun} for branch ${branch} in ${resolved.forge.repo}`,
      "push the branch and open one (workit pr create, S11), or pass --pr <n>",
    );
  }
  return success(found.data.number);
}

export function buildStatusDoc(
  cwd: string,
  resolved: ResolvedForge,
  status: ForgePrStatus,
  options: { logLines: number; behind: boolean },
): PrStatusDoc {
  const { forge } = resolved;
  const reruns = rerunCounts(cwd, { repo: forge.repo, pr: status.number, head: status.head.sha });
  const failing = status.checks.filter((check) => check.state === "failing");
  const failingDocs = failing.map((check, index): FailingCheck => {
    const doc: FailingCheck = {
      name: check.name,
      url: check.url,
      runId: check.runId,
      jobId: check.jobId,
      conclusion: check.conclusion,
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
  const state = checksState(status.checks);
  return {
    forge: forge.kind,
    repo: forge.repo,
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
    conflicts: status.conflicts,
    rebaseRequired: status.rebaseRequired,
    behindBase:
      options.behind && status.state === "open"
        ? computeBehindBase(cwd, resolved.remote, status.base, status.head)
        : null,
    checks: {
      state,
      failing: failingDocs,
      pending: status.checks
        .filter((check) => check.state === "pending")
        .map((check) => check.name),
      passing: status.checks.filter((check) => check.state === "passing").length,
    },
    reviews: { decision: status.reviewDecision, unresolvedThreads: status.threads },
    truncated: status.truncated,
    next: nextAction({
      state: status.state,
      conflicts: status.conflicts,
      rebaseRequired: status.rebaseRequired,
      threads: status.threads.length,
      checks: state,
    }),
  };
}

/** Select, read and document one PR/MR. */
export function prStatusReport(
  cwd: string,
  resolved: ResolvedForge,
  options: ReportOptions = {},
): ForgeResult<{ doc: PrStatusDoc; raw: ForgePrStatus }> {
  const number = selectPr(cwd, resolved, options);
  if (!number.ok) return number;
  const status = resolved.forge.prStatus(number.data);
  if (!status.ok) return status;
  const doc = buildStatusDoc(cwd, resolved, status.data, {
    logLines: options.logLines ?? 60,
    behind: options.behind ?? true,
  });
  return success({ doc, raw: status.data });
}

// ---------------------------------------------------------------------------
// ci wait

export type WaitState = "ready" | "waiting" | "failed" | "blocked";

export type WaitVerdict = { state: WaitState; reason: string; unblock?: string };

/** Checks never appeared: after this grace a PR without CI reads ready. */
export const NO_CHECKS_GRACE_MS = 90_000;

export function waitVerdict(
  doc: PrStatusDoc,
  options: { head?: string | null; elapsedMs: number; noChecksGraceMs?: number },
): WaitVerdict {
  if (options.head && !doc.head.sha.startsWith(options.head))
    return doc.state === "open"
      ? { state: "waiting", reason: "head_mismatch" }
      : {
          state: "blocked",
          reason: `pr_${doc.state}`,
          unblock: "the PR head can no longer change",
        };
  const checks = doc.checks.state;
  if (checks === "failing") return { state: "failed", reason: "checks_failing" };
  if (checks === "pending")
    return doc.state === "open"
      ? { state: "waiting", reason: "checks_pending" }
      : { state: "blocked", reason: `pr_${doc.state}` };
  if (checks === "passing") return { state: "ready", reason: "checks_passing" };
  if (doc.state === "open" && doc.conflicts)
    return {
      state: "blocked",
      reason: "conflicts",
      unblock: `rebase onto ${doc.base} and push; CI does not run on a conflicting PR`,
    };
  if (doc.state === "open" && options.elapsedMs < (options.noChecksGraceMs ?? NO_CHECKS_GRACE_MS))
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
    // One "rerun failed jobs" per workflow run / pipeline.
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
  const { forge } = resolved;
  const counts = rerunCounts(cwd, { repo: forge.repo, pr: status.number, head: status.head.sha });
  const repeated = plan.data.checks.filter((check) => (counts.get(check.name) ?? 0) > 0);
  if (repeated.length && !options.force)
    return failure(
      "blocked",
      `rerun_limit: ${repeated.map((check) => check.name).join(", ")} already rerun once on head ${status.head.sha.slice(0, 12)}`,
      "treat it as a real failure and fix it; if it is a confirmed flake, rerun with --force",
    );
  const accepted: ForgeCheck[] = [];
  for (const target of plan.data.targets) {
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
      ...plan.data.checks.filter((check) =>
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
    skipped: plan.data.skipped,
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
