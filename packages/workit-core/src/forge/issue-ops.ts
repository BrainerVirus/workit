// `workit issue view|comment|close|create` (#439, retro W2.11): issue writes
// through Workit, so an agent never needs a raw `gh issue close` the host's
// permission mode blocks.
//
// Where: `--repo` (another repository on this forge host), else the
// workspace tracker (`issues.provider` github or gitlab, its `issues.repo`)
// when it is on this checkout's forge host, else the forge's own base
// repository. YouTrack and another host are refused: no account is
// verified there. Every write needs the `pr` grant (the forge-write grant
// `pr edit|reply` use) and leaves an `issue.*` ledger row. A `--repo` write
// outside the workspace's forge owners also needs the repository in the
// entry's `externalRepos` (#882).
import { createHash } from "node:crypto";
import { externalReposPolicy, requireGrant, targetClaims } from "../autonomy";
import { forgeTarget } from "../core/remotes";
import { vcsConfig, type IssueTracker } from "../core/vcs-config";
import { currentBranch, headSha } from "../git/rev";
import { appendObserved, readLedger, type LedgerActor } from "../ledger";
import {
  githubIssues,
  gitlabIssues,
  type ForgeIssue,
  type IssueApi,
  type IssueCloseReason,
} from "./issue-forge";
import type { ResolvedForge } from "./resolve";
import { failure, success, type ForgeErrorCode, type ForgeResult } from "./types";

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

function trackerOf(cwd: string): IssueTracker | null {
  const resolved = vcsConfig("resolve", cwd);
  if (resolved.ok === false) return null;
  return (resolved.issue_tracker as IssueTracker | null | undefined) ?? null;
}

const ownerOf = (repo: string): string => repo.split("/")[0].toLowerCase();

/** Whether `owner/name` or `owner/*` in `patterns` names `repo`. */
const listed = (patterns: readonly string[], repo: string): boolean =>
  patterns.some((pattern) => {
    const [want, have] = [pattern.toLowerCase(), repo.toLowerCase()];
    return want.endsWith("/*") ? have.startsWith(want.slice(0, -1)) : want === have;
  });

/**
 * Why a write to `--repo` is refused (#882), undefined when it is in scope:
 * the owner of this checkout's forge or push repository, of the workspace
 * tracker on this host, or the workspace's `vcs.account`; a repository the
 * workspace's `remotes` claims; or one its sealed `externalRepos` lists.
 */
function outsideOwners(
  cwd: string,
  resolved: ResolvedForge,
  repo: string,
  tracker: IssueTracker | null,
): IssueApi["outside"] {
  const { kind, apiHost } = resolved.forge;
  const owners = new Set<string>();
  // Outside a checkout (no push remote) the forge is --repo itself: no owner from it.
  if (resolved.remote) {
    owners.add(ownerOf(resolved.forge.repo));
    owners.add(ownerOf(resolved.headRepo));
  }
  if (tracker?.repo && tracker.provider === kind && (!tracker.host || same(tracker.host, apiHost)))
    owners.add(ownerOf(tracker.repo));
  if (resolved.expectedAccount?.trim()) owners.add(resolved.expectedAccount.trim().toLowerCase());
  if (owners.has(ownerOf(repo))) return undefined;
  const claims = resolved.workspace ? targetClaims(forgeTarget(apiHost, repo)) : [];
  if (!(claims instanceof Error) && claims.some((claim) => claim.workspace === resolved.workspace))
    return undefined;
  const policy = externalReposPolicy(cwd);
  if (listed(policy.repos, repo)) return undefined;
  const workspace = policy.workspace ?? resolved.workspace;
  const list = JSON.stringify([...policy.repos, repo]);
  return {
    error: `outside_owner: ${repo} is outside this workspace's forge owners (${[...owners].join(", ") || "none"}) and no externalRepos grant names it; workit never writes issues there on its own`,
    unblock: workspace
      ? `only if the user wants issues written there: ask them to run, in their own terminal outside the agent host: workit workspace set ${workspace} externalRepos='${list}'${policy.sealed ? "" : ", then workit workspace seal"}`
      : `run it from a folder a workspace covers, whose entry lists ${repo} in externalRepos (the user sets it: workit workspace set <workspace> externalRepos='${list}')`,
  };
}

