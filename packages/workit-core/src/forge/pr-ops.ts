// `workit pr create` and `workit pr merge` (design §2.1 S11): forge writes with
// a SHA bound before the call and verified after it.
//
// create: the branch must already be pushed (remote tip == local head); that
// SHA is bound, an open PR/MR for the branch is reused (`created: false`),
// and success means the forge reports the bound SHA as the PR head. The
// `pr.created` ledger row is what `ledger check --pr` resolves through (S13).
//
// merge: three independent gates, all required:
//   1. the S10 status document reads READY (required checks green, no
//      conflicts, threads, review or draft blockers);
//   2. an accepted S13 verdict for that exact head (fresh or carried). Under
//      `merge: true` only, `--unverified --reason` bypasses it, and the bypass
//      is recorded (`merge.unverified`) before the merge call;
//   3. the `merge` grant (autonomy.ts `requireGrant`; S16 fills the defaults).
// The merge call carries the head SHA (GitHub `sha=`, GitLab `sha=`), so a
// head that moves after the gates refuses instead of merging unverified code.
// --delete-branch deletes with a lease on that same SHA.
import {
  requireGrant,
  resolveAutonomy,
  type AutonomySource,
  type DefaultEndpoint,
} from "../autonomy";
import { isProtectedTarget } from "../core/branch";
import { vcsConfig } from "../core/vcs-config";
import { workspaceReleaseTracks } from "../core/release-tracks";
import { deleteRemoteBranch } from "../git/ops";
import { spawnSync } from "node:child_process";
import { currentBranch, fetchRefs, GIT_TIMEOUTS, remoteRefTip, resolveRef } from "../git/rev";
import {
  appendObserved,
  checkVerdicts,
  readLedger,
  type LedgerActor,
  type VerdictCheck,
} from "../ledger";
import { buildStatusDoc, selectPr, type PrStatusDoc } from "./report";
import type { ResolvedForge } from "./resolve";
import { failure, success, type ForgeResult, type MergeMethod, type PrRef } from "./types";

export type Sleep = (ms: number) => Promise<void>;

/** Post-verification retries: the forge may take a moment to show a new head or merge. */
const VERIFY_DELAYS_MS = [1_000, 2_000, 4_000];

const noun = (resolved: ResolvedForge): string =>
  resolved.forge.kind === "github" ? "pull request" : "merge request";

const grantBlocked = (decision: Extract<ReturnType<typeof requireGrant>, { allowed: false }>) =>
  failure("blocked", decision.error, decision.unblock);

// ---------------------------------------------------------------------------
// create

export type CreateInput = {
  base: string;
  title: string;
  body: string;
  draft: boolean;
  actor: LedgerActor;
  /** Applied after the PR is opened or found (`--label`, `--reviewer`). */
  labels?: string[];
  reviewers?: string[];
};

export type CreateOutcome = {
  number: number;
  url: string;
  branch: string;
  base: string;
  head: string;
  created: boolean;
  draft: boolean;
  recorded: { id: string } | { error: string };
  /** The review step and what the effective endpoint does after it. */
  next: string;
};

const AFTER_REVIEW: Record<DefaultEndpoint, string> = {
  commit: "stop here; review comes when the user asks",
  pr: "stop here; review comes when the user asks",
  green: "babysit it to merge-ready, never merging",
  merged: "babysit it, then land it after verification",
};

const createNext = (cwd: string): string => {
  const endpoint = resolveAutonomy(cwd).effectiveEndpoint;
  return `a non-author verifies the head (workit-review); the endpoint is ${endpoint}, so ${AFTER_REVIEW[endpoint]}`;
};

/** Workit's own commit trailer: provenance for the ledger, not PR prose. */
const SESSION_TRAILER = /^Workit-Session:.*$/gimu;

/**
 * `--fill`: the title and body from the branch's commits on top of the base
 * (fetched first). One commit gives its subject and body; several give the
 * oldest subject and every subject with its body, like `gh pr create
 * --fill-verbose`. `Workit-Session:` trailers are left out of the body.
 */
