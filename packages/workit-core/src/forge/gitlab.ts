// GitLab adapter: `glab api` REST only (design §2.0 GitLab endpoints): the MR
// (`detailed_merge_status`, `has_conflicts`, `head_pipeline`), pipeline jobs,
// job traces, discussions, and pipeline/job retry.
import { apiJson, apiText, FORGE_TIMEOUTS, type ForgeRunner } from "./exec";
import { logTail, shortBody } from "./redact";
import {
  failure,
  success,
  type Forge,
  type ForgeCheck,
  type ForgePrStatus,
  type ForgeResult,
  type ForgeThread,
  type PrState,
} from "./types";

/** Page cap for jobs and discussions (100 per page). */
export const GITLAB_MAX_PAGES = 10;
const PER_PAGE = 100;

type GlUser = { username?: string; bot?: boolean } | null;

type GlMr = {
  iid: number;
  web_url: string;
  state: string;
  draft?: boolean;
  work_in_progress?: boolean;
  detailed_merge_status?: string;
  has_conflicts?: boolean;
  target_branch: string;
  source_branch: string;
  sha: string;
  diff_refs?: { base_sha?: string | null } | null;
  head_pipeline?: { id: number; sha: string; project_id: number; status: string } | null;
};

type GlJob = {
  id: number;
  name: string;
  stage: string;
  status: string;
  allow_failure?: boolean;
  web_url?: string;
};

type GlNote = {
  id: number;
  body: string;
  author: GlUser;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  position?: {
    new_path?: string | null;
    new_line?: number | null;
    old_path?: string | null;
  } | null;
};

type GlDiscussion = { id: string; notes: GlNote[] };

const mrState = (value: string): PrState =>
  value === "merged" ? "merged" : value === "opened" ? "open" : "closed";

const PENDING = new Set([
  "created",
  "pending",
  "running",
  "waiting_for_resource",
  "waiting_for_callback",
  "preparing",
  "scheduled",
]);

export function checkFromJob(job: GlJob, pipelineId: number, scope: string): ForgeCheck {
  const failed = job.status === "failed" || job.status === "canceled";
  return {
    name: `${job.stage} / ${job.name}`,
    state: PENDING.has(job.status)
      ? "pending"
      : failed
        ? job.allow_failure
          ? "passing"
          : "failing"
        : job.status === "success"
          ? "passing"
          : "skipped",
    conclusion: failed && job.allow_failure ? "allowed_failure" : job.status,
    url: job.web_url ?? null,
    runId: pipelineId,
    jobId: job.id,
    scope,
  };
}

const isBot = (author: GlUser): boolean =>
  author?.bot === true || /(?:^project_\d+_bot|bot$|\[bot\]$)/iu.test(author?.username ?? "");

// Statuses where GitLab has not finished computing mergeability.
const UNSETTLED = new Set(["checking", "unchecked", "preparing", "approvals_syncing"]);

