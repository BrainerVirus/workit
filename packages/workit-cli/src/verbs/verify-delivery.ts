// `workit verify-delivery` (design §2.1 S11): a deterministic answer to "did
// it really land?". A local commit does not prove a push; this observes the
// remote (ls-remote), the forge (PR head, merged state) and the registry.
//
//   workit verify-delivery [push|pr|merge|release] [--expect pushed|pr|merged|released]
//                          [--branch <b>] [--pr <n>] [--sha <sha>]
//                          [--tag <tag>] [--package <name>[@<version>]] [--json]
//
// Exit 0 when every observation holds (delivered), 1 when one does not, with
// the observations in `data` either way.
import { progressFor } from "../progress";
import {
  verifyMerged,
  verifyPr,
  verifyPushed,
  verifyReleased,
  type DeliveryEndpoint,
  type DeliveryReport,
} from "@workit-dev/core/src/forge/verify";
import { TaskStore } from "@workit-dev/core/src/core/task-store";
import { closeDeliveredTasks } from "@workit-dev/core/src/core/task-delivery";
import {
  cleanupAfterMerge,
  remoteBranchGone,
  type MergeCleanup,
} from "@workit-dev/core/src/core/cleanup";
import { actorFromEnv, readLedger } from "@workit-dev/core/src/ledger";
import { isProtectedBranch } from "@workit-dev/core/src/core/repo-context";
import { currentBranch } from "@workit-dev/core/src/git/rev";
import { emit, fail, ok, type Io } from "../output";
import { connect, forgeDeps, forgeFail, parseFlags, positiveInt, usage } from "./forge-common";

const USAGE =
  "workit verify-delivery [push|pr|merge|release] [--expect pushed|pr|merged|released] [--branch <b>] [--pr <n>] [--sha <sha>] [--tag <t>] [--package <name[@version]>] [--json]";

const ENDPOINTS: Record<string, DeliveryEndpoint> = {
  push: "pushed",
  pushed: "pushed",
  pr: "pr",
  merge: "merged",
  merged: "merged",
  release: "released",
  released: "released",
};

const render = (report: DeliveryReport, notes = true): string[] => [
  `${report.expect}: ${report.delivered ? "delivered" : "NOT delivered"}${report.branch ? ` (${report.branch}${report.sha ? ` @ ${report.sha.slice(0, 12)}` : ""})` : ""}${report.pr ? ` #${report.pr}` : ""}`,
  ...report.observations.map(
    (entry) =>
      `  ${entry.ok ? "ok" : "x "} ${entry.kind}: expected ${entry.expected ?? "-"}, observed ${entry.observed ?? "(none)"}${notes && entry.note ? ` — ${entry.note}` : ""}`,
  ),
];

const cleanupLines = (cleanup: MergeCleanup, branch: string | null): string[] => [
  ...(cleanup.worktreeRemoved ? [`removed worktree ${cleanup.worktreeRemoved}`] : []),
  ...(cleanup.branchDeleted ? [`deleted local ${branch}`] : []),
  ...cleanup.notes,
  ...(cleanup.recorded && "error" in cleanup.recorded
    ? [`ledger: cleanup not recorded (${cleanup.recorded.error})`]
    : []),
];

/** The PR this session's last `pr merge` landed on `base`, from the ledger; null without one. */
function lastMergedOnto(cwd: string, base: string, session: string | null): number | null {
  if (!session) return null;
  const ledger = readLedger(cwd, { integrity: true });
  if (!ledger.ok) return null;
  const row = ledger.value.rows.findLast(
    (candidate) =>
      candidate.type === "pr.merged" &&
      candidate.observer === "workit_cli" &&
      candidate.integrity !== "unverified" &&
      candidate.base === base &&
      candidate.actor.session === session,
  );
  return typeof row?.pr === "number" ? row.pr : null;
}

