// Forge-neutral shapes for the GitHub and GitLab adapters (design §2.0, S10).
// Plain TS: the CLI verbs load this on their path.
import type { ForgeKind } from "../git/rev";

export type { ForgeKind };

export type ForgeErrorCode =
  | "unavailable"
  | "not_found"
  | "failed"
  | "blocked"
  | "busy"
  | "invalid_input";

export type ForgeResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ForgeErrorCode; error: string; unblock?: string };

export const success = <T>(data: T): ForgeResult<T> => ({ ok: true, data });

export const failure = <T = never>(
  code: ForgeErrorCode,
  error: string,
  unblock?: string,
): ForgeResult<T> => ({ ok: false, code, error, ...(unblock ? { unblock } : {}) });

export type PrState = "open" | "closed" | "merged";

export type PrRef = {
  number: number;
  url: string;
  state: PrState;
  headBranch: string;
  headSha: string | null;
};

/** How a branch-name lookup proves a PR is ours (M5): head owner/project or head sha. */
export type PrMatch = {
  /** GitHub: the head repository owner (the push repo's owner). */
  owner: string | null;
  /** GitLab: the source project id (the push project). */
  projectId: number | null;
  /** A PR whose head is exactly this commit is ours whatever its owner. */
  sha: string | null;
};

/** One CI check (GitHub check run / commit status, GitLab job or bridge). */
export type ForgeCheck = {
  /** `<workflow> / <job>` on GitHub, `<stage> / <job>` on GitLab, or the status context. */
  name: string;
  /** The raw context/job name branch protection refers to. */
  context: string;
  state: "failing" | "pending" | "passing" | "skipped";
  /** The forge's own verdict, lower-cased (failure, timed_out, failed, canceled…). */
  conclusion: string | null;
  url: string | null;
  /** GitHub workflow run id / GitLab pipeline id. */
  runId: number | null;
  /** GitHub Actions job id / GitLab job id; null for external statuses and bridges. */
  jobId: number | null;
  /** GitLab: the project that owns the pipeline (forks run elsewhere). */
  scope: string | null;
  /** Required by branch protection (GitHub isRequired); null when the forge cannot say. */
  required: boolean | null;
};

export type ForgeThread = {
  id: string;
  path: string | null;
  line: number | null;
  author: string | null;
  isBot: boolean;
  outdated: boolean;
  url: string | null;
  /** First comment, redacted and cut to 300 chars. Untrusted data. */
  body: string;
};

export type ForgePrStatus = {
  number: number;
  url: string;
  state: PrState;
  draft: boolean;
  base: string;
  /** The current tip of the base branch, from the API. */
  baseSha: string | null;
  head: { branch: string; sha: string };
  mergeable: "yes" | "no" | "unknown";
  conflicts: boolean;
  /** Branch protection requires the head to be up to date and it is not. */
  rebaseRequired: boolean;
  /** approved | changes_requested | review_required | null. */
  reviewDecision: string | null;
  /** GitHub mergeStateStatus / GitLab detailed_merge_status, lower-cased. */
  mergeState: string | null;
  inMergeQueue: boolean;
  checks: ForgeCheck[];
  /**
   * Contexts branch protection requires (GitHub branch protection +
   * rulesets); null when they could not be read.
   */
  requiredContexts: string[] | null;
  threads: ForgeThread[];
  /** True when a list was cut at the page cap (the counts are lower bounds). */
  truncated: boolean;
};

export type JobRef = { jobId: number; scope: string | null };

export type RerunTarget =
  | { kind: "failed_in_run"; runId: number; scope: string | null }
  | { kind: "job"; jobId: number; scope: string | null };

export type Identity = {
  login: string | null;
  expected: string | null;
  matches: boolean | null;
  /** Why the login could not be checked (e.g. an app token without /user). */
  note?: string;
};

export type MergeMethod = "squash" | "merge" | "rebase";

/** What `workit pr create` asks the forge for (S11). */
export type CreatePrInput = {
  /** Source branch in the push (head) repository. */
  head: string;
  /** owner/name (GitHub) or group/project (GitLab) of the push repository. */
  headRepo: string;
  /** GitLab: the push project id (MRs from a fork are opened from it). */
  headProjectId: number | null;
  base: string;
  title: string;
  body: string;
  draft: boolean;
};

export type MergeResult = {
  /** The merge (or squash/rebase tip) commit the forge reported, when it did. */
  mergeSha: string | null;
};

/** The editable fields of a PR/MR (`workit pr ready|edit`). */
export type PrMeta = {
  number: number;
  url: string;
  state: PrState;
  draft: boolean;
  title: string;
  base: string;
  headBranch: string;
};

/** What `workit pr edit` changes; unset fields are left alone. */
export type PrEdit = {
  title?: string;
  body?: string;
  base?: string;
  addLabels: string[];
  removeLabels: string[];
  /** Logins; on GitHub `org/team` requests a team. */
  addReviewers: string[];
};

/** A repository as the forge sees it: id and the repo it was forked from. */
export type RepoInfo = { id: number | null; parent: string | null };

export interface Forge {
  kind: ForgeKind;
  apiHost: string;
  /** The base repository PRs/MRs live in. */
  repo: string;
  identity(expected: string | null): ForgeResult<Identity>;
  repoInfo(repo: string): ForgeResult<RepoInfo>;
  findPr(head: string, match: PrMatch): ForgeResult<PrRef | null>;
  prStatus(n: number): ForgeResult<ForgePrStatus>;
  jobLogTail(job: JobRef, lines: number): ForgeResult<string[]>;
  rerun(target: RerunTarget): ForgeResult<void>;
  /** Open a PR/MR; `headSha` is the head the forge reports right after creation. */
  createPr(input: CreatePrInput): ForgeResult<PrRef>;
  /**
   * Merge with the head guard: the forge refuses (`blocked`, head_moved) when
   * the PR head is no longer `sha`.
   */
  merge(n: number, options: { sha: string; method: MergeMethod }): ForgeResult<MergeResult>;
  /** Retarget a PR/MR to another base branch (S12 stacks). */
  updateBase(n: number, base: string): ForgeResult<void>;
  /** Title, draft flag, base and state of one PR/MR. */
  prMeta(n: number): ForgeResult<PrMeta>;
  /** Mark a draft ready (`draft: false`) or convert it back to a draft. */
  setDraft(n: number, draft: boolean): ForgeResult<void>;
  editPr(n: number, edit: PrEdit): ForgeResult<void>;
  /** Reply to a review thread (GitHub review thread id, GitLab discussion id). */
  replyThread(n: number, thread: string, body: string): ForgeResult<{ url: string | null }>;
  resolveThread(n: number, thread: string): ForgeResult<void>;
  /** One review thread of PR `n` read directly: null when it is not on that PR. */
  threadState(n: number, thread: string): ForgeResult<"open" | "resolved" | null>;
}