export function fillFromCommits(
  cwd: string,
  resolved: ResolvedForge,
  base: string,
): ForgeResult<{ title: string; body: string }> {
  const tracking = `refs/remotes/${resolved.baseRemote}/${base}`;
  if (!base.startsWith("-"))
    fetchRefs(cwd, resolved.baseRemote, [`+refs/heads/${base}:${tracking}`]);
  const from = resolveRef(cwd, tracking) ?? resolveRef(cwd, `refs/heads/${base}`);
  if (!from)
    return failure(
      "not_found",
      `base ${base} is not available locally`,
      `git fetch ${resolved.baseRemote} ${base}`,
    );
  const log = spawnSync(
    "git",
    ["log", "--reverse", "--no-merges", "--format=%s%x1f%b%x1e", `${from}..HEAD`],
    {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUTS.local,
      killSignal: "SIGKILL",
    },
  );
  const commits = (log.status === 0 ? log.stdout : "")
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [subject = "", body = ""] = entry.split("\x1f");
      return { subject: subject.trim(), body: body.replace(SESSION_TRAILER, "").trim() };
    });
  if (commits.length === 0)
    return failure(
      "invalid_input",
      `no commits on top of ${base}; nothing to describe`,
      "pass --title <t>",
    );
  if (commits.length === 1) return success({ title: commits[0].subject, body: commits[0].body });
  return success({
    title: commits[0].subject,
    body: commits
      .map((commit) =>
        [`- ${commit.subject}`, ...(commit.body ? ["", indent(commit.body), ""] : [])].join("\n"),
      )
      .join("\n")
      .trim(),
  });
}

const indent = (text: string): string =>
  text
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");

/**
 * Labels and reviewers a PR write may send, checked before any forge call
 * (so `pr create --label/--reviewer` never fails after the PR is open):
 * comma-free names (GitLab joins labels with commas), GitLab reviewers are
 * usernames, and a GitHub `org/team` belongs to the repository's owner.
 */
export function checkNames(
  kind: "github" | "gitlab",
  repo: string,
  labels: readonly string[],
  reviewers: readonly string[],
): string | null {
  const bad = [...labels, ...reviewers].find(
    (value) => !value.trim() || value.includes(",") || value !== value.trim(),
  );
  if (bad !== undefined) return `invalid label or reviewer "${bad}"`;
  const owner = repo.split("/")[0]?.toLowerCase() ?? "";
  for (const reviewer of reviewers) {
    if (!reviewer.includes("/")) continue;
    if (kind === "gitlab") return `GitLab reviewers are usernames, not teams ("${reviewer}")`;
    const [org = "", team = "", ...rest] = reviewer.split("/");
    if (!team || rest.length) return `invalid team reviewer "${reviewer}" (use <org>/<team>)`;
    if (org.toLowerCase() !== owner)
      return `team ${reviewer} is not in ${owner}; GitHub only requests teams of the repository's owner`;
  }
  return null;
}

/** The pushed head of the current branch, bound before any forge write. */
export function boundSource(
  cwd: string,
  resolved: ResolvedForge,
): ForgeResult<{ branch: string; sha: string }> {
  const branch = currentBranch(cwd);
  if (!branch) return failure("invalid_input", "HEAD is detached; check out the PR branch");
  const sha = resolveRef(cwd, `refs/heads/${branch}`);
  if (!sha) return failure("not_found", `branch ${branch} has no commit`);
  const remote = remoteRefTip(cwd, resolved.remote, `refs/heads/${branch}`);
  if (!remote.ok) return failure(remote.code, remote.error);
  if (remote.sha !== sha)
    return failure(
      "blocked",
      remote.sha === null
        ? `not_pushed: ${branch} is not on ${resolved.remote}`
        : `not_pushed: ${resolved.remote}/${branch} is at ${remote.sha.slice(0, 12)}, local ${branch} is at ${sha.slice(0, 12)}`,
      "workit git push",
    );
  return success({ branch, sha });
}

