// `workit ci wait --branch <b>` with no PR (#912): waits on the push runs of
// the branch's remote tip (a trunk right after a merge), through the forge's
// branch checks, the same read `release tag` gates on. `release tag --wait`
// polls with pollBranchChecks before it tags.
import { NO_CHECKS_GRACE_MS, pollDelay } from "@workit-dev/core/src/forge/report";
import type { ResolvedForge } from "@workit-dev/core/src/forge/resolve";
import type { ForgeCheck, ForgeResult, RefChecks } from "@workit-dev/core/src/forge/types";
import { emit, fail, ok, type Io } from "../output";
import { progressFor } from "../progress";
import { forgeDeps, forgeFail } from "./forge-common";

/** Consecutive failed polls tolerated before a branch wait gives up. */
const MAX_POLL_ERRORS = 3;

type BranchCiState = "passed" | "failed" | "pending" | "no_checks" | "moved";

/** The failing checks: failed ones, and required ones the forge skipped. */
const failingChecks = (checks: RefChecks): ForgeCheck[] =>
  checks.checks.filter(
    (check) => check.state === "failing" || (check.required === true && check.state === "skipped"),
  );

/**
 * CI on a branch tip: `moved` when `sha` is set and the forge reports another
 * commit, then failed, pending, passed, or no checks at all.
 */
function branchCiState(checks: RefChecks, sha: string | null, awaitMissing = false): BranchCiState {
  if (sha && checks.sha && !checks.sha.startsWith(sha)) return "moved";
  if (failingChecks(checks).length) return "failed";
  // `awaitMissing`: a not-yet-reported required check is awaited only within the
  // no-checks grace, as waitVerdict's expectedMissing; a PR-only check never reports on push.
  if (
    checks.checks.some((check) => check.state === "pending") ||
    (awaitMissing && (checks.missingRequired?.length ?? 0) > 0)
  )
    return "pending";
  return checks.checks.some((check) => check.state === "passing") ? "passed" : "no_checks";
}

export type BranchPoll = { checks: RefChecks; state: BranchCiState; polls: number };

/**
 * Poll the checks on `branch` while they are pending (or not yet reported,
 * within the no-checks grace) and `deadline` is ahead. A moved tip waits too
 * when `waitMoved` (ci wait --head: the push may not have landed yet).
 */
export async function pollBranchChecks(
  resolved: ResolvedForge,
  branch: string,
  options: {
    sha: string | null;
    started: number;
    deadline: number;
    intervalMs: number;
    waitMoved?: boolean;
    /** Wait, within the no-checks grace, for required checks the forge has not reported yet (ci wait --branch). */
    requireAll?: boolean;
    onPoll?: (poll: BranchPoll) => void;
  },
): Promise<ForgeResult<BranchPoll>> {
  let polls = 0;
  let errors = 0;
  let last: BranchPoll | null = null;
  for (;;) {
    const read = resolved.forge.branchChecks(branch);
    polls += 1;
    if (read.ok) {
      errors = 0;
      const grace = forgeDeps.now() - options.started < NO_CHECKS_GRACE_MS;
      last = {
        checks: read.data,
        state: branchCiState(read.data, options.sha, options.requireAll === true && grace),
        polls,
      };
      options.onPoll?.(last);
      const waits =
        last.state === "pending" ||
        (last.state === "no_checks" && grace) ||
        (last.state === "moved" && options.waitMoved === true);
      if (!waits) return { ok: true, data: last };
    } else {
      errors += 1;
      if (read.code !== "unavailable" && read.code !== "failed") return read;
      if (errors >= MAX_POLL_ERRORS) return read;
    }
    const remaining = options.deadline - forgeDeps.now();
    if (remaining <= 0)
      return last
        ? { ok: true, data: { ...last, polls } }
        : { ok: false, code: "unavailable", error: "no successful poll before the timeout" };
    await forgeDeps.sleep(Math.min(pollDelay(options.intervalMs, polls - 1), remaining));
  }
}

const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

/** `workit ci wait --branch <b>` when the branch has no PR: its push runs. */
export async function waitOnBranch(
  io: Io,
  target: {
    resolved: ResolvedForge;
    branch: string;
    head: string | null;
    started: number;
    deadline: number;
    intervalMs: number;
    timeoutMs: number;
  },
): Promise<number> {
  const { resolved, branch, head, started, deadline, intervalMs, timeoutMs } = target;
  const waiting = progressFor(io).start(`Waiting for CI on ${branch}`);
  const polled = await pollBranchChecks(resolved, branch, {
    sha: head,
    started,
    deadline,
    intervalMs,
    waitMoved: true,
    requireAll: true,
    onPoll: ({ checks }) => {
      const pending = checks.checks.filter((check) => check.state === "pending");
      waiting.label(
        `Waiting for CI on ${branch}: ${pending.length} check${pending.length === 1 ? "" : "s"} pending`,
      );
    },
  });
  const elapsedMs = forgeDeps.now() - started;
  if (!polled.ok) {
    waiting.end("failed");
    return forgeFail(io, polled, { branch });
  }
  const { checks, state, polls } = polled.data;
  waiting.end(state === "passed" || state === "no_checks" ? "done" : "failed");
  const sha = checks.sha;
  const at = sha ? ` at ${sha.slice(0, 12)}` : "";
  const missing = checks.missingRequired ?? [];
  const data = {
    state: state === "passed" || state === "no_checks" ? "ready" : state,
    target: "branch",
    branch,
    sha,
    checks: checks.checks.map(({ name, state: checkState, url }) => ({
      name,
      state: checkState,
      url,
    })),
    ...(missing.length ? { missingRequired: missing } : {}),
    polls,
    elapsedMs,
    timeoutMs,
  };
  const never = missing.length
    ? `; required checks that never reported on ${branch}: ${missing.join(", ")}`
    : "";
  const polledFor = `after ${polls} poll${polls === 1 ? "" : "s"}, ${seconds(elapsedMs)}`;
  if (state === "passed" || state === "no_checks")
    return emit(
      io,
      ok(data),
      () =>
        (state === "passed"
          ? `CI pass on ${branch}${at}: ${checks.checks.filter((check) => check.state === "passing").length} passing ${polledFor}`
          : `CI none: no checks reported on ${branch}${at} within the grace ${polledFor}`) + never,
    );
  if (state === "failed")
    return emit(
      io,
      fail(
        "failed",
        `CI fail on ${branch}${at}: ${failingChecks(checks)
          .map((check) => check.name)
          .join(", ")}`,
        {
          data,
          unblock: `workit ci rerun --ref ${branch} --failed --reason flake  # when it is a flake; else fix ${branch}`,
        },
      ),
    );
  const retry = `workit ci wait --branch ${branch}${head ? ` --head ${head}` : ""}`;
  return emit(
    io,
    fail(
      "pending",
      state === "moved"
        ? `CI on ${branch} still reports ${sha?.slice(0, 12) ?? "another commit"}, not ${head}, after ${seconds(elapsedMs)}`
        : !checks.checks.some((check) => check.state === "pending") && missing.length
          ? `CI on ${branch}${at}: required checks not reported yet (${missing.join(", ")}) after ${seconds(elapsedMs)}`
          : `CI on ${branch}${at} still pending after ${seconds(elapsedMs)}`,
      { data, unblock: `Retry as: ${retry}` },
    ),
  );
}
