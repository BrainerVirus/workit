// Issue reads and writes on GitHub and GitLab for `workit issue` and
// `workit finding record --queue` (#439): one forge-neutral shape over
// `gh api` / `glab api`, on the workspace's verified credential.
import { apiJson, apiWrite, type ForgeRunner } from "./exec";
import { redactText } from "./redact";
import { failure, success, type ForgeKind, type ForgeResult } from "./types";

export type IssueCloseReason = "completed" | "not-planned";
export const ISSUE_CLOSE_REASONS: readonly IssueCloseReason[] = ["completed", "not-planned"];

export type ForgeIssue = {
  number: number;
  url: string | null;
  title: string;
  state: "open" | "closed";
  /** GitHub's close reason (completed, not_planned, reopened); null on GitLab. */
  stateReason: string | null;
  body: string;
  labels: string[];
};

export type CreateIssueInput = {
  title: string;
  body: string;
  labels: string[];
};

export interface IssueApi {
  kind: ForgeKind;
  apiHost: string;
  repo: string;
  /** One issue; `invalid_input` when the number is a PR/MR on GitHub. */
  view(n: number): ForgeResult<ForgeIssue>;
  /** Comment on issue `n`: the comment's URL (GitHub) or note id (GitLab: the URL is the issue's plus `#note_<id>`). */
  comment(n: number, body: string): ForgeResult<{ url: string | null; id: string | null }>;
  /** Close issue `n`; GitLab has no close reason and ignores it. */
  close(n: number, reason: IssueCloseReason): ForgeResult<void>;
  create(input: CreateIssueInput): ForgeResult<{ number: number; url: string | null }>;
}

type Options = { apiHost: string; repo: string; runner: ForgeRunner };

const safeUrl = (value: unknown): string | null =>
  typeof value === "string" && value ? redactText(value) : null;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function githubIssues({ apiHost, repo, runner }: Options): IssueApi {
  const write = <T>(args: string[], what: string) =>
    apiWrite<T>(runner, "gh", apiHost, ["api", ...args], what);
  return {
    kind: "github",
    apiHost,
    repo,
    view(n) {
      const read = apiJson<Record<string, unknown>>(
        runner,
        "gh",
        apiHost,
        ["api", `repos/${repo}/issues/${n}`],
        `issue #${n}`,
      );
      if (!read.ok) return read;
      const data = read.data;
      if (typeof data.number !== "number")
        return failure("failed", `gh api issues/${n} returned no issue`);
      if (data.pull_request)
        return failure(
          "invalid_input",
          `#${n} is a pull request, not an issue`,
          `workit pr status --pr ${n}`,
        );
      return success({
        number: data.number,
        url: safeUrl(data.html_url),
        title: text(data.title),
        state: data.state === "closed" ? "closed" : "open",
        stateReason: typeof data.state_reason === "string" ? data.state_reason : null,
        body: text(data.body),
        labels: Array.isArray(data.labels)
          ? data.labels.flatMap((label: { name?: unknown }) =>
              typeof label?.name === "string" ? [label.name] : [],
            )
          : [],
      });
    },
    comment(n, body) {
      const posted = write<{ html_url?: unknown }>(
        ["-X", "POST", `repos/${repo}/issues/${n}/comments`, "-f", `body=${body}`],
        `comment on issue #${n}`,
      );
      return posted.ok ? success({ url: safeUrl(posted.data?.html_url), id: null }) : posted;
    },
    close(n, reason) {
      const closed = write<unknown>(
        [
          "-X",
          "PATCH",
          `repos/${repo}/issues/${n}`,
          "-f",
          "state=closed",
          "-f",
          `state_reason=${reason === "not-planned" ? "not_planned" : "completed"}`,
        ],
        `close issue #${n}`,
      );
      return closed.ok ? success(undefined) : closed;
    },
    create(input) {
      const created = write<{ number?: unknown; html_url?: unknown }>(
        [
          "-X",
          "POST",
          `repos/${repo}/issues`,
          "-f",
          `title=${input.title}`,
          "-f",
          `body=${input.body}`,
          ...input.labels.flatMap((label) => ["-f", `labels[]=${label}`]),
        ],
        "create issue",
      );
      if (!created.ok) return created;
      if (typeof created.data?.number !== "number")
        return failure("failed", "gh api issues returned no issue number");
      return success({
        number: created.data.number,
        url: safeUrl(created.data.html_url),
      });
    },
  };
}

export function gitlabIssues({ apiHost, repo, runner }: Options): IssueApi {
  const project = `projects/${encodeURIComponent(repo)}`;
  const write = <T>(args: string[], what: string) =>
    apiWrite<T>(runner, "glab", apiHost, ["api", ...args], what);
  const view = (iid: number): ForgeResult<ForgeIssue> => {
    const read = apiJson<Record<string, unknown>>(
      runner,
      "glab",
      apiHost,
      ["api", `${project}/issues/${iid}`],
      `issue #${iid}`,
    );
    if (!read.ok) return read;
    const data = read.data;
    if (typeof data.iid !== "number")
      return failure("failed", `glab api issues/${iid} returned no issue`);
    return success({
      number: data.iid,
      url: safeUrl(data.web_url),
      title: text(data.title),
      state: data.state === "closed" ? "closed" : "open",
      stateReason: null,
      body: text(data.description),
      labels: Array.isArray(data.labels)
        ? data.labels.filter((label): label is string => typeof label === "string")
        : [],
    });
  };
  return {
    kind: "gitlab",
    apiHost,
    repo,
    view,
    comment(iid, body) {
      const posted = write<{ id?: unknown }>(
        ["-X", "POST", `${project}/issues/${iid}/notes`, "-f", `body=${body}`],
        `note on issue #${iid}`,
      );
      if (!posted.ok) return posted;
      const id = posted.data?.id;
      return success({
        url: null,
        id: typeof id === "number" ? String(id) : null,
      });
    },
    close(iid) {
      const closed = write<unknown>(
        ["-X", "PUT", `${project}/issues/${iid}`, "-f", "state_event=close"],
        `close issue #${iid}`,
      );
      return closed.ok ? success(undefined) : closed;
    },
    create(input) {
      const created = write<{ iid?: unknown; web_url?: unknown }>(
        [
          "-X",
          "POST",
          `${project}/issues`,
          "-f",
          `title=${input.title}`,
          "-f",
          `description=${input.body}`,
          ...(input.labels.length ? ["-f", `labels=${input.labels.join(",")}`] : []),
        ],
        "create issue",
      );
      if (!created.ok) return created;
      if (typeof created.data?.iid !== "number")
        return failure("failed", "glab api issues returned no issue iid");
      return success({
        number: created.data.iid,
        url: safeUrl(created.data.web_url),
      });
    },
  };
}
