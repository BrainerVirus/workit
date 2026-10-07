// GitHub adapter: `gh api graphql` for PR state, checks and review threads,
// `gh api` REST for required checks, job logs and reruns (design §2.0).
import { apiJson, apiText, apiWrite, cliFailure, FORGE_TIMEOUTS, type ForgeRunner } from "./exec";
import { logTail, redactText, shortBody } from "./redact";
import {
  failure,
  success,
  type Forge,
  type ForgeCheck,
  type ForgePrStatus,
  type ForgeResult,
  type ForgeThread,
  type PrMeta,
  type PrRef,
  type PrState,
} from "./types";

/** Page cap for review threads and check contexts (100 per page). */
export const GITHUB_MAX_PAGES = 10;

const PR_FIELDS = `number url state isDraft isInMergeQueue mergeable mergeStateStatus baseRefName baseRefOid baseRef { target { oid } } headRefName headRefOid reviewDecision`;

const THREADS = `reviewThreads(first: 100, after: $threads) { pageInfo { hasNextPage endCursor } nodes { id isResolved isOutdated path line comments(first: 1) { nodes { author { login __typename } body url } } } }`;

// isRequired: only checks branch protection requires gate the merge.
const CONTEXTS = `contexts(first: 100, after: $contexts) { pageInfo { hasNextPage endCursor } nodes { __typename ... on CheckRun { name status conclusion detailsUrl databaseId isRequired(pullRequestNumber: $number) checkSuite { workflowRun { databaseId workflow { name } } } } ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) } } }`;