/** The issue API for this checkout: the workspace tracker's repository, else the forge's. */
export function issueTarget(
  cwd: string,
  resolved: ResolvedForge,
  options: { repo?: string | null; tracker?: IssueTracker | null } = {},
): ForgeResult<IssueApi> {
  const { kind, apiHost } = resolved.forge;
  const make = (repo: string) => {
    const api = { apiHost, repo, runner: resolved.runner };
    return success(kind === "github" ? githubIssues(api) : gitlabIssues(api));
  };
  // `--repo`: another repository on this forge host, under the same verified account.
  if (options.repo) {
    // The owner has no dot, so a host (`gitlab.com/o/r`) is never read as one.
    if (!/^[\w-]+(?:\/\w[\w.-]*)+$/u.test(options.repo))
      return failure(
        "invalid_input",
        `--repo is owner/name or group/project on this forge host, without the host: not "${options.repo}"`,
      );
  }
  const tracker = options.tracker === undefined ? trackerOf(cwd) : options.tracker;
  if (options.repo) {
    const api = make(options.repo);
    const outside = outsideOwners(cwd, resolved, options.repo, tracker);
    if (api.ok && outside) api.data.outside = outside;
    return api;
  }
  if (tracker?.provider === "youtrack")
    return failure(
      "blocked",
      "issues.provider is youtrack: workit issue drives GitHub and GitLab issues",
      "workit youtrack note <ID> --text <t>",
    );
  if (tracker && tracker.provider !== kind)
    return failure(
      "blocked",
      `issues.provider is ${tracker.provider} but this checkout's forge is ${kind}: no account is verified there`,
    );
  if (tracker?.host && !same(tracker.host, apiHost))
    return failure(
      "blocked",
      `issues.host ${tracker.host} is not this checkout's forge host ${apiHost}: no account is verified there`,
    );
  return make(tracker?.repo ?? resolved.forge.repo);
}

const grant = (cwd: string, api: IssueApi): ForgeResult<void> => {
  const decision = requireGrant(cwd, "pr", {
    target: forgeTarget(api.apiHost, api.repo),
  });
  if (!decision.allowed) return failure("blocked", decision.error, decision.unblock);
  return api.outside
    ? failure("blocked", api.outside.error, api.outside.unblock)
    : success(undefined);
};

export type Recorded = { id: string } | { error: string };

const record = (
  cwd: string,
  api: IssueApi,
  actor: LedgerActor,
  row: Record<string, unknown> & { type: string },
): Recorded => {
  const written = appendObserved(cwd, {
    ...row,
    actor,
    branch: currentBranch(cwd),
    head: headSha(cwd),
    forge: api.kind,
    repo: api.repo,
  });
  return written.ok ? { id: String(written.value.id) } : { error: written.error };
};

/** The issue, refused when it is closed and the caller needs it open. */
const openIssue = (api: IssueApi, n: number, alternative: string): ForgeResult<ForgeIssue> => {
  const issue = api.view(n);
  if (!issue.ok) return issue;
  if (issue.data.state === "closed")
    return failure("blocked", `closed: issue #${n} is closed`, alternative);
  return issue;
};

/** Post a comment; its URL, or (GitLab) the issue URL with the note's anchor. */
const postComment = (
  api: IssueApi,
  issue: ForgeIssue,
  body: string,
): ForgeResult<{ url: string | null }> => {
  const posted = api.comment(issue.number, body);
  if (!posted.ok) return posted;
  const { url, id } = posted.data;
  return success({ url: url ?? (issue.url && id ? `${issue.url}#note_${id}` : null) });
};

const bodyHash = (body: string): string =>
  createHash("sha256").update(body.trim()).digest("hex").slice(0, 32);

const recordComment = (
  cwd: string,
  api: IssueApi,
  actor: LedgerActor,
  issue: number,
  body: string,
  url: string | null,
): Recorded =>
  record(cwd, api, actor, { type: "issue.commented", issue, url, bodyHash: bodyHash(body) });

/**
 * The URL of the same comment this session already posted on the issue
 * (an `issue.commented` row), so a retried close never posts it twice;
 * undefined when there is none or the session is unknown.
 */
function postedBefore(
  cwd: string,
  api: IssueApi,
  actor: LedgerActor,
  issue: number,
  body: string,
): { url: string | null } | undefined {
  if (!actor.session) return undefined;
  const ledger = readLedger(cwd);
  if (!ledger.ok) return undefined;
  const hash = bodyHash(body);
  const row = ledger.value.rows.findLast((candidate) => {
    const value = candidate as unknown as Record<string, unknown>;
    return (
      value.type === "issue.commented" &&
      value.forge === api.kind &&
      value.repo === api.repo &&
      value.issue === issue &&
      value.bodyHash === hash &&
      candidate.actor.session === actor.session
    );
  }) as unknown as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return { url: typeof row.url === "string" ? row.url : null };
}

