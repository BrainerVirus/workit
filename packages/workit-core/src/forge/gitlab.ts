// GitLab adapter: `glab api` REST only (design §2.0 GitLab endpoints): the MR
// (`detailed_merge_status`, `has_conflicts`, `head_pipeline`), pipeline jobs,
// job traces, discussions, and pipeline/job retry.
import { apiJson, apiText, FORGE_TIMEOUTS, type ForgeRunner } from "./exec";
import { logTail, redactText, shortBody } from "./redact";
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
  source_project_id?: number;
  head_pipeline?: {
    id: number;
    sha: string;
    /** Merged-results / merge-train pipelines run on a merge ref; this is the MR head. */
    source_sha?: string | null;
    project_id: number;
    status: string;
    web_url?: string;
  } | null;
};

type GlBridge = {
  id: number;
  name: string;
  stage: string;
  status: string;
  allow_failure?: boolean;
  web_url?: string;
  downstream_pipeline?: {
    id: number;
    status: string;
    project_id?: number;
    web_url?: string;
  } | null;
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

const stateOf = (status: string, allowFailure: boolean): ForgeCheck["state"] => {
  const failed = status === "failed" || status === "canceled";
  return PENDING.has(status)
    ? "pending"
    : failed
      ? allowFailure
        ? "passing"
        : "failing"
      : status === "success"
        ? "passing"
        : "skipped";
};

/** A trigger/bridge job: its state is the downstream pipeline's. */
export function checkFromBridge(bridge: GlBridge, pipelineId: number, scope: string): ForgeCheck {
  const status = bridge.downstream_pipeline?.status ?? bridge.status;
  const allow = bridge.allow_failure === true;
  const failed = status === "failed" || status === "canceled";
  return {
    name: `${bridge.stage} / ${bridge.name}`,
    context: bridge.name,
    state: stateOf(status, allow),
    conclusion: failed && allow ? "allowed_failure" : `downstream_${status}`,
    url: safeUrl(bridge.downstream_pipeline?.web_url ?? bridge.web_url ?? null),
    runId: pipelineId,
    // Not a log-bearing job; rerun it on the downstream pipeline.
    jobId: null,
    scope,
    required: !allow,
  };
}

export function checkFromJob(job: GlJob, pipelineId: number, scope: string): ForgeCheck {
  const failed = job.status === "failed" || job.status === "canceled";
  return {
    name: `${job.stage} / ${job.name}`,
    context: job.name,
    state: stateOf(job.status, job.allow_failure === true),
    conclusion: failed && job.allow_failure ? "allowed_failure" : job.status,
    url: safeUrl(job.web_url ?? null),
    runId: pipelineId,
    jobId: job.id,
    scope,
    // Every job that may not fail gates the pipeline, which gates the MR.
    required: job.allow_failure !== true,
  };
}

/** A pipeline-level check when no job explains the pipeline's state. */
const pipelineCheck = (
  state: ForgeCheck["state"],
  conclusion: string,
  pipeline: { id: number; project_id: number; web_url?: string } | null,
): ForgeCheck => ({
  name: "pipeline",
  context: "pipeline",
  state,
  conclusion,
  url: safeUrl(pipeline?.web_url ?? null),
  runId: pipeline?.id ?? null,
  jobId: null,
  scope: pipeline ? String(pipeline.project_id) : null,
  required: true,
});

const safeUrl = (value: string | null): string | null => (value ? redactText(value) : null);

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

  /** The current tip of the target branch (diff_refs.base_sha is the merge base). */
  const baseTip = (branch: string): string | null => {
    const tip = apiJson<{ commit?: { id?: string } }>(
      runner,
      "glab",
      apiHost,
      api(`${project}/repository/branches/${encodeURIComponent(branch)}`),
      `branch ${branch}`,
    );
    return tip.ok && typeof tip.data.commit?.id === "string" ? tip.data.commit.id : null;
  };

  return {
    kind: "gitlab",
    apiHost,
    repo,

    identity(expected) {
      const user = apiJson<{ username?: unknown }>(runner, "glab", apiHost, api("user"), "user");
      // CI job tokens cannot read /user; reads still work, so skip the check.
      if (!user.ok && user.code === "failed" && /\b403\b|forbidden/iu.test(user.error))
        return success({
          login: null,
          expected,
          matches: null,
          note: "the credential cannot read /user (job or project token); identity not checked",
        });
      if (!user.ok) return user;
      const login = typeof user.data.username === "string" ? user.data.username : "";
      if (!login) return failure("failed", "glab api user returned no username");
      return success({
        login,
        expected,
        matches: expected ? login.toLowerCase() === expected.toLowerCase() : null,
      });
    },

    repoInfo(target) {
      const info = apiJson<{ id?: number; forked_from_project?: { path_with_namespace?: string } }>(
        runner,
        "glab",
        apiHost,
        api(`projects/${encodeURIComponent(target)}`),
        `project ${target}`,
      );
      if (!info.ok) return info;
      return success({
        id: typeof info.data.id === "number" ? info.data.id : null,
        parent: info.data.forked_from_project?.path_with_namespace ?? null,
      });
    },

    findPr(head, match) {
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
      // Same-named branches in other forks are not ours: match the source
      // project or the exact head sha.
      const matches = list.data.filter(
        (mr) =>
          mr.source_branch === head &&
          ((match.projectId !== null && mr.source_project_id === match.projectId) ||
            (match.sha !== null && mr.sha === match.sha)),
      );
      const pick = matches.find((mr) => mr.state === "opened") ?? matches[0];
      return success(
        pick
          ? {
              number: pick.iid,
              url: pick.web_url,
              state: mrState(pick.state),
              headBranch: pick.source_branch,
              headSha: pick.sha ?? null,
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
      const open = value.state === "opened";
      // Merged-results and merge-train pipelines run on a merge ref whose sha
      // is not the MR head; source_sha names the head they test.
      const current =
        pipeline !== null && (pipeline.sha === value.sha || pipeline.source_sha === value.sha);
      if (pipeline && current) {
        const scope = String(pipeline.project_id);
        const jobs = pages(
          `projects/${scope}/pipelines/${pipeline.id}/jobs`,
          `pipeline ${pipeline.id} jobs`,
        );
        if (!jobs.ok) return jobs;
        const bridges = pages(
          `projects/${scope}/pipelines/${pipeline.id}/bridges`,
          `pipeline ${pipeline.id} bridges`,
        );
        if (!bridges.ok) return bridges;
        truncated ||= jobs.data.truncated || bridges.data.truncated;
        checks = [
          ...(jobs.data.items as GlJob[]).map((job) => checkFromJob(job, pipeline.id, scope)),
          ...(bridges.data.items as GlBridge[]).map((bridge) =>
            checkFromBridge(bridge, pipeline.id, scope),
          ),
        ];
        // The pipeline status is a floor: a failed pipeline is never green,
        // and a running one is never done, whatever the visible jobs say.
        const pipelineState = stateOf(pipeline.status, false);
        if (pipelineState === "failing" && !checks.some((check) => check.state === "failing"))
          checks.push(pipelineCheck("failing", pipeline.status, pipeline));
        if (pipelineState === "pending" && !checks.some((check) => check.state === "pending"))
          checks.push(pipelineCheck("pending", pipeline.status, pipeline));
      } else if (open && pipeline) {
        // The head pipeline belongs to an older head: CI for this head has
        // not reported yet. Pending, never "no checks".
        checks = [pipelineCheck("pending", "awaiting_pipeline_for_head", null)];
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
            url: safeUrl(`${value.web_url}#note_${note.id}`),
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
        baseSha: open ? baseTip(value.target_branch) : null,
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
        mergeState: detailed,
        inMergeQueue: false,
        checks,
        // GitLab gates on the whole pipeline (jobs that may not fail).
        requiredContexts: [],
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
