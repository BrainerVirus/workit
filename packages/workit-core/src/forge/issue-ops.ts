// `workit issue view|comment|close|create` (#439, retro W2.11): issue writes
// through Workit, so an agent never needs a raw `gh issue close` the host's
// permission mode blocks.
//
// Where: `--repo` (another repository on this forge host), else the
// workspace tracker (`issues.provider` github or gitlab, its `issues.repo`)
// when it is on this checkout's forge host, else the forge's own base
// repository. YouTrack and another host are refused: no account is
// verified there. Every write needs the `pr` grant (the forge-write grant
// `pr edit|reply` use) and leaves an `issue.*` ledger row.
import { requireGrant } from "../autonomy";
import { forgeTarget } from "../core/remotes";
import { vcsConfig, type IssueTracker } from "../core/vcs-config";
import { currentBranch, headSha } from "../git/rev";
import { appendObserved, type LedgerActor } from "../ledger";
import {
  githubIssues,
  gitlabIssues,
  type ForgeIssue,
  type IssueApi,
  type IssueCloseReason,
} from "./issue-forge";
import type { ResolvedForge } from "./resolve";
import { failure, success, type ForgeResult } from "./types";

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

function trackerOf(cwd: string): IssueTracker | null {
  const resolved = vcsConfig("resolve", cwd);
  if (resolved.ok === false) return null;
  return (resolved.issue_tracker as IssueTracker | null | undefined) ?? null;
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
    if (!/^\w[\w.-]*(?:\/\w[\w.-]*)+$/u.test(options.repo))
      return failure(
        "invalid_input",
        `--repo is owner/name or group/project, not "${options.repo}"`,
      );
    return make(options.repo);
  }
  const tracker = options.tracker === undefined ? trackerOf(cwd) : options.tracker;
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
  return decision.allowed
    ? success(undefined)
    : failure("blocked", decision.error, decision.unblock);
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
  const recorded = record(cwd, api, input.actor, {
    type: "issue.commented",
    issue: input.number,
    url,
  });
  return success({ number: input.number, url, recorded });
}

export type CloseOutcome = {
  number: number;
  url: string | null;
  reason: IssueCloseReason;
  /** False when the issue was already closed: nothing was posted. */
  changed: boolean;
  commentUrl: string | null;
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
      recorded: null,
    });
  let commentUrl: string | null = null;
  if (input.comment !== null) {
    const posted = postComment(api, issue.data, input.comment);
    if (!posted.ok) return posted;
    commentUrl = posted.data.url;
  }
  const closed = api.close(input.number, input.reason);
  if (!closed.ok) return closed;
  const after = api.view(input.number);
  if (!after.ok) return after;
  if (after.data.state !== "closed")
    return failure(
      "failed",
      `close_unverified: the forge accepted the close but issue #${input.number} still reads open`,
      `workit issue view ${input.number}`,
    );
  const recorded = record(cwd, api, input.actor, {
    type: "issue.closed",
    issue: input.number,
    url: issue.data.url,
    reason: input.reason,
    commentUrl,
  });
  return success({ ...base, changed: true, commentUrl, recorded });
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