async function verifiedHead(
  resolved: ResolvedForge,
  branch: string,
  sha: string,
  first: PrRef,
  sleep: Sleep,
): Promise<ForgeResult<PrRef>> {
  let ref = first;
  for (const delay of [0, ...VERIFY_DELAYS_MS]) {
    if (ref.headSha === sha) return success(ref);
    if (delay) await sleep(delay);
    const found = resolved.forge.findPr(branch, {
      owner: resolved.headRepo.split("/")[0] ?? null,
      projectId: resolved.headProjectId,
      sha,
    });
    if (!found.ok) return found;
    if (found.data && found.data.number === first.number) ref = found.data;
  }
  return ref.headSha === sha
    ? success(ref)
    : failure(
        "failed",
        `head_unverified: ${noun(resolved)} #${first.number} reports head ${ref.headSha?.slice(0, 12) ?? "(none)"}, not the pushed ${sha.slice(0, 12)}`,
        `workit pr status --pr ${first.number}`,
      );
}

export async function createPullRequest(
  cwd: string,
  resolved: ResolvedForge,
  input: CreateInput,
  sleep: Sleep,
): Promise<ForgeResult<CreateOutcome>> {
  const names = checkNames(
    resolved.forge.kind,
    resolved.forge.repo,
    input.labels ?? [],
    input.reviewers ?? [],
  );
  if (names) return failure("invalid_input", names);
  const grant = requireGrant(cwd, "pr");
  if (!grant.allowed) return grantBlocked(grant);
  const source = boundSource(cwd, resolved);
  if (!source.ok) return source;
  const { branch, sha } = source.data;
  if (branch === input.base)
    return failure(
      "invalid_input",
      `the PR source and base are both ${branch}`,
      "pass --base <branch>",
    );

  const existing = resolved.forge.findPr(branch, {
    owner: resolved.headRepo.split("/")[0] ?? null,
    projectId: resolved.headProjectId,
    sha,
  });
  if (!existing.ok) return existing;
  let created = false;
  let ref: PrRef;
  if (existing.data && existing.data.state === "open") ref = existing.data;
  else {
    const made = resolved.forge.createPr({
      head: branch,
      headRepo: resolved.headRepo,
      headProjectId: resolved.headProjectId,
      base: input.base,
      title: input.title,
      body: input.body,
      draft: input.draft,
    });
    if (!made.ok) return made;
    ref = made.data;
    created = true;
  }
  const verified = await verifiedHead(resolved, branch, sha, ref, sleep);
  if (!verified.ok) return verified;
  const row = appendObserved(cwd, {
    type: "pr.created",
    actor: input.actor,
    branch,
    head: sha,
    pr: ref.number,
    base: input.base,
    url: ref.url,
    forge: resolved.forge.kind,
    repo: resolved.forge.repo,
    created,
  });
  const labels = input.labels ?? [];
  const reviewers = input.reviewers ?? [];
  if (labels.length || reviewers.length) {
    const edited = resolved.forge.editPr(ref.number, {
      addLabels: labels,
      removeLabels: [],
      addReviewers: reviewers,
    });
    if (!edited.ok)
      return failure(
        edited.code,
        `${noun(resolved)} #${ref.number} is open (${ref.url}), but its labels or reviewers were not set: ${edited.error}`,
        `workit pr edit --pr ${ref.number}${labels.map((name) => ` --add-label ${name}`).join("")}${reviewers.map((name) => ` --add-reviewer ${name}`).join("")}`,
      );
  }
  return success({
    number: ref.number,
    url: ref.url,
    branch,
    base: input.base,
    head: sha,
    created,
    draft: input.draft,
    recorded: row.ok ? { id: String(row.value.id) } : { error: row.error },
    next: createNext(cwd),
  });
}

// ---------------------------------------------------------------------------
// merge

export type MergeInput = {
  pr: number | null;
  method: MergeMethod;
  deleteBranch: boolean;
  actor: LedgerActor;
  /**
   * Stack landing (S12): refuse unless the PR still targets this base and
   * comes from this branch, re-checked right before the merge call.
   */
  expect?: { base: string; branch: string };
  /** Merge without a verdict (`merge: true` only); the reason is recorded. */
  unverified?: { reason: string };
};

