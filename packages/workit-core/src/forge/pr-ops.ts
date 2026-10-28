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
// A squash with --subject/--body, or in a workspace with `trailers: false`,
// sends its own message (the PR title and the branch's commits by default,
// on stdin) with `Workit-Session:` lines dropped from each trailer block.
import {
  requireGrant,
  resolveAutonomy,
  type AutonomySource,
  type DefaultEndpoint,
  type VerificationMode,
} from "../autonomy";
import { branchKindOf, flowRoute, gitFlowOf, isProtectedTarget } from "../core/branch";
import { vcsConfig } from "../core/vcs-config";
import { workspaceTrailers } from "../core/workspaces";
import { workspaceReleaseTracks } from "../core/release-tracks";
import { deleteRemoteBranch, stripSessionTrailers } from "../git/ops";
import { spawnSync } from "node:child_process";
import { currentBranch, fetchRefs, GIT_TIMEOUTS, remoteRefTip, resolveRef } from "../git/rev";
import {
  appendObserved,
  tamperedUnblock,
  readLedger,
  type CarryNote,
  type LedgerActor,
  type VerdictCheck,
} from "../ledger";
import { checkVerdictsCovered, type StackCover } from "../verdict-cover";
import type { LaneNeed, ReviewLane } from "../core/policy/lane";
import { laneLabel, prLaneGate } from "../core/policy/pr-lane";
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
  base: string,
): Promise<ForgeResult<PrRef>> {
  let ref = first;
  for (const delay of [0, ...VERIFY_DELAYS_MS]) {
    if (ref.headSha === sha) return success(ref);
    if (delay) await sleep(delay);
    const found = resolved.forge.findPr(branch, {
      owner: resolved.headRepo.split("/")[0] ?? null,
      projectId: resolved.headProjectId,
      sha,
      base,
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

  // Head AND base: a release branch with an open PR into main still gets
  // its back-merge PR into develop.
  const existing = resolved.forge.findPr(branch, {
    owner: resolved.headRepo.split("/")[0] ?? null,
    projectId: resolved.headProjectId,
    sha,
    base: input.base,
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
  const verified = await verifiedHead(resolved, branch, sha, ref, sleep, input.base);
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
  /** `--delete-branch`: delete, refusing a protected branch before the merge. */
  deleteBranch: boolean;
  /**
   * The workspace default (`deleteBranch`, no `--keep-branch`): delete when it
   * is safe, otherwise skip with a note; never refuses the merge.
   */
  implicitDelete?: boolean;
  actor: LedgerActor;
  /**
   * Stack landing (S12): refuse unless the PR still targets this base and
   * comes from this branch, re-checked right before the merge call.
   */
  expect?: { base: string; branch: string };
  /** Merge without a verdict (`merge: true` only); the reason is recorded. */
  unverified?: { reason: string };
  /** Squash commit subject and body (`--subject`, `--body`); unset parts use the defaults. */
  subject?: string;
  body?: string;
};

export type MergeOutcome = {
  number: number;
  url: string;
  branch: string;
  base: string;
  head: string;
  method: MergeMethod;
  mergeSha: string | null;
  /**
   * `required`: the gate asked for a verdict (false under lane none or a
   * bypass); `accepted`: an accepted independent verdict covers the head;
   * `verdictId`: the verdict the merge relied on (the author's own under lane
   * self, shown as self-reviewed); `lane`/`need`: the review lane and what it
   * asked (`need` is non-author outside `verification: proportional`).
   */
  verdict: {
    required: boolean;
    accepted: boolean;
    verdictId: string | null;
    review: "verified" | "self-reviewed" | "none";
    lane: ReviewLane;
    need: LaneNeed;
    verification: VerificationMode;
    /** The stack verdict above this PR that covers it (#334), when it has none of its own. */
    cover?: StackCover | null;
    /** How a verdict on an older head carried to this one over a follow-up change (#334). */
    carry?: CarryNote | null;
  };
  /** Set when `--unverified` bypassed the verdict: the reason and its ledger row. */
  unverified: { reason: string; recorded: string } | null;
  grant: { source: AutonomySource };
  /** `skipped`: the implicit default found a reason to keep the branch; the merge is unaffected. */
  deletedBranch: boolean | { error: string } | { skipped: string };
  recorded: { id: string } | { error: string };
  /** The `pr.merge.verified` row confirming `recorded`, or why it was not written. */
  confirmed: { id: string } | { error: string };
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
 * history); without tracks, a git-flow release/* or hotfix/* landing on the
 * production branch owes develop. Best effort: a config problem never stops
 * the pr.merged record.
 */
const mergeBackFor = (
  cwd: string,
  base: string,
  head: string,
): { track: string | null; branches: string[] } => {
  try {
    const read = workspaceReleaseTracks(cwd);
    if (!read.tracks.length) {
      const flow = gitFlowOf(cwd);
      const kind = branchKindOf(head);
      const route = flow && kind ? flowRoute(flow, kind) : null;
      return route?.mergeBack && route.target === base
        ? { track: "git-flow", branches: [route.mergeBack] }
        : { track: null, branches: [] };
    }
    const owners = read.tracks.filter((track) => track.productionBranch === base);
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
    | "base_mismatch"
    | "ledger_tampered"
    | "intent_unrecorded";
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
      /** merge_unverified: the `pr.merged` row (verified:false) written when the forge accepted it. */
      recorded?: { id: string } | { error: string };
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

/**
 * The squash message workit sends, or null to leave the forge default: only a
 * squash with --subject/--body or in a workspace with `trailers: false`.
 * Defaults: the PR title (GitHub appends `(#n)` like its own default) and the
 * branch's commits as GitHub lists them; Workit-Session lines never survive.
 */
function squashMessageFor(
  cwd: string,
  resolved: ResolvedForge,
  input: MergeInput,
  doc: PrStatusDoc,
): ForgeResult<{ subject: string; body: string }> | null {
  if (input.method !== "squash") return null;
  if (input.subject === undefined && input.body === undefined && workspaceTrailers(cwd).enabled)
    return null;
  let subject = input.subject?.trim() ?? "";
  if (!subject) {
    const meta = resolved.forge.prMeta(doc.number);
    if (!meta.ok) return meta;
    subject =
      resolved.forge.kind === "github" ? `${meta.data.title} (#${doc.number})` : meta.data.title;
  }
  // An explicit body is kept byte for byte but for its trailer block.
  const body =
    input.body === undefined
      ? squashCommitList(cwd, resolved, doc.base, doc.head.sha)
      : stripSessionTrailers(input.body, { subject: false });
  return success({ subject, body });
}

/** Bounds of the generated squash body: a forge message, not an archive. */
const SQUASH_LIST_MAX_COMMITS = 100;
const SQUASH_LIST_MAX_CHARS = 60_000;

/**
 * `* subject` and body of each non-merge commit on `base..head`, oldest
 * first, from the local clone ("" when absent); each commit loses its
 * Workit-Session trailers, and past the bounds the rest is counted.
 */
function squashCommitList(
  cwd: string,
  resolved: ResolvedForge,
  base: string,
  head: string,
): string {
  const from =
    resolveRef(cwd, `refs/remotes/${resolved.baseRemote}/${base}`) ??
    resolveRef(cwd, `refs/heads/${base}`);
  if (!from) return "";
  const log = spawnSync(
    "git",
    ["log", "--reverse", "--no-merges", "--format=%B%x1e", `${from}..${head}`],
    {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUTS.local,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (log.status !== 0) return "";
  const entries = log.stdout
    .split("\x1e")
    .map((message) => stripSessionTrailers(message.replace(/^\n+/u, ""), { subject: true }))
    .filter((message) => message.trim())
    .map((message) => {
      const [subject = "", ...rest] = message.trimEnd().split("\n");
      const body = rest.join("\n").replace(/^\n+/u, "");
      return body ? `* ${subject}\n\n${body}` : `* ${subject}`;
    });
  const listed: string[] = [];
  let size = 0;
  for (const entry of entries) {
    if (listed.length >= SQUASH_LIST_MAX_COMMITS || size + entry.length > SQUASH_LIST_MAX_CHARS)
      break;
    listed.push(entry);
    size += entry.length + 2;
  }
  const more = entries.length - listed.length;
  return [...listed, ...(more ? [`… and ${more} more commit${more === 1 ? "" : "s"}`] : [])].join(
    "\n\n",
  );
}

/**
 * Why the implicit delete keeps `branch`, or null when it is safe to delete:
 * a protected, base or default-target branch, a fork's branch, a branch another
 * open PR targets (a stack child), and a PR by someone other than the
 * workspace's `vcs.account`. What cannot be read keeps the branch too.
 */
function implicitDeleteSkip(
  cwd: string,
  resolved: ResolvedForge,
  doc: PrStatusDoc,
  branch: string,
): string | null {
  const resolvedVcs = vcsConfig("resolve", cwd);
  const defaultTarget =
    resolvedVcs.ok === false ? null : String(resolvedVcs.defaultTargetBranch ?? "") || null;
  const account = resolved.expectedAccount?.trim() ?? "";
  const lower = branch.toLowerCase();
  if (isProtectedTarget(cwd, branch))
    return `${branch} is protected by the workspace branch policy`;
  if (lower === doc.base.toLowerCase()) return `${branch} is the PR base`;
  if (defaultTarget !== null && lower === defaultTarget.toLowerCase())
    return `${branch} is the default target branch`;
  if (doc.headRepo !== null) return `${branch} is a fork's branch (${doc.headRepo})`;
  const meta = resolved.forge.prMeta(doc.number);
  if (!meta.ok) return `could not read the PR author and head repository (${meta.error})`;
  if (meta.data.fork !== false) return `${branch} is not known to be in ${resolved.forge.repo}`;
  if (account && (meta.data.author ?? "").toLowerCase() !== account.toLowerCase())
    return `the PR is by ${meta.data.author ?? "an unknown author"}, not ${account} (vcs.account)`;
  const children = resolved.forge.openPrsInto(branch);
  if (!children.ok) return `could not list the open PRs into ${branch} (${children.error})`;
  if (children.data.length)
    return `open PR ${children.data.map((n) => `#${n}`).join(", ")} targets ${branch} (a stack)`;
  return null;
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
  const ledger = readLedger(cwd, { integrity: true });
  if (!ledger.ok) return ledger;
  // A lower PR of a stack may be covered by the verdict at its top (#334).
  const check = checkVerdictsCovered(cwd, branch, ledger.value.rows);
  const gate = prLaneGate(cwd, check, { branch, base: doc.base, head });
  const summary = {
    head: check.head,
    accepted: check.accepted,
    authors: check.authors,
    lane: gate.lane.lane,
    need: gate.need,
  };
  // Lane none needs no verdict, so no verdict head either.
  const covered = gate.satisfied && (gate.need === "none" || check.head === head);
  let verdict: MergeOutcome["verdict"] = {
    required: gate.need !== "none",
    accepted: check.head === head && check.accepted.accepted,
    verdictId: covered ? gate.verdictId : null,
    review: covered ? gate.review : "none",
    lane: gate.lane.lane,
    need: gate.need,
    verification: gate.verification,
    ...(covered && gate.review === "verified"
      ? { cover: check.cover, carry: check.cover ? null : check.carry }
      : {}),
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
    verdict = { ...verdict, required: false, accepted: false, verdictId: null, review: "none" };
    unverified = { reason, recorded: String(recorded.value.id) };
  } else if (!covered && check.head !== head)
    return refuse(
      `head_mismatch: the verdict check reads ${branch} at ${check.head?.slice(0, 12) ?? "(missing)"} but ${label} is at ${head.slice(0, 12)}`,
      `git fetch && git switch ${branch} && git merge --ff-only @{u}  # then re-verify that head`,
      { reason: "head_mismatch", verdict: summary },
    );
  else if (!covered && check.accepted.reasons.includes("ledger_tampered"))
    return refuse(
      `ledger_tampered: a ledger row was edited, removed or moved, so no verdict for ${label} is accepted until it is repaired`,
      tamperedUnblock(cwd),
      { reason: "ledger_tampered", verdict: summary },
    );
  else if (!covered) {
    const bypassHint = grant.allowUnverified
      ? `; or, only if the user asks to merge unverified: workit pr merge --unverified --reason "<why>"`
      : "";
    const lane = gate.verification === "proportional" ? `, ${laneLabel(gate)}` : "";
    return refuse(
      gate.need === "self"
        ? `NEEDS_VERDICT: ${label} has no verdict for ${head.slice(0, 12)}${lane}: the author's own --self verdict is enough (${check.accepted.reasons.join(", ")})`
        : `NEEDS_VERDICT: ${label} has no accepted independent verdict for ${head.slice(0, 12)}${lane} (${check.accepted.reasons.join(", ")})`,
      gate.need === "self"
        ? `after an observed passing \`workit check test\`, the author runs: workit ledger verdict tests-verified --self --how "<what you ran>" --branch ${branch} (or a verifier records one)${bypassHint}`
        : `an independent session verifies the head and runs: workit ledger verdict verified --how "<what was exercised>" --branch ${branch}${bypassHint}`,
      { reason: "needs_verdict", verdict: summary },
    );
  }

  const squashMessage = squashMessageFor(cwd, resolved, input, doc);
  if (squashMessage && !squashMessage.ok) return squashMessage;
  // The intent goes in before the forge write: a merge call that errors after
  // the forge did merge still leaves a record `pr status` reads. A merge that
  // cannot be recorded never starts.
  const intent = appendObserved(cwd, {
    type: "pr.merge.intent",
    actor: input.actor,
    branch,
    head,
    pr: doc.number,
    base: doc.base,
    method: input.method,
    verdictId: verdict.verdictId,
    review: verdict.review,
    lane: verdict.lane,
    ...(unverified ? { unverified: unverified.recorded } : {}),
    grant: grant.source,
  });
  if (!intent.ok)
    return refuse(
      `intent_unrecorded: the merge intent for ${label} could not be recorded (${intent.error}); nothing was merged`,
      "fix the ledger (workit ledger check), then merge again",
      { reason: "intent_unrecorded" },
    );
  const intentId = String(intent.value.id);
  const merged = resolved.forge.merge(doc.number, {
    sha: head,
    method: input.method,
    ...(squashMessage ? { squashMessage: squashMessage.data } : {}),
  });
  if (!merged.ok)
    return {
      ...merged,
      error: `${merged.error} (merge intent ${intentId} is recorded: if the forge merged anyway, workit pr status reads it)`,
    };
  // Recorded as soon as the forge accepts it (N3): a failed read below must
  // not leave a merge that `pr status`, the stop hook and `verify-delivery
  // merged` cannot see. The post-verify then confirms it in its own row.
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
    review: verdict.review,
    lane: verdict.lane,
    ...(unverified ? { unverified: unverified.recorded } : {}),
    grant: grant.source,
    intent: intentId,
    verified: false,
  });
  const recorded = row.ok ? { id: String(row.value.id) } : { error: row.error };
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
      error: `merge_unverified: the forge accepted the merge of ${label} but still reports it ${state}${"id" in recorded ? `; recorded as pr.merged ${recorded.id} (verified: false)` : `; the pr.merged row could not be written (${recorded.error})`}`,
      unblock: `workit verify-delivery merged --pr ${doc.number}`,
      recorded,
    };
  const confirmation =
    "id" in recorded
      ? appendObserved(cwd, {
          type: "pr.merge.verified",
          actor: input.actor,
          branch,
          head,
          pr: doc.number,
          base: doc.base,
          merged: recorded.id,
          mergeSha: merged.data.mergeSha,
        })
      : null;
  const confirmed: MergeOutcome["confirmed"] =
    confirmation === null
      ? { error: "no pr.merged row to confirm" }
      : confirmation.ok
        ? { id: String(confirmation.value.id) }
        : { error: confirmation.error };

  let deletedBranch: MergeOutcome["deletedBranch"] = false;
  const skipReason =
    !input.deleteBranch && input.implicitDelete
      ? implicitDeleteSkip(cwd, resolved, doc, branch)
      : null;
  if (!input.deleteBranch && input.implicitDelete && skipReason !== null)
    deletedBranch = { skipped: skipReason };
  else if (input.deleteBranch || input.implicitDelete) {
    const deleted = deleteRemoteBranch(cwd, resolved.remote, branch, head);
    // The forge may delete merged branches itself; gone is deleted.
    const gone = !deleted.ok && remoteRefTip(cwd, resolved.remote, `refs/heads/${branch}`);
    deletedBranch =
      deleted.ok || (gone && gone.ok && gone.sha === null) ? true : { error: deleted.error };
  }
  const mergeBack = mergeBackFor(cwd, doc.base, branch);
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
      recorded,
      confirmed,
      mergeBack: mergeBack.branches,
      mergeBackTrack: mergeBack.track,
    },
  };
}
