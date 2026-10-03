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

export type PrRef = { number: number; url: string; state: PrState; headBranch: string };

/** One CI check (GitHub check run / commit status, GitLab job). */
export type ForgeCheck = {
  /** `<workflow> / <job>` on GitHub, `<stage> / <job>` on GitLab, or the status context. */
  name: string;
  state: "failing" | "pending" | "passing" | "skipped";
  /** The forge's own verdict, lower-cased (failure, timed_out, failed, canceled…). */
  conclusion: string | null;
  url: string | null;
  /** GitHub workflow run id / GitLab pipeline id. */
  runId: number | null;
  /** GitHub Actions job id / GitLab job id; null for external statuses. */
  jobId: number | null;
  /** GitLab: the project that owns the pipeline (forks run elsewhere). */
  scope: string | null;
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
  /** The base tip the forge reports (GitLab diff_refs.base_sha, GitHub baseRefOid). */
  baseSha: string | null;
  head: { branch: string; sha: string };
  mergeable: "yes" | "no" | "unknown";
  conflicts: boolean;
  /** Branch protection requires the head to be up to date and it is not. */
  rebaseRequired: boolean;
  /** approved | changes_requested | review_required | null. */
  reviewDecision: string | null;
  checks: ForgeCheck[];
  threads: ForgeThread[];
  /** True when a list was cut at the page cap (the counts are lower bounds). */
  truncated: boolean;
};

export type JobRef = { jobId: number; scope: string | null };

export type RerunTarget =
  | { kind: "failed_in_run"; runId: number; scope: string | null }
  | { kind: "job"; jobId: number; scope: string | null };

export type Identity = { login: string; expected: string | null; matches: boolean | null };

export interface Forge {
  kind: ForgeKind;
  apiHost: string;
  repo: string;
  identity(expected: string | null): ForgeResult<Identity>;
  findPr(head: string): ForgeResult<PrRef | null>;
  prStatus(n: number): ForgeResult<ForgePrStatus>;
  jobLogTail(job: JobRef, lines: number): ForgeResult<string[]>;
  rerun(target: RerunTarget): ForgeResult<void>;
}