export type MergeOutcome = {
  number: number;
  url: string;
  branch: string;
  base: string;
  head: string;
  method: MergeMethod;
  mergeSha: string | null;
  verdict: { required: boolean; accepted: boolean; verdictId: string | null };
  /** Set when `--unverified` bypassed the verdict: the reason and its ledger row. */
  unverified: { reason: string; recorded: string } | null;
  grant: { source: AutonomySource };
  deletedBranch: boolean | { error: string };
  recorded: { id: string } | { error: string };
  /**
   * Release tracks: when the PR landed on a track's production branch, the
   * branches it must flow back into (mergeBackBranches); empty otherwise.
   * Workit reports them; it does not open the merge-back PRs itself.
   */
  mergeBack: string[];
  mergeBackTrack: string | null;
};

/**
 * The merge-back a merge into `base` owes: the track whose production branch
 * `base` is, by ownership alone (no --track, no WORKFLOW_RELEASE_TRACK, no
 * history). Best effort: a config problem never stops the pr.merged record.
 */
const mergeBackFor = (cwd: string, base: string): { track: string | null; branches: string[] } => {
  try {
    const owners = workspaceReleaseTracks(cwd).tracks.filter(
      (track) => track.productionBranch === base,
    );
    if (owners.length !== 1) return { track: null, branches: [] };
    return {
      track: owners[0].name,
      branches: owners[0].mergeBackBranches.filter((branch) => branch !== base),
    };
  } catch {
    return { track: null, branches: [] };
  }
};

/** Why `pr merge` refused, for the envelope `data` (agents branch on `reason`). */
export type MergeRefusal = {
  reason:
    | "grant_required"
    | "unverified_refused"
    | "failed_verdict"
    | "not_ready"
    | "needs_verdict"
    | "head_mismatch"
    | "already_merged"
    | "closed"
    | "protected_branch"
    | "base_mismatch";
  next?: string;
  blockers?: string[];
  verdict?: Pick<VerdictCheck, "head" | "accepted" | "authors">;
};

export type MergeResult =
  | { ok: true; data: MergeOutcome }
  | {
      ok: false;
      code: "blocked" | "failed" | "unavailable" | "not_found" | "busy" | "invalid_input";
      error: string;
      unblock?: string;
      refusal?: MergeRefusal;
    };

const refuse = (error: string, unblock: string, refusal: MergeRefusal): MergeResult => ({
  ok: false,
  code: "blocked",
  error,
  unblock,
  refusal,
});

/**
 * The command (or step) that clears a `next` blocker, for `pr status` and a
 * `pr merge` refusal; null for READY and the terminal states.
 */
export function nextHint(next: string, number: number): string | null {
  const pr = `--pr ${number}`;
  switch (next) {
    case "RESOLVE_CONFLICTS":
      return "rebase onto the base, resolve, then workit git push --force-with-lease";
    case "REBASE":
      return "rebase onto the base, then workit git push --force-with-lease";
    case "RESOLVE_THREADS":
      return `workit pr threads ${pr}; fix or answer each: workit pr reply ${pr} --thread <id> --body-file <f> [--resolve]`;
    case "FIX_CI":
      return "fix the failing checks (workit pr status shows the log tails), push, then workit ci wait";
    case "WAITING_CI":
      return "workit ci wait";
    case "ADDRESS_REVIEW":
      return `address the requested changes; answer threads with workit pr reply ${pr} --thread <id> --body-file <f>`;
    case "REVIEW":
      return `get the required review (workit pr edit ${pr} --add-reviewer <login>)`;
    case "MARK_READY":
      return `workit pr ready ${pr}`;
    case "IN_MERGE_QUEUE":
      return "the PR is already in the merge queue";
    case "NOT_MERGEABLE":
      return "workit pr status  # the forge reports it cannot merge yet";
    default:
      return null;
  }
}

