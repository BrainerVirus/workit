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
//   2. an accepted S13 verdict for that exact head (fresh or carried), unless
//      the workspace grants `merge: true`;
//   3. the `merge` grant (autonomy.ts `requireGrant`; S16 fills the defaults).
// The merge call carries the head SHA (GitHub `sha=`, GitLab `sha=`), so a
// head that moves after the gates refuses instead of merging unverified code.
// --delete-branch deletes with a lease on that same SHA.
import { requireGrant, type AutonomySource } from "../autonomy";
import { isProtectedTarget } from "../core/branch";
import { vcsConfig } from "../core/vcs-config";
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
};

/**
 * `--fill`: the title and body from the branch's commits on top of the base
 * (fetched first). One commit gives its subject and body; several give the
 * oldest subject and a list of every subject.
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
      return { subject: subject.trim(), body: body.trim() };
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
    body: commits.map((commit) => `- ${commit.subject}`).join("\n"),
  });
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
  return success({
    number: ref.number,
    url: ref.url,
    branch,
    base: input.base,
    head: sha,
    created,
    draft: input.draft,
    recorded: row.ok ? { id: String(row.value.id) } : { error: row.error },
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
  grant: { source: AutonomySource };
  deletedBranch: boolean | { error: string };
  recorded: { id: string } | { error: string };
};

/** Why `pr merge` refused, for the envelope `data` (agents branch on `reason`). */
export type MergeRefusal = {
  reason:
    | "grant_required"
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

const NEXT_HINTS: Record<string, string> = {
  RESOLVE_CONFLICTS: "rebase onto the base, resolve, then workit git push --force-with-lease",
  REBASE: "rebase onto the base, then workit git push --force-with-lease",
  RESOLVE_THREADS: "address and resolve the open review threads (workit pr status lists them)",
  FIX_CI:
    "fix the failing checks (workit pr status shows the log tails), push, then workit ci wait",
  WAITING_CI: "workit ci wait",
  ADDRESS_REVIEW: "address the requested changes",
  REVIEW: "get the required review",
  MARK_READY: "mark the PR ready for review",
  IN_MERGE_QUEUE: "the PR is already in the merge queue",
  NOT_MERGEABLE: "workit pr status  # the forge reports it cannot merge yet",
};

export async function mergePullRequest(
  cwd: string,
  resolved: ResolvedForge,
  input: MergeInput,
  sleep: Sleep,
): Promise<MergeResult> {
  const grant = requireGrant(cwd, "merge");
  if (!grant.allowed) return refuse(grant.error, grant.unblock, { reason: "grant_required" });

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
      NEXT_HINTS[doc.next] ?? "workit pr status",
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
  let verdict: MergeOutcome["verdict"] = {
    required: grant.requireVerdict,
    accepted: false,
    verdictId: null,
  };
  if (grant.requireVerdict) {
    const ledger = readLedger(cwd);
    if (!ledger.ok) return ledger;
    const check = checkVerdicts(cwd, branch, ledger.value.rows);
    const summary = { head: check.head, accepted: check.accepted, authors: check.authors };
    if (check.head !== head)
      return refuse(
        `head_mismatch: the verdict check reads ${branch} at ${check.head?.slice(0, 12) ?? "(missing)"} but ${label} is at ${head.slice(0, 12)}`,
        `git fetch && git switch ${branch} && git merge --ff-only @{u}  # then re-verify that head`,
        { reason: "head_mismatch", verdict: summary },
      );
    if (!check.accepted.accepted)
      return refuse(
        `NEEDS_VERDICT: ${label} has no accepted independent verdict for ${head.slice(0, 12)} (${check.accepted.reasons.join(", ")})`,
        `an independent session verifies the head and runs: workit ledger verdict verified --how "<what was exercised>" --branch ${branch}`,
        { reason: "needs_verdict", verdict: summary },
      );
    verdict = {
      required: true,
      accepted: true,
      verdictId: typeof check.accepted.verdict?.id === "string" ? check.accepted.verdict.id : null,
    };
  }

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
      grant: { source: grant.source },
      deletedBranch,
      recorded: row.ok ? { id: String(row.value.id) } : { error: row.error },
    },
  };
}