export async function run(argv: string[], io: Io): Promise<number> {
  const flags = parseFlags(argv, {
    expect: "value",
    branch: "value",
    pr: "value",
    sha: "value",
    tag: "value",
    package: "value",
  });
  if (typeof flags === "string") return usage(io, flags, USAGE);
  if (flags.positionals.length > 1)
    return usage(io, `unexpected argument ${flags.positionals[1]}`, USAGE);
  const named = flags.positionals[0];
  if (named !== undefined && !ENDPOINTS[named])
    return usage(io, `unknown endpoint "${named}"`, USAGE);
  if (flags.values.expect !== undefined && !ENDPOINTS[flags.values.expect])
    return usage(io, "--expect must be pushed, pr, merged or released", USAGE);
  if (named && flags.values.expect && ENDPOINTS[named] !== ENDPOINTS[flags.values.expect])
    return usage(io, `${named} and --expect ${flags.values.expect} disagree`, USAGE);
  const expect =
    ENDPOINTS[named ?? ""] ??
    ENDPOINTS[flags.values.expect ?? ""] ??
    (flags.values.tag || flags.values.package ? "released" : flags.values.pr ? "pr" : "pushed");
  const pr = positiveInt(flags.values.pr, "--pr");
  if (typeof pr === "string") return usage(io, pr, USAGE);
  if (pr && flags.values.branch) return usage(io, "pass --pr or --branch, not both", USAGE);
  const sha = flags.values.sha ?? null;
  if (sha !== null && !/^[0-9a-f]{7,64}$/u.test(sha))
    return usage(io, "--sha must be a commit sha (7-64 hex chars)", USAGE);
  const actor = actorFromEnv(io.env);
  const branch = flags.values.branch ?? null;

  let result;
  if (expect === "pushed") {
    if (pr) return usage(io, "push is checked by --branch, not --pr", USAGE);
    result = progressFor(io).runSync(
      "Checking the push",
      () => verifyPushed(io.cwd, { branch, sha, actor }),
      (r) => (r.ok ? "done" : "failed"),
    );
  } else if (expect === "released") {
    result = progressFor(io).runSync(
      "Checking the release",
      () =>
        verifyReleased(
          io.cwd,
          {
            tag: flags.values.tag ?? null,
            pkg: flags.values.package ?? null,
            sha,
            actor,
          },
          forgeDeps.npm,
        ),
      (r) => (r.ok ? "done" : "failed"),
    );
  } else {
    // #651: a protected branch (main, develop…) is never a PR head, so the
    // current-branch lookup would suggest opening a PR from it. Use the PR
    // this session merged onto it, else ask for --pr.
    const here = pr || branch ? null : currentBranch(io.cwd);
    let picked: number | null = pr;
    if (here && isProtectedBranch(here)) {
      picked = expect === "merged" ? lastMergedOnto(io.cwd, here, actor.session) : null;
      if (picked === null)
        return emit(
          io,
          fail(
            "invalid_input",
            `${here} is a protected branch, not a PR head: verify-delivery ${expect === "merged" ? "merge" : "pr"} needs the PR${expect === "merged" ? " that landed on it, and this session recorded no merge onto it" : ""}`,
            {
              unblock: `workit verify-delivery ${expect === "merged" ? "merge" : "pr"} --pr <n>  # or --branch <its head branch>; never a PR from ${here}`,
            },
          ),
        );
      io.stderr(
        `workit: ${here} is a protected branch; checking PR #${picked}, the last one this session merged onto it\n`,
      );
    }
    const connected = connect(io, branch);
    if (!connected.ok) return forgeFail(io, connected);
    result =
      expect === "pr"
        ? progressFor(io).runSync(
            `Checking the PR`,
            () =>
              verifyPr(io.cwd, connected.data, {
                pr: picked,
                branch,
                sha,
                actor,
              }),
            (r) => (r.ok ? "done" : "failed"),
          )
        : progressFor(io).runSync(
            "Checking the merge",
            () =>
              verifyMerged(io.cwd, connected.data, {
                pr: picked,
                branch,
                actor,
              }),
            (r) => (r.ok ? "done" : "failed"),
          );
  }
  if (!result.ok) return forgeFail(io, result);
  const report = result.data;
  if (report.delivered && expect === "merged") {
    try {
      closeDeliveredTasks(
        new TaskStore(io.cwd),
        new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      );
    } catch {
      // The next task read repairs it from the ledger.
    }
  }
  // #653: a delivered merge whose remote branch is gone leaves the branch's clean Workit worktree and local branch behind no longer.
  const localCleanup: MergeCleanup | null =
    report.delivered &&
    expect === "merged" &&
    report.branch &&
    report.sha &&
    remoteBranchGone(io.cwd, report.branch)
      ? cleanupAfterMerge(io.cwd, report.branch, report.sha, {
          actor,
          trigger: "verify-delivery merge",
          env: io.env,
        })
      : null;
  if (report.delivered)
    return emit(io, ok(localCleanup ? { ...report, localCleanup } : report), (data) => [
      ...render(data),
      ...(localCleanup ? cleanupLines(localCleanup, data.branch) : []),
    ]);
  const failed = report.observations.filter((entry) => !entry.ok);
  // Human mode: the observations too; the reason is the error line's, once.
  if (!io.json) for (const line of render(report, false)) io.stdout(`${line}\n`);
  return emit(
    io,
    fail(
      "failed",
      `not_delivered: ${failed.map((entry) => entry.note ?? `${entry.kind} is ${entry.observed ?? "absent"}, expected ${entry.expected ?? "-"}`).join("; ")}`,
      {
        data: report,
        unblock:
          expect === "pushed"
            ? "workit git push"
            : expect === "pr"
              ? "workit git push && workit pr create --fill"
              : expect === "merged"
                ? "workit pr status  # then workit pr merge when READY and granted"
                : "check the release workflow; the tag/package is not published",
      },
    ),
  );
}
