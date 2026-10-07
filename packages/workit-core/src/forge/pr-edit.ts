// `workit pr ready|edit|threads|reply` (audit M13): the PR lifecycle steps
// `pr status` prescribes, so an agent never reaches for gh/glab directly.
//
// Every write needs the `pr` grant and an open PR/MR. `edit --base` retargets
// only to the branch's default target or to a branch the workspace policy does
// not protect, so a feature PR is never pointed at a production branch by an
// edit. `reply` and `resolve` act only on a thread `pr status` lists as
// unresolved on that PR, so a stray id never lands on another PR.
import { requireGrant } from "../autonomy";
import { isProtectedTarget } from "../core/branch";
import { vcsConfig } from "../core/vcs-config";
import { selectPr } from "./report";
import type { ResolvedForge } from "./resolve";
import {
  failure,
  success,
  type ForgeResult,
  type ForgeThread,
  type PrEdit,
  type PrMeta,
} from "./types";

const label = (resolved: ResolvedForge, number: number): string =>
  `${resolved.forge.kind === "github" ? "PR #" : "MR !"}${number}`;

/** The grant, the PR number and its metadata; refuses a closed or merged PR. */
function openPr(cwd: string, resolved: ResolvedForge, pr: number | null): ForgeResult<PrMeta> {
  const grant = requireGrant(cwd, "pr");
  if (!grant.allowed) return failure("blocked", grant.error, grant.unblock);
  const number = selectPr(cwd, resolved, { pr });
  if (!number.ok) return number;
  const meta = resolved.forge.prMeta(number.data);
  if (!meta.ok) return meta;
  if (meta.data.state !== "open")
    return failure(
      "blocked",
      `${meta.data.state}: ${label(resolved, meta.data.number)} is ${meta.data.state}`,
      `workit pr status --pr ${meta.data.number}`,
    );
  return meta;
}

export type ReadyOutcome = { number: number; url: string; draft: boolean; changed: boolean };

/** Mark a draft ready for review, or (`undo`) convert it back to a draft; verified after. */
export function readyPullRequest(
  cwd: string,
  resolved: ResolvedForge,
  input: { pr: number | null; undo: boolean },
): ForgeResult<ReadyOutcome> {
  const meta = openPr(cwd, resolved, input.pr);
  if (!meta.ok) return meta;
  const { number, url } = meta.data;
  const want = input.undo;
  if (meta.data.draft === want) return success({ number, url, draft: want, changed: false });
  const set = resolved.forge.setDraft(number, want);
  if (!set.ok) return set;
  const after = resolved.forge.prMeta(number);
  if (!after.ok) return after;
  if (after.data.draft !== want)
    return failure(
      "failed",
      `ready_unverified: the forge accepted the change but ${label(resolved, number)} still reads ${after.data.draft ? "draft" : "ready"}`,
      `workit pr status --pr ${number}`,
    );
  return success({ number, url, draft: want, changed: true });
}

export type EditOutcome = {
  number: number;
  url: string;
  title: string;
  base: string;
  /** What was asked for, by field (title, body, base, labels, reviewers). */
  changed: string[];
};

/** Labels and reviewers are comma-free names (GitLab joins labels with commas). */
const badName = (values: readonly string[]): string | undefined =>
  values.find((value) => !value.trim() || value.includes(","));