export function createGitLabForge(options: {
  apiHost: string;
  repo: string;
  runner: ForgeRunner;
  maxPages?: number;
}): Forge {
  const { apiHost, repo, runner } = options;
  const maxPages = options.maxPages ?? GITLAB_MAX_PAGES;
  const project = `projects/${encodeURIComponent(repo)}`;

  const api = (endpoint: string): string[] => ["api", endpoint];

  /** Every page of a list endpoint, up to the cap. */
  const pages = (
    endpoint: string,
    what: string,
  ): ForgeResult<{ items: unknown[]; truncated: boolean }> => {
    const items: unknown[] = [];
    const sep = endpoint.includes("?") ? "&" : "?";
    for (let page = 1; page <= maxPages; page += 1) {
      const chunk = apiJson<unknown>(
        runner,
        "glab",
        apiHost,
        api(`${endpoint}${sep}per_page=${PER_PAGE}&page=${page}`),
        what,
      );
      if (!chunk.ok) return chunk;
      if (!Array.isArray(chunk.data)) return failure("failed", `${what}: expected a list`);
      items.push(...chunk.data);
      if (chunk.data.length < PER_PAGE) return success({ items, truncated: false });
    }
    return success({ items, truncated: true });
  };

  return {
    kind: "gitlab",
    apiHost,
    repo,

    identity(expected) {
      const user = apiJson<{ username?: unknown }>(runner, "glab", apiHost, api("user"), "user");
      if (!user.ok) return user;
      const login = typeof user.data.username === "string" ? user.data.username : "";
      if (!login) return failure("failed", "glab api user returned no username");
      return success({
        login,
        expected,
        matches: expected ? login.toLowerCase() === expected.toLowerCase() : null,
      });
    },

    findPr(head) {
      const list = apiJson<GlMr[]>(
        runner,
        "glab",
        apiHost,
        api(
          `${project}/merge_requests?source_branch=${encodeURIComponent(head)}&order_by=created_at&sort=desc&per_page=20`,
        ),
        `merge requests for ${head}`,
      );
      if (!list.ok) return list;
      if (!Array.isArray(list.data)) return failure("failed", "merge request list is not a list");
      const matches = list.data.filter((mr) => mr.source_branch === head);
      const pick = matches.find((mr) => mr.state === "opened") ?? matches[0];
      return success(
        pick
          ? {
              number: pick.iid,
              url: pick.web_url,
              state: mrState(pick.state),
              headBranch: pick.source_branch,
            }
          : null,
      );
    },

    prStatus(iid) {
      const mr = apiJson<GlMr>(
        runner,
        "glab",
        apiHost,
        api(`${project}/merge_requests/${iid}`),
        `merge request !${iid}`,
      );
      if (!mr.ok) return mr;
      const value = mr.data;
      let truncated = false;
      let checks: ForgeCheck[] = [];
      const pipeline = value.head_pipeline ?? null;
      // A pipeline for an older head says nothing about the current one.
      if (pipeline && pipeline.sha === value.sha) {
        const scope = String(pipeline.project_id);
        const jobs = pages(
          `projects/${scope}/pipelines/${pipeline.id}/jobs`,
          `pipeline ${pipeline.id} jobs`,
        );
        if (!jobs.ok) return jobs;
        truncated ||= jobs.data.truncated;
        checks = (jobs.data.items as GlJob[]).map((job) => checkFromJob(job, pipeline.id, scope));
      }
      const discussions = pages(
        `${project}/merge_requests/${iid}/discussions`,
        `merge request !${iid} discussions`,
      );
      if (!discussions.ok) return discussions;
      truncated ||= discussions.data.truncated;
      const threads: ForgeThread[] = (discussions.data.items as GlDiscussion[])
        .filter((discussion) =>
          discussion.notes.some((note) => note.resolvable === true && note.resolved !== true),
        )
        .map((discussion) => {
          const note = discussion.notes[0];
          return {
            id: discussion.id,
            path: note.position?.new_path ?? note.position?.old_path ?? null,
            line: note.position?.new_line ?? null,
            author: note.author?.username ?? null,
            isBot: isBot(note.author),
            outdated: false,
            url: `${value.web_url}#note_${note.id}`,
            body: shortBody(note.body ?? ""),
          };
        });
      const detailed = value.detailed_merge_status ?? "unchecked";
      const conflicts = value.has_conflicts === true || detailed === "conflict";
      const status: ForgePrStatus = {
        number: value.iid,
        url: value.web_url,
        state: mrState(value.state),
        draft: value.draft ?? value.work_in_progress ?? false,
        base: value.target_branch,
        baseSha: value.diff_refs?.base_sha ?? null,
        head: { branch: value.source_branch, sha: value.sha },
        mergeable: conflicts ? "no" : UNSETTLED.has(detailed) ? "unknown" : "yes",
        conflicts,
        rebaseRequired: detailed === "need_rebase",
        reviewDecision:
          detailed === "not_approved"
            ? "review_required"
            : detailed === "requested_changes"
              ? "changes_requested"
              : null,
        checks,
        threads,
        truncated,
      };
      return success(status);
    },

    jobLogTail(job, lines) {
      const scope = job.scope ?? encodeURIComponent(repo);
      const text = apiText(
        runner,
        "glab",
        apiHost,
        ["api", `projects/${scope}/jobs/${job.jobId}/trace`],
        `job ${job.jobId} trace`,
        FORGE_TIMEOUTS.log,
      );
      return text.ok ? success(logTail(text.data, lines)) : text;
    },

    rerun(target) {
      const scope = target.scope ?? encodeURIComponent(repo);
      const endpoint =
        target.kind === "failed_in_run"
          ? `projects/${scope}/pipelines/${target.runId}/retry`
          : `projects/${scope}/jobs/${target.jobId}/retry`;
      const what =
        target.kind === "failed_in_run"
          ? `retry of pipeline ${target.runId}`
          : `retry of job ${target.jobId}`;
      const run = apiText(
        runner,
        "glab",
        apiHost,
        ["api", "-X", "POST", endpoint],
        what,
        FORGE_TIMEOUTS.api,
      );
      return run.ok ? success(undefined) : run;
    },
  };
}
