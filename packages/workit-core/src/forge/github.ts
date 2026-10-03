// GitHub adapter: `gh api graphql` for PR state, checks and review threads,
// `gh api` REST for job logs and reruns (design §2.0 GitHub endpoints).
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
  type PrRef,
  type PrState,
} from "./types";

/** Page cap for review threads and check contexts (100 per page). */
export const GITHUB_MAX_PAGES = 10;

const PR_FIELDS = `number url state isDraft mergeable mergeStateStatus baseRefName baseRefOid headRefName headRefOid reviewDecision`;

const THREADS = `reviewThreads(first: 100, after: $threads) { pageInfo { hasNextPage endCursor } nodes { id isResolved isOutdated path line comments(first: 1) { nodes { author { login __typename } body url } } } }`;

const CONTEXTS = `contexts(first: 100, after: $contexts) { pageInfo { hasNextPage endCursor } nodes { __typename ... on CheckRun { name status conclusion detailsUrl databaseId checkSuite { workflowRun { databaseId workflow { name } } } } ... on StatusContext { context state targetUrl } } }`;

export const PR_STATUS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $threads: String, $contexts: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PR_FIELDS} ${THREADS} commits(last: 1) { nodes { commit { oid statusCheckRollup { state ${CONTEXTS} } } } } } } }`;

export const FIND_PR_QUERY = `query($owner: String!, $name: String!, $head: String!) { repository(owner: $owner, name: $name) { pullRequests(headRefName: $head, first: 20, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { number url state headRefName headRepositoryOwner { login } } } } }`;

type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] };

type GqlThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: {
    nodes: Array<{
      author: { login: string; __typename: string } | null;
      body: string;
      url: string;
    }>;
  };
};

type GqlContext =
  | {
      __typename: "CheckRun";
      name: string;
      status: string;
      conclusion: string | null;
      detailsUrl: string | null;
      databaseId: number | null;
      checkSuite: {
        workflowRun: { databaseId: number; workflow: { name: string } | null } | null;
      } | null;
    }
  | { __typename: "StatusContext"; context: string; state: string; targetUrl: string | null };

type GqlPr = {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  baseRefName: string;
  baseRefOid: string | null;
  headRefName: string;
  headRefOid: string;
  reviewDecision: string | null;
  reviewThreads: Page<GqlThread>;
  commits: {
    nodes: Array<{
      commit: {
        oid: string;
        statusCheckRollup: { state: string; contexts: Page<GqlContext> } | null;
      };
    }>;
  };
};

type GqlResponse<T> = { data?: T; errors?: Array<{ message?: string; type?: string }> };

const prState = (value: string): PrState =>
  value === "MERGED" ? "merged" : value === "CLOSED" ? "closed" : "open";

// GitHub Actions conclusions that fail a PR. NEUTRAL/SKIPPED/SUCCESS pass;
// STALE is superseded by a newer run and is ignored.
const FAILING = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

export function checkFromContext(node: GqlContext): ForgeCheck | null {
  if (node.__typename === "StatusContext") {
    const state = node.state.toUpperCase();
    return {
      name: node.context,
      state:
        state === "SUCCESS"
          ? "passing"
          : state === "FAILURE" || state === "ERROR"
            ? "failing"
            : "pending",
      conclusion: state.toLowerCase(),
      url: node.targetUrl,
      runId: null,
      jobId: null,
      scope: null,
    };
  }
  if (node.conclusion === "STALE") return null;
  const run = node.checkSuite?.workflowRun ?? null;
  const workflow = run?.workflow?.name;
  const completed = node.status === "COMPLETED";
  const conclusion = node.conclusion?.toUpperCase() ?? null;
  return {
    name: workflow ? `${workflow} / ${node.name}` : node.name,
    state: !completed
      ? "pending"
      : conclusion && FAILING.has(conclusion)
        ? "failing"
        : conclusion === "SKIPPED" || conclusion === "NEUTRAL"
          ? "skipped"
          : "passing",
    conclusion: completed ? (conclusion?.toLowerCase() ?? null) : node.status.toLowerCase(),
    url: node.detailsUrl,
    runId: run?.databaseId ?? null,
    // Only Actions check runs have a job log behind their database id.
    jobId: run ? (node.databaseId ?? null) : null,
    scope: null,
  };
}

/** One check per name: a re-run check replaces its earlier attempt. */
export function latestPerName(checks: readonly ForgeCheck[]): ForgeCheck[] {
  const byName = new Map<string, ForgeCheck>();
  for (const check of checks) {
    const seen = byName.get(check.name);
    if (!seen || (check.jobId ?? 0) >= (seen.jobId ?? 0)) byName.set(check.name, check);
  }
  return [...byName.values()];
}

function threadFrom(node: GqlThread): ForgeThread {
  const first = node.comments.nodes[0];
  return {
    id: node.id,
    path: node.path,
    line: node.line,
    author: first?.author?.login ?? null,
    isBot: first?.author?.__typename === "Bot",
    outdated: node.isOutdated,
    url: first?.url ?? null,
    body: shortBody(first?.body ?? ""),
  };
}

export function createGitHubForge(options: {
  apiHost: string;
  repo: string;
  runner: ForgeRunner;
  maxPages?: number;
}): Forge {
  const { apiHost, repo, runner } = options;
  const maxPages = options.maxPages ?? GITHUB_MAX_PAGES;
  const [owner, name] = repo.split("/");

  const graphql = <T>(
    query: string,
    variables: Record<string, string | number | null>,
    what: string,
  ): ForgeResult<T> => {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [key, value] of Object.entries(variables)) {
      if (value === null) continue;
      args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
    }
    const response = apiJson<GqlResponse<T>>(
      runner,
      "gh",
      apiHost,
      args,
      what,
      FORGE_TIMEOUTS.api,
      { graphql: true },
    );
    if (!response.ok) return response;
    if (response.data.errors?.length) {
      const message = response.data.errors[0]?.message ?? "GraphQL error";
      return /could not resolve to a (pullrequest|repository)/iu.test(message)
        ? failure("not_found", `${what}: ${message}`)
        : failure("failed", `${what}: ${message}`);
    }
    if (!response.data.data) return failure("failed", `${what}: empty GraphQL response`);
    return success(response.data.data);
  };

  const fetchPr = (
    number: number,
    cursors: { threads: string | null; contexts: string | null },
  ): ForgeResult<GqlPr> => {
    const data = graphql<{ repository: { pullRequest: GqlPr | null } | null }>(
      PR_STATUS_QUERY,
      { owner, name, number, threads: cursors.threads, contexts: cursors.contexts },
      `pull request #${number}`,
    );
    if (!data.ok) return data;
    const pr = data.data.repository?.pullRequest;
    return pr ? success(pr) : failure("not_found", `pull request #${number} was not found`);
  };

  return {
    kind: "github",
    apiHost,
    repo,

    identity(expected) {
      const user = apiJson<{ login?: unknown }>(runner, "gh", apiHost, ["api", "user"], "user");
      if (!user.ok) return user;
      const login = typeof user.data.login === "string" ? user.data.login : "";
      if (!login) return failure("failed", "gh api user returned no login");
      return success({
        login,
        expected,
        matches: expected ? login.toLowerCase() === expected.toLowerCase() : null,
      });
    },

    findPr(head) {
      const data = graphql<{
        repository: {
          pullRequests: {
            nodes: Array<{
              number: number;
              url: string;
              state: string;
              headRefName: string;
              headRepositoryOwner: { login: string } | null;
            }>;
          };
        } | null;
      }>(FIND_PR_QUERY, { owner, name, head }, `pull requests for ${head}`);
      if (!data.ok) return data;
      const nodes = data.data.repository?.pullRequests.nodes ?? [];
      // Same-repo heads first (a fork can reuse the branch name), open first.
      const ranked = nodes
        .filter((node) => node.headRefName === head)
        .toSorted(
          (a, b) =>
            Number(b.headRepositoryOwner?.login === owner) -
              Number(a.headRepositoryOwner?.login === owner) ||
            Number(b.state === "OPEN") - Number(a.state === "OPEN"),
        );
      const pick = ranked[0];
      if (!pick) return success(null);
      const ref: PrRef = {
        number: pick.number,
        url: pick.url,
        state: prState(pick.state),
        headBranch: pick.headRefName,
      };
      return success(ref);
    },

    prStatus(number) {
      const first = fetchPr(number, { threads: null, contexts: null });
      if (!first.ok) return first;
      const pr = first.data;
      const threads = [...pr.reviewThreads.nodes];
      const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup ?? null;
      const contexts = [...(rollup?.contexts.nodes ?? [])];
      let threadPage = pr.reviewThreads.pageInfo;
      let contextPage = rollup?.contexts.pageInfo ?? { hasNextPage: false, endCursor: null };
      let pages = 1;
      // Each follow-up query advances whichever list still has pages.
      while ((threadPage.hasNextPage || contextPage.hasNextPage) && pages < maxPages) {
        pages += 1;
        const next = fetchPr(number, {
          threads: threadPage.hasNextPage ? threadPage.endCursor : null,
          contexts: contextPage.hasNextPage ? contextPage.endCursor : null,
        });
        if (!next.ok) return next;
        if (next.data.headRefOid !== pr.headRefOid)
          return failure("failed", `pull request #${number} head moved while paging; retry`);
        if (threadPage.hasNextPage) {
          threads.push(...next.data.reviewThreads.nodes);
          threadPage = next.data.reviewThreads.pageInfo;
        }
        const nextRollup = next.data.commits.nodes[0]?.commit.statusCheckRollup;
        if (contextPage.hasNextPage && nextRollup) {
          contexts.push(...nextRollup.contexts.nodes);
          contextPage = nextRollup.contexts.pageInfo;
        }
      }
      const checks = latestPerName(
        contexts.map(checkFromContext).filter((check): check is ForgeCheck => check !== null),
      );
      const status: ForgePrStatus = {
        number: pr.number,
        url: pr.url,
        state: prState(pr.state),
        draft: pr.isDraft,
        base: pr.baseRefName,
        baseSha: pr.baseRefOid,
        head: { branch: pr.headRefName, sha: pr.headRefOid },
        mergeable:
          pr.mergeable === "MERGEABLE" ? "yes" : pr.mergeable === "CONFLICTING" ? "no" : "unknown",
        conflicts: pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY",
        // BEHIND: branch protection requires an up-to-date head and it is not.
        rebaseRequired: pr.mergeStateStatus === "BEHIND",
        reviewDecision: pr.reviewDecision?.toLowerCase() ?? null,
        checks,
        threads: threads.filter((node) => !node.isResolved).map(threadFrom),
        truncated: threadPage.hasNextPage || contextPage.hasNextPage,
      };
      return success(status);
    },

    jobLogTail(job, lines) {
      const text = apiText(
        runner,
        "gh",
        apiHost,
        ["api", `repos/${repo}/actions/jobs/${job.jobId}/logs`],
        `job ${job.jobId} log`,
        FORGE_TIMEOUTS.log,
      );
      return text.ok ? success(logTail(text.data, lines)) : text;
    },

    rerun(target) {
      const endpoint =
        target.kind === "failed_in_run"
          ? `repos/${repo}/actions/runs/${target.runId}/rerun-failed-jobs`
          : `repos/${repo}/actions/jobs/${target.jobId}/rerun`;
      const what =
        target.kind === "failed_in_run"
          ? `rerun of run ${target.runId}`
          : `rerun of job ${target.jobId}`;
      const run = apiText(
        runner,
        "gh",
        apiHost,
        ["api", "-X", "POST", endpoint],
        what,
        FORGE_TIMEOUTS.api,
      );
      return run.ok ? success(undefined) : run;
    },
  };
}