export function editPullRequest(
  cwd: string,
  resolved: ResolvedForge,
  input: { pr: number | null; edit: PrEdit },
): ForgeResult<EditOutcome> {
  const { edit } = input;
  const changed = [
    ...(edit.title !== undefined ? ["title"] : []),
    ...(edit.body !== undefined ? ["body"] : []),
    ...(edit.base !== undefined ? ["base"] : []),
    ...(edit.addLabels.length || edit.removeLabels.length ? ["labels"] : []),
    ...(edit.addReviewers.length ? ["reviewers"] : []),
  ];
  if (!changed.length) return failure("invalid_input", "nothing to edit");
  if (edit.title !== undefined && !edit.title.trim())
    return failure("invalid_input", "--title must not be empty");
  const bad = badName([...edit.addLabels, ...edit.removeLabels, ...edit.addReviewers]);
  if (bad !== undefined) return failure("invalid_input", `invalid label or reviewer "${bad}"`);
  if (resolved.forge.kind === "gitlab" && edit.addReviewers.some((name) => name.includes("/")))
    return failure("invalid_input", "GitLab reviewers are usernames, not teams");

  const meta = openPr(cwd, resolved, input.pr);
  if (!meta.ok) return meta;
  const { number, headBranch } = meta.data;
  if (edit.base !== undefined) {
    const base = edit.base;
    if (base === headBranch)
      return failure("invalid_input", `${headBranch} cannot be its own base`);
    const config = vcsConfig("resolve", cwd, { branch: headBranch });
    const target = config.ok === false ? null : String(config.defaultTargetBranch ?? "") || null;
    if (base !== target && isProtectedTarget(cwd, base))
      return failure(
        "blocked",
        `protected_base: ${base} is protected by the workspace branch policy and is not ${headBranch}'s default target${target ? ` (${target})` : ""}; workit never retargets a PR onto it`,
        target
          ? `workit pr edit --pr ${number} --base ${target}  # or retarget it on the forge yourself`
          : "retarget it on the forge yourself",
      );
  }
  const done = resolved.forge.editPr(number, edit);
  if (!done.ok) return done;
  const after = resolved.forge.prMeta(number);
  if (!after.ok) return after;
  if (edit.base !== undefined && after.data.base !== edit.base)
    return failure(
      "failed",
      `edit_unverified: ${label(resolved, number)} still targets ${after.data.base}, not ${edit.base}`,
      `workit pr status --pr ${number}`,
    );
  return success({
    number,
    url: after.data.url,
    title: after.data.title,
    base: after.data.base,
    changed,
  });
}

export type ThreadsOutcome = {
  number: number;
  url: string;
  threads: ForgeThread[];
  truncated: boolean;
};

/** The PR's unresolved review threads (the ones `pr status` counts). Read-only. */
export function listThreads(
  cwd: string,
  resolved: ResolvedForge,
  input: { pr: number | null },
): ForgeResult<ThreadsOutcome> {
  const number = selectPr(cwd, resolved, { pr: input.pr });
  if (!number.ok) return number;
  const status = resolved.forge.prStatus(number.data);
  if (!status.ok) return status;
  return success({
    number: status.data.number,
    url: status.data.url,
    threads: status.data.threads,
    truncated: status.data.truncated,
  });
}

export type ReplyOutcome = {
  number: number;
  thread: string;
  replied: boolean;
  replyUrl: string | null;
  resolved: boolean;
};

/** Reply to and/or resolve one unresolved thread of the PR. */
export function replyToThread(
  cwd: string,
  resolved: ResolvedForge,
  input: { pr: number | null; thread: string; body: string | null; resolve: boolean },
): ForgeResult<ReplyOutcome> {
  if (input.body === null && !input.resolve)
    return failure("invalid_input", "pass --body-file <f> and/or --resolve");
  if (input.body !== null && !input.body.trim())
    return failure("invalid_input", "the reply body is empty");
  const meta = openPr(cwd, resolved, input.pr);
  if (!meta.ok) return meta;
  const { number } = meta.data;
  const status = resolved.forge.prStatus(number);
  if (!status.ok) return status;
  if (!status.data.threads.some((thread) => thread.id === input.thread))
    return failure(
      "not_found",
      `thread ${input.thread} is not an unresolved thread of ${label(resolved, number)}`,
      `workit pr threads --pr ${number}`,
    );
  let replyUrl: string | null = null;
  if (input.body !== null) {
    const replied = resolved.forge.replyThread(number, input.thread, input.body);
    if (!replied.ok) return replied;
    replyUrl = replied.data.url;
  }
  if (input.resolve) {
    const done = resolved.forge.resolveThread(number, input.thread);
    if (!done.ok)
      return input.body === null
        ? done
        : failure(done.code, `replied, but not resolved: ${done.error}`, done.unblock);
  }
  return success({
    number,
    thread: input.thread,
    replied: input.body !== null,
    replyUrl,
    resolved: input.resolve,
  });
}