export const PR_STATUS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $threads: String, $contexts: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PR_FIELDS} ${THREADS} commits(last: 1) { nodes { commit { oid statusCheckRollup { state ${CONTEXTS} } } } } } } }`;

export const FIND_PR_QUERY = `query($owner: String!, $name: String!, $head: String!) { repository(owner: $owner, name: $name) { pullRequests(headRefName: $head, first: 20, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { number url state headRefName headRefOid headRepositoryOwner { login } } } } }`;

const READY_MUTATION = `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`;
const DRAFT_MUTATION = `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`;
const REPLY_MUTATION = `mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { url } } }`;
const RESOLVE_MUTATION = `mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { isResolved } } }`;

type RestPr = {
  number?: number;
  html_url?: string;
  node_id?: string;
  state?: string;
  merged?: boolean;
  draft?: boolean;
  title?: string;
  base?: { ref?: string };
  head?: { ref?: string };
};

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
      isRequired?: boolean | null;
      checkSuite: {
        workflowRun: { databaseId: number; workflow: { name: string } | null } | null;
      } | null;
    }
  | {
      __typename: "StatusContext";
      context: string;
      state: string;
      targetUrl: string | null;
      isRequired?: boolean | null;
    };

type GqlPr = {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  isInMergeQueue?: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  baseRefName: string;
  /** baseRefOid is the base at the PR's last sync; baseRef.target is the live tip. */
  baseRefOid: string | null;
  baseRef?: { target: { oid: string } | null } | null;
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

const safeUrl = (value: string | null): string | null => (value ? redactText(value) : null);

export function checkFromContext(node: GqlContext): ForgeCheck | null {
  const required = node.isRequired ?? null;
  if (node.__typename === "StatusContext") {
    const state = node.state.toUpperCase();
    return {
      name: node.context,
      context: node.context,
      state:
        state === "SUCCESS"
          ? "passing"
          : state === "FAILURE" || state === "ERROR"
            ? "failing"
            : "pending",
      conclusion: state.toLowerCase(),
      url: safeUrl(node.targetUrl),
      runId: null,
      jobId: null,
      scope: null,
      required,
    };
  }
  if (node.conclusion === "STALE") return null;
  const run = node.checkSuite?.workflowRun ?? null;
  const workflow = run?.workflow?.name;
  const completed = node.status === "COMPLETED";
  const conclusion = node.conclusion?.toUpperCase() ?? null;
  return {
    name: workflow ? `${workflow} / ${node.name}` : node.name,
    context: node.name,
    state: !completed
      ? "pending"
      : conclusion && FAILING.has(conclusion)
        ? "failing"
        : conclusion === "SKIPPED" || conclusion === "NEUTRAL"
          ? "skipped"
          : "passing",
    conclusion: completed ? (conclusion?.toLowerCase() ?? null) : node.status.toLowerCase(),
    url: safeUrl(node.detailsUrl),
    runId: run?.databaseId ?? null,
    // Only Actions check runs have a job log behind their database id.
    jobId: run ? (node.databaseId ?? null) : null,
    scope: null,
    required,
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
    url: safeUrl(first?.url ?? null),
    body: shortBody(first?.body ?? ""),
  };
}

const encodeRef = (ref: string): string => ref.split("/").map(encodeURIComponent).join("/");

export function createGitHubForge(options: {
  apiHost: string;
  repo: string;
  runner: ForgeRunner;
  maxPages?: number;
}): Forge {
  const { apiHost, repo, runner } = options;
  const maxPages = options.maxPages ?? GITHUB_MAX_PAGES;
  const [owner, name] = repo.split("/");

  const rest = <T>(endpoint: string, what: string): ForgeResult<T> =>
    apiJson<T>(runner, "gh", apiHost, ["api", endpoint], what);

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
      const message = redactText(response.data.errors[0]?.message ?? "GraphQL error").slice(0, 300);
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

  /**
   * Contexts the base branch requires: classic branch protection (readable
   * through the branch endpoint without admin) plus branch rulesets. Null
   * when either source could not be read.
   */
  const requiredContexts = (base: string): string[] | null => {
    const branch = rest<{
      protected?: boolean;
      protection?: {
        required_status_checks?: { contexts?: string[]; checks?: Array<{ context?: string }> };
      };
    }>(`repos/${repo}/branches/${encodeRef(base)}`, `branch ${base}`);
    const rules = rest<Array<{ type?: string; parameters?: Record<string, unknown> }>>(
      `repos/${repo}/rules/branches/${encodeRef(base)}`,
      `rules for ${base}`,
    );
    if (!branch.ok || !rules.ok || !Array.isArray(rules.data)) return null;
    const contexts = new Set<string>();
    const classic = branch.data.protection?.required_status_checks;
    for (const context of classic?.contexts ?? []) contexts.add(context);
    for (const check of classic?.checks ?? []) if (check.context) contexts.add(check.context);
    for (const rule of rules.data)
      if (rule.type === "required_status_checks") {
        const listed = rule.parameters?.required_status_checks;
        if (Array.isArray(listed))
          for (const item of listed as Array<{ context?: unknown }>)
            if (typeof item.context === "string") contexts.add(item.context);
      }
    return [...contexts];
  };

  const restPr = (number: number): ForgeResult<RestPr> => {
    const pr = rest<RestPr>(`repos/${repo}/pulls/${number}`, `pull request #${number}`);
    if (!pr.ok) return pr;
    return typeof pr.data.number === "number"
      ? pr
      : failure("failed", `gh api pulls/${number} returned no pull request`);
  };

  return {
    kind: "github",
    apiHost,
    repo,

    identity(expected) {
      const run = runner("gh", ["api", "user"], { timeoutMs: FORGE_TIMEOUTS.api });
      if (run.status !== 0) {
        // App/Actions installation tokens cannot read /user; the token is
        // still valid for reads, so the check is skipped, not failed.
        if (/HTTP 403|resource not accessible by integration/iu.test(run.stderr))
          return success({
            login: null,
            expected,
            matches: null,
            note: "the credential cannot read /user (app or Actions token); identity not checked",
          });
        return cliFailure("gh", apiHost, run, "user", FORGE_TIMEOUTS.api);
      }
      let login = "";
      try {
        const user = JSON.parse(run.stdout) as { login?: unknown };
        login = typeof user.login === "string" ? user.login : "";
      } catch {
        // handled below
      }
      if (!login) return failure("failed", "gh api user returned no login");
      return success({
        login,
        expected,
        matches: expected ? login.toLowerCase() === expected.toLowerCase() : null,
      });
    },

    repoInfo(target) {
      const info = rest<{ id?: number; fork?: boolean; parent?: { full_name?: string } }>(
        `repos/${target}`,
        `repository ${target}`,
      );
      if (!info.ok) return info;
      return success({
        id: typeof info.data.id === "number" ? info.data.id : null,
        parent: info.data.fork && info.data.parent?.full_name ? info.data.parent.full_name : null,
      });
    },

    findPr(head, match) {
      const data = graphql<{
        repository: {
          pullRequests: {
            nodes: Array<{
              number: number;
              url: string;
              state: string;
              headRefName: string;
              headRefOid: string | null;
              headRepositoryOwner: { login: string } | null;
            }>;
          };
        } | null;
      }>(FIND_PR_QUERY, { owner, name, head }, `pull requests for ${head}`);
      if (!data.ok) return data;
      const nodes = data.data.repository?.pullRequests.nodes ?? [];
      // A branch name alone proves nothing: anyone can open a PR from a
      // same-named branch in their fork. The head owner or head sha must match.
      const ours = nodes.filter(
        (node) =>
          node.headRefName === head &&
          ((match.owner !== null &&
            node.headRepositoryOwner?.login.toLowerCase() === match.owner.toLowerCase()) ||
            (match.sha !== null && node.headRefOid === match.sha)),
      );
      const pick = ours.find((node) => node.state === "OPEN") ?? ours[0];
      if (!pick) return success(null);
      const ref: PrRef = {
        number: pick.number,
        url: pick.url,
        state: prState(pick.state),
        headBranch: pick.headRefName,
        headSha: pick.headRefOid,
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
      const open = pr.state === "OPEN";
      const status: ForgePrStatus = {
        number: pr.number,
        url: pr.url,
        state: prState(pr.state),
        draft: pr.isDraft,
        base: pr.baseRefName,
        baseSha: pr.baseRef?.target?.oid ?? pr.baseRefOid,
        head: { branch: pr.headRefName, sha: pr.headRefOid },
        mergeable:
          pr.mergeable === "MERGEABLE" ? "yes" : pr.mergeable === "CONFLICTING" ? "no" : "unknown",
        conflicts: pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY",
        // BEHIND: branch protection requires an up-to-date head and it is not.
        rebaseRequired: pr.mergeStateStatus === "BEHIND",
        reviewDecision: pr.reviewDecision?.toLowerCase() ?? null,
        mergeState: pr.mergeStateStatus?.toLowerCase() ?? null,
        inMergeQueue: pr.isInMergeQueue === true,
        checks,
        requiredContexts: open ? requiredContexts(pr.baseRefName) : null,
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

    createPr(input) {
      // Cross-repository PRs name the head as owner:branch.
      const headOwner = input.headRepo.split("/")[0];
      const head = input.headRepo === repo ? input.head : `${headOwner}:${input.head}`;
      const created = apiWrite<{
        number?: number;
        html_url?: string;
        state?: string;
        merged?: boolean;
        head?: { ref?: string; sha?: string };
      }>(
        runner,
        "gh",
        apiHost,
        [
          "api",
          "-X",
          "POST",
          `repos/${repo}/pulls`,
          "-f",
          `title=${input.title}`,
          "-f",
          `head=${head}`,
          "-f",
          `base=${input.base}`,
          "-f",
          `body=${input.body}`,
          "-F",
          `draft=${input.draft ? "true" : "false"}`,
        ],
        `pull request for ${input.head}`,
      );
      if (!created.ok) return created;
      const value = created.data;
      if (typeof value.number !== "number" || typeof value.html_url !== "string")
        return failure("failed", "gh api pulls returned no pull request number");
      return success({
        number: value.number,
        url: value.html_url,
        state: value.merged ? "merged" : value.state === "closed" ? "closed" : "open",
        headBranch: value.head?.ref ?? input.head,
        headSha: value.head?.sha ?? null,
      });
    },

    merge(number, mergeOptions) {
      // sha= is GitHub's atomic head guard: 409 when the head moved.
      const merged = apiWrite<{ sha?: string; merged?: boolean; message?: string }>(
        runner,
        "gh",
        apiHost,
        [
          "api",
          "-X",
          "PUT",
          `repos/${repo}/pulls/${number}/merge`,
          "-f",
          `sha=${mergeOptions.sha}`,
          "-f",
          `merge_method=${mergeOptions.method}`,
        ],
        `merge of pull request #${number}`,
      );
      if (!merged.ok) return merged;
      if (merged.data.merged === false)
        return failure(
          "blocked",
          `merge of pull request #${number} refused: ${redactText(merged.data.message ?? "not merged").slice(0, 200)}`,
        );
      return success({ mergeSha: typeof merged.data.sha === "string" ? merged.data.sha : null });
    },

    updateBase(number, base) {
      const updated = apiWrite<unknown>(
        runner,
        "gh",
        apiHost,
        ["api", "-X", "PATCH", `repos/${repo}/pulls/${number}`, "-f", `base=${base}`],
        `retarget of pull request #${number}`,
      );
      return updated.ok ? success(undefined) : updated;
    },

    prMeta(number) {
      const pr = restPr(number);
      if (!pr.ok) return pr;
      const value = pr.data;
      const meta: PrMeta = {
        number,
        url: value.html_url ?? "",
        state: value.merged ? "merged" : value.state === "closed" ? "closed" : "open",
        draft: value.draft === true,
        title: value.title ?? "",
        base: value.base?.ref ?? "",
        headBranch: value.head?.ref ?? "",
      };
      return success(meta);
    },

    setDraft(number, draft) {
      const pr = restPr(number);
      if (!pr.ok) return pr;
      if (!pr.data.node_id) return failure("failed", `pull request #${number} has no node id`);
      const done = graphql<unknown>(
        draft ? DRAFT_MUTATION : READY_MUTATION,
        { id: pr.data.node_id },
        draft ? `draft conversion of pull request #${number}` : `ready of pull request #${number}`,
      );
      return done.ok ? success(undefined) : done;
    },

    editPr(number, edit) {
      const write = (args: string[], what: string): ForgeResult<unknown> =>
        apiWrite<unknown>(runner, "gh", apiHost, ["api", ...args], what);
      const fields: string[] = [];
      if (edit.title !== undefined) fields.push("-f", `title=${edit.title}`);
      if (edit.body !== undefined) fields.push("-f", `body=${edit.body}`);
      if (edit.base !== undefined) fields.push("-f", `base=${edit.base}`);
      if (fields.length) {
        const patched = write(
          ["-X", "PATCH", `repos/${repo}/pulls/${number}`, ...fields],
          `edit of pull request #${number}`,
        );
        if (!patched.ok) return patched;
      }
      if (edit.addLabels.length) {
        const added = write(
          [
            "-X",
            "POST",
            `repos/${repo}/issues/${number}/labels`,
            ...edit.addLabels.flatMap((label) => ["-f", `labels[]=${label}`]),
          ],
          `labels of pull request #${number}`,
        );
        if (!added.ok) return added;
      }
      for (const label of edit.removeLabels) {
        const removed = write(
          ["-X", "DELETE", `repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`],
          `label ${label} of pull request #${number}`,
        );
        // A label the PR does not carry is already removed.
        if (!removed.ok && removed.code !== "not_found") return removed;
      }
      if (edit.addReviewers.length) {
        // org/team requests a team; anything else is a login.
        const requested = write(
          [
            "-X",
            "POST",
            `repos/${repo}/pulls/${number}/requested_reviewers`,
            ...edit.addReviewers.flatMap((reviewer) =>
              reviewer.includes("/")
                ? ["-f", `team_reviewers[]=${reviewer.split("/").pop()}`]
                : ["-f", `reviewers[]=${reviewer}`],
            ),
          ],
          `reviewers of pull request #${number}`,
        );
        if (!requested.ok) return requested;
      }
      return success(undefined);
    },

    replyThread(number, thread, body) {
      const replied = graphql<{
        addPullRequestReviewThreadReply?: { comment?: { url?: string } | null } | null;
      }>(REPLY_MUTATION, { thread, body }, `reply on pull request #${number}`);
      if (!replied.ok) return replied;
      return success({
        url: safeUrl(replied.data.addPullRequestReviewThreadReply?.comment?.url ?? null),
      });
    },

    resolveThread(number, thread) {
      const resolved = graphql<{
        resolveReviewThread?: { thread?: { isResolved?: boolean } | null } | null;
      }>(RESOLVE_MUTATION, { thread }, `resolve on pull request #${number}`);
      if (!resolved.ok) return resolved;
      return resolved.data.resolveReviewThread?.thread?.isResolved === true
        ? success(undefined)
        : failure("failed", `thread ${thread} on pull request #${number} is still unresolved`);
    },
  };
}