export async function mergePullRequest(
  cwd: string,
  resolved: ResolvedForge,
  input: MergeInput,
  sleep: Sleep,
): Promise<MergeResult> {
  const grant = requireGrant(cwd, "merge");
  if (!grant.allowed) return refuse(grant.error, grant.unblock, { reason: "grant_required" });
  const bypass = input.unverified ?? null;
  if (bypass && !bypass.reason.trim())
    return failure("invalid_input", "--unverified needs --reason <why the user asked for it>");
  if (bypass && !grant.allowUnverified)
    return refuse(
      `unverified_refused: workspace ${grant.workspace ? `"${grant.workspace}"` : "(none)"} grants merge: "verified", which never merges without an accepted independent verdict`,
      "a non-author session verifies the head (workit-review), then merge without --unverified",
      { reason: "unverified_refused" },
    );

  const number = selectPr(cwd, resolved, { pr: input.pr });
  if (!number.ok) return number;
  const status = resolved.forge.prStatus(number.data);
  if (!status.ok) return status;
  const built = buildStatusDoc(cwd, resolved, status.data, { logLines: 0, behind: false });
  if (!built.ok) return built;
  const doc: PrStatusDoc = built.data;
  const label = `${resolved.forge.kind === "github" ? "PR #" : "MR !"}${doc.number}`;
  if (doc.state === "merged")
    return refuse(
      `already_merged: ${label} is already merged`,
      `workit verify-delivery merged --pr ${doc.number}`,
      {
        reason: "already_merged",
      },
    );
  if (doc.state === "closed")
    return refuse(`closed: ${label} is closed`, "reopen it on the forge first", {
      reason: "closed",
    });
  if (doc.next !== "READY")
    return refuse(
      `not_ready: ${label} is ${doc.next} (${doc.blockers.join(", ") || doc.next.toLowerCase()})`,
      nextHint(doc.next, doc.number) ?? "workit pr status",
      { reason: "not_ready", next: doc.next, blockers: doc.blockers },
    );

  if (input.expect && (doc.base !== input.expect.base || doc.head.branch !== input.expect.branch))
    return refuse(
      `base_mismatch: ${label} is ${doc.head.branch} -> ${doc.base}, expected ${input.expect.branch} -> ${input.expect.base}`,
      "workit stack sync  # retarget it, then land again",
      { reason: "base_mismatch" },
    );
  const branch = doc.head.branch;
  const head = doc.head.sha;
  // --delete-branch never deletes a protected branch, the base, or the
  // default target (a develop -> main release PR must keep develop). Refused
  // before merging, so the caller decides without a half-done delivery.
  if (input.deleteBranch) {
    const resolvedVcs = vcsConfig("resolve", cwd);
    const defaultTarget =
      resolvedVcs.ok === false ? null : String(resolvedVcs.defaultTargetBranch ?? "") || null;
    const lower = branch.toLowerCase();
    const reason = isProtectedTarget(cwd, branch)
      ? "is protected by the workspace branch policy"
      : lower === doc.base.toLowerCase()
        ? "is the PR base"
        : defaultTarget !== null && lower === defaultTarget.toLowerCase()
          ? "is the default target branch"
          : null;
    if (reason)
      return refuse(
        `protected_branch: --delete-branch would delete ${branch}, which ${reason}; workit never deletes it`,
        `workit pr merge${input.pr ? ` --pr ${doc.number}` : ""} --method ${input.method}  # without --delete-branch`,
        { reason: "protected_branch" },
      );
  }
  const ledger = readLedger(cwd);
  if (!ledger.ok) return ledger;
  const check = checkVerdicts(cwd, branch, ledger.value.rows);
  const summary = { head: check.head, accepted: check.accepted, authors: check.authors };
  const covered = check.head === head && check.accepted.accepted;
  let verdict: MergeOutcome["verdict"] = {
    required: true,
    accepted: covered,
    verdictId:
      covered && typeof check.accepted.verdict?.id === "string" ? check.accepted.verdict.id : null,
  };
  let unverified: MergeOutcome["unverified"] = null;
  // The bypass covers a missing verdict, never a rejection.
  if (!covered && bypass && check.accepted.reasons.includes("failing_verdict"))
    return refuse(
      `failed_verdict: ${label} has a current independent failed verdict${typeof check.accepted.verdict?.id === "string" ? ` (${check.accepted.verdict.id})` : ""}; --unverified never merges over a rejection`,
      "a new independent verdict on the head supersedes it",
      { reason: "failed_verdict", verdict: summary },
    );
  if (!covered && bypass) {
    // Recorded before the merge call: a bypass that cannot be audited never merges.
    const reason = bypass.reason.trim();
    const recorded = appendObserved(cwd, {
      type: "merge.unverified",
      actor: input.actor,
      branch,
      head,
      pr: doc.number,
      base: doc.base,
      reason,
      grant: grant.source,
    });
    if (!recorded.ok)
      return failure(
        "failed",
        `unverified_unrecorded: the --unverified bypass could not be recorded (${recorded.error}); nothing was merged`,
      );
    verdict = { required: false, accepted: false, verdictId: null };
    unverified = { reason, recorded: String(recorded.value.id) };
  } else if (check.head !== head)
    return refuse(
      `head_mismatch: the verdict check reads ${branch} at ${check.head?.slice(0, 12) ?? "(missing)"} but ${label} is at ${head.slice(0, 12)}`,
      `git fetch && git switch ${branch} && git merge --ff-only @{u}  # then re-verify that head`,
      { reason: "head_mismatch", verdict: summary },
    );
  else if (!covered)
    return refuse(
      `NEEDS_VERDICT: ${label} has no accepted independent verdict for ${head.slice(0, 12)} (${check.accepted.reasons.join(", ")})`,
      `an independent session verifies the head and runs: workit ledger verdict verified --how "<what was exercised>" --branch ${branch}${grant.allowUnverified ? `; or, only if the user asks to merge unverified: workit pr merge --unverified --reason "<why>"` : ""}`,
      { reason: "needs_verdict", verdict: summary },
    );

  const merged = resolved.forge.merge(doc.number, { sha: head, method: input.method });
  if (!merged.ok) return merged;
  // Post-verify: the forge must report the PR merged.
  let state = "open";
  for (const delay of [0, ...VERIFY_DELAYS_MS]) {
    if (delay) await sleep(delay);
    const after = resolved.forge.prStatus(doc.number);
    if (after.ok) state = after.data.state;
    if (state === "merged") break;
  }
  if (state !== "merged")
    return {
      ok: false,
      code: "failed",
      error: `merge_unverified: the forge accepted the merge of ${label} but still reports it ${state}`,
      unblock: `workit verify-delivery merged --pr ${doc.number}`,
    };

  let deletedBranch: MergeOutcome["deletedBranch"] = false;
  if (input.deleteBranch) {
    const deleted = deleteRemoteBranch(cwd, resolved.remote, branch, head);
    // The forge may delete merged branches itself; gone is deleted.
    const gone = !deleted.ok && remoteRefTip(cwd, resolved.remote, `refs/heads/${branch}`);
    deletedBranch =
      deleted.ok || (gone && gone.ok && gone.sha === null) ? true : { error: deleted.error };
  }
  const mergeBack = mergeBackFor(cwd, doc.base);
  const row = appendObserved(cwd, {
    type: "pr.merged",
    actor: input.actor,
    branch,
    head,
    pr: doc.number,
    base: doc.base,
    mergeSha: merged.data.mergeSha,
    method: input.method,
    verdictId: verdict.verdictId,
    ...(unverified ? { unverified: unverified.recorded } : {}),
    grant: grant.source,
  });
  return {
    ok: true,
    data: {
      number: doc.number,
      url: doc.url,
      branch,
      base: doc.base,
      head,
      method: input.method,
      mergeSha: merged.data.mergeSha,
      verdict,
      unverified,
      grant: { source: grant.source },
      deletedBranch,
      recorded: row.ok ? { id: String(row.value.id) } : { error: row.error },
      mergeBack: mergeBack.branches,
      mergeBackTrack: mergeBack.track,
    },
  };
}