export type CommentOutcome = {
  number: number;
  url: string | null;
  recorded: Recorded;
};

/**
 * Comment on issue `n`. With `requireOpen` a closed issue is refused and
 * that text is the unblock (the queue path: file a new issue instead).
 */
export function commentOnIssue(
  cwd: string,
  api: IssueApi,
  input: {
    number: number;
    body: string;
    actor: LedgerActor;
    requireOpen?: string;
  },
): ForgeResult<CommentOutcome> {
  const allowed = grant(cwd, api);
  if (!allowed.ok) return allowed;
  const issue =
    input.requireOpen === undefined
      ? api.view(input.number)
      : openIssue(api, input.number, input.requireOpen);
  if (!issue.ok) return issue;
  const posted = postComment(api, issue.data, input.body);
  if (!posted.ok) return posted;
  const { url } = posted.data;
  const recorded = recordComment(cwd, api, input.actor, input.number, input.body, url);
  return success({ number: input.number, url, recorded });
}

export type CloseOutcome = {
  number: number;
  url: string | null;
  reason: IssueCloseReason;
  /** False when the issue was already closed: nothing was posted. */
  changed: boolean;
  commentUrl: string | null;
  /** posted now, already posted by this session (a retry), or none asked. */
  comment: "posted" | "already_posted" | "none";
  recorded: Recorded | null;
};

/** Close issue `n` with a reason and an optional comment posted first; verified after. */
export function closeIssue(
  cwd: string,
  api: IssueApi,
  input: {
    number: number;
    reason: IssueCloseReason;
    comment: string | null;
    actor: LedgerActor;
  },
): ForgeResult<CloseOutcome> {
  const allowed = grant(cwd, api);
  if (!allowed.ok) return allowed;
  const issue = api.view(input.number);
  if (!issue.ok) return issue;
  const base = {
    number: input.number,
    url: issue.data.url,
    reason: input.reason,
  };
  if (issue.data.state === "closed")
    return success({
      ...base,
      changed: false,
      commentUrl: null,
      comment: "none",
      recorded: null,
    });
  let commentUrl: string | null = null;
  let comment: CloseOutcome["comment"] = "none";
  if (input.comment !== null) {
    const before = postedBefore(cwd, api, input.actor, input.number, input.comment);
    if (before) {
      commentUrl = before.url;
      comment = "already_posted";
    } else {
      const posted = postComment(api, issue.data, input.comment);
      if (!posted.ok) return posted;
      commentUrl = posted.data.url;
      comment = "posted";
      // Recorded at once: a failed close below must not lose it, and a retry reads it.
      recordComment(cwd, api, input.actor, input.number, input.comment, commentUrl);
    }
  }
  // After a posted comment, a failure says so and the retry needs no --comment.
  const stillOpen = (code: ForgeErrorCode, error: string): ForgeResult<CloseOutcome> =>
    comment === "none"
      ? failure(code, error, `workit issue view ${input.number}`)
      : failure(
          code,
          `${error}; the comment is posted${commentUrl ? ` (${commentUrl})` : ""} and issue #${input.number} is still open`,
          `workit issue close ${input.number} --reason ${input.reason}  # no --comment: it is posted; or workit issue view ${input.number}`,
        );
  const closed = api.close(input.number, input.reason);
  if (!closed.ok) return stillOpen(closed.code, closed.error);
  const after = api.view(input.number);
  if (!after.ok) return after;
  if (after.data.state !== "closed")
    return stillOpen(
      "failed",
      `close_unverified: the forge accepted the close but issue #${input.number} still reads open`,
    );
  const recorded = record(cwd, api, input.actor, {
    type: "issue.closed",
    issue: input.number,
    url: issue.data.url,
    reason: input.reason,
    commentUrl,
  });
  return success({ ...base, changed: true, commentUrl, comment, recorded });
}

export type CreateOutcome = {
  number: number;
  url: string | null;
  recorded: Recorded;
};

export function createIssue(
  cwd: string,
  api: IssueApi,
  input: { title: string; body: string; labels: string[]; actor: LedgerActor },
): ForgeResult<CreateOutcome> {
  if (!input.title.trim()) return failure("invalid_input", "an issue needs a title");
  const allowed = grant(cwd, api);
  if (!allowed.ok) return allowed;
  const created = api.create({
    title: input.title,
    body: input.body,
    labels: input.labels,
  });
  if (!created.ok) return created;
  const recorded = record(cwd, api, input.actor, {
    type: "issue.created",
    issue: created.data.number,
    url: created.data.url,
    labels: input.labels,
  });
  return success({ ...created.data, recorded });
}
