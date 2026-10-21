// Issue links for `workit pr create` (#324): which issues a PR links, the body
// line each one gets, the `pr.linked` ledger rows, the optional tracker
// backlink, and the links `pr status` lists.
//
// Issues come from `--issue` (repeatable), else the fanout slice the branch
// belongs to (its `issue` field), else the branch name when the workspace
// tracker has `link: true`. `IRPT-74` and `.../issue/IRPT-74` are YouTrack;
// an issue URL names its own forge; `#42`, `42` and `owner/repo#42` are on
// the workspace tracker (`issues.provider` github or gitlab), else the PR's
// forge. An issue on the PR's own forge closes in its syntax (`Closes #42`,
// `Refs #42`, `Closes owner/repo#42`); one on another forge cannot close
// across forges and gets `Related to: <issue URL>`.
import { vcsConfig, type IssueTracker } from "../core/vcs-config";
import { youTrackBaseUrl } from "../core/youtrack";
import { defaultOperations, ISSUE_RE, unwrap } from "../core/youtrack-tools";
import { withMarker, writeOnce, youTrackMarker, type OnceOutcome } from "../core/youtrack-writes";
import { sliceIssuesFor } from "../fanout";
import { appendObserved, type LedgerActor, type ReadRow } from "../ledger";
import type { ForgeRunner } from "./exec";
import { createGitHubForge } from "./github";
import { createGitLabForge } from "./gitlab";
import { deriveGhIssueFromBranch, deriveYouTrackIssueFromBranch } from "./pr-body";
import type { ResolvedForge } from "./resolve";
import type { Forge } from "./types";

export type ForgeKind = "github" | "gitlab";
/** What the body line says: a closing keyword, a reference, or a cross-tracker "Related to". */
export type IssueRelation = "closes" | "refs" | "related";

/** The PR's forge: where a same-forge issue reference closes. */
export type PrForge = { kind: ForgeKind; repo: string; host: string };

export type IssueLink = {
  tracker: ForgeKind | "youtrack";
  /** The issue number on a forge, the issue id on YouTrack. */
  id: string;
  /** The issue's repository when it is not the PR's own, else null. */
  repo: string | null;
  /** The issue's forge host when it is not the PR's, else null. */
  host: string | null;
  /** The issue's web URL when it is on another host or tracker, else null. */
  url: string | null;
  relation: IssueRelation;
  source: "flag" | "fanout" | "branch";
  /** The line the PR body carries for it. */
  line: string;
};

export type IssueLinkPlan = {
  links: IssueLink[];
  /** The workspace tracker's `backlink`. */
  backlink: boolean;
  tracker: IssueTracker | null;
  /** Config read leniently, or a link that could not be derived. */
  warnings: string[];
};

/** An issue as named: its host and repo only when the name carries them. */
type NamedRef = {
  tracker: ForgeKind | "youtrack";
  id: string;
  repo: string | null;
  host: string | null;
};

const DEFAULT_HOST: Record<ForgeKind, string> = { github: "github.com", gitlab: "gitlab.com" };

const same = (left: string | null, right: string | null): boolean =>
  (left ?? "").toLowerCase() === (right ?? "").toLowerCase();

/**
 * One `--issue` value: `#42`, `42`, `owner/repo#42`, `IRPT-74` or an issue
 * URL. A bare or short form is an issue on `tracker`.
 */
export function parseIssueRef(
  raw: string,
  tracker: ForgeKind,
): { ok: true; ref: NamedRef } | { ok: false; error: string } {
  const value = raw.trim();
  if (ISSUE_RE.test(value))
    return { ok: true, ref: { tracker: "youtrack", id: value, repo: null, host: null } };
  const short = /^(?:([\w.-]+(?:\/[\w.-]+)+))?#?(\d+)$/u.exec(value);
  if (short && (short[1] === undefined || value.includes("#")))
    return { ok: true, ref: { tracker, id: short[2], repo: short[1] ?? null, host: null } };
  let url: URL | null = null;
  try {
    url = /^https?:\/\//iu.test(value) ? new URL(value) : null;
  } catch {
    url = null;
  }
  if (url) {
    const pathname = url.pathname.replace(/\/+$/u, "");
    const youtrack = /\/issues?\/([A-Z][A-Z0-9]*-\d+)(?:\/|$)/u.exec(pathname);
    if (youtrack && ISSUE_RE.test(youtrack[1]))
      return { ok: true, ref: { tracker: "youtrack", id: youtrack[1], repo: null, host: null } };
    const gitlab = /^\/(.+?)\/-\/(?:issues|work_items)\/(\d+)$/u.exec(pathname);
    const github = /^\/([^/]+\/[^/]+)\/issues\/(\d+)$/u.exec(pathname);
    const found: [ForgeKind, RegExpExecArray] | null = gitlab
      ? ["gitlab", gitlab]
      : github
        ? ["github", github]
        : null;
    if (found) {
      const [kind, match] = found;
      return {
        ok: true,
        ref: { tracker: kind, id: match[2], repo: match[1], host: url.host.toLowerCase() },
      };
    }
  }
  return {
    ok: false,
    error: `cannot read issue "${raw}" (use #42, owner/repo#42, IRPT-74 or an issue URL)`,
  };
}

const issueUrl = (kind: ForgeKind, host: string, repo: string, id: string): string =>
  `https://${host}/${repo}/${kind === "gitlab" ? "-/" : ""}issues/${id}`;

/**
 * Where a forge-tracker issue lives, its body line and its relation. The
 * workspace's `issues.repo`/`issues.host` place a bare number when the
 * tracker is not the PR's own repository.
 */
function placeRef(
  ref: NamedRef,
  forge: PrForge,
  tracker: IssueTracker | null,
  relation: "closes" | "refs",
  youtrackBase: string | null,
): Omit<IssueLink, "source"> | { error: string } {
  if (ref.tracker === "youtrack") {
    const url = youtrackBase ? `${youtrackBase.replace(/\/+$/u, "")}/issue/${ref.id}` : null;
    return {
      ...ref,
      url,
      relation: "related",
      line: `Related to: ${url ?? ref.id}`,
    };
  }
  const configured = tracker?.provider === ref.tracker;
  const home = ref.tracker === forge.kind ? forge.host : DEFAULT_HOST[ref.tracker];
  const host = ref.host ?? (configured ? tracker?.host : null) ?? home;
  const repo =
    ref.repo ??
    (configured ? tracker?.repo : null) ??
    (ref.tracker === forge.kind && same(host, forge.host) ? forge.repo : null);
  if (!repo)
    return {
      error: `#${ref.id} is a ${ref.tracker} issue, but the PR is on ${forge.kind}: set issues.repo to the ${ref.tracker} project that holds it, or pass the issue URL`,
    };
  if (ref.tracker === forge.kind && same(host, forge.host)) {
    const own = same(repo, forge.repo);
    return {
      tracker: ref.tracker,
      id: ref.id,
      repo: own ? null : repo,
      host: null,
      url: null,
      relation,
      line: `${relation === "refs" ? "Refs" : "Closes"} ${own ? "" : repo}#${ref.id}`,
    };
  }
  const url = issueUrl(ref.tracker, host, repo, ref.id);
  return {
    tracker: ref.tracker,
    id: ref.id,
    repo,
    host,
    url,
    relation: "related",
    line: `Related to: ${url}`,
  };
}

/** The workspace tracker, or null when none is configured or the config cannot resolve. */
function trackerFor(cwd: string): IssueTracker | null {
  const resolved = vcsConfig("resolve", cwd);
  if (resolved.ok === false) return null;
  return (resolved.issue_tracker as IssueTracker | null | undefined) ?? null;
}

/**
 * The issues a PR from `branch` links and their body lines. Named issues
 * (the flag, else the fanout slice) always link; the branch name is read
 * only when the tracker has `link: true`, and a YouTrack id from it only
 * when a base URL is known (unchanged from the branch-only behavior).
 */
export function planIssueLinks(
  cwd: string,
  input: {
    issues: readonly string[];
    refs: boolean;
    branch: string | null;
    forge: PrForge;
  },
  tracker: IssueTracker | null = trackerFor(cwd),
): { ok: true; data: IssueLinkPlan } | { ok: false; error: string } {
  const relation = input.refs ? "refs" : (tracker?.relation ?? "closes");
  const youtrackBase = tracker?.baseUrl ?? youTrackBaseUrl();
  const forgeTracker: ForgeKind =
    tracker?.provider === "github" || tracker?.provider === "gitlab"
      ? tracker.provider
      : input.forge.kind;
  const warnings = [...(tracker?.warnings ?? [])];
  const named = input.issues.length ? input.issues : sliceIssuesFor(cwd, input.branch);
  const source: IssueLink["source"] = input.issues.length ? "flag" : "fanout";
  const refs: Array<{ ref: NamedRef; source: IssueLink["source"] }> = [];
  for (const raw of named) {
    const parsed = parseIssueRef(raw, forgeTracker);
    if (!parsed.ok)
      return {
        ok: false,
        error: source === "fanout" ? `fanout slice issue: ${parsed.error}` : parsed.error,
      };
    refs.push({ ref: parsed.ref, source });
  }
  let derived = false;
  if (refs.length === 0 && tracker?.link && input.branch) {
    const id =
      tracker.provider === "youtrack"
        ? youtrackBase
          ? deriveYouTrackIssueFromBranch(input.branch)
          : ""
        : deriveGhIssueFromBranch(input.branch);
    if (id) {
      refs.push({
        ref: { tracker: tracker.provider, id, repo: null, host: null },
        source: "branch",
      });
      derived = true;
    }
  }
  const seen = new Set<string>();
  const links: IssueLink[] = [];
  for (const { ref, source: from } of refs) {
    const placed = placeRef(ref, input.forge, tracker, relation, youtrackBase);
    if ("error" in placed) {
      if (derived) {
        warnings.push(`the branch issue is not linked: ${placed.error}`);
        continue;
      }
      return { ok: false, error: placed.error };
    }
    const key = `${placed.tracker}:${placed.host ?? ""}:${placed.repo?.toLowerCase() ?? ""}#${placed.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ ...placed, source: from });
  }
  return { ok: true, data: { links, backlink: tracker?.backlink === true, tracker, warnings } };
}

/** The body with each link's line appended once (a line already present is kept as is). */
export function withIssueLines(
  body: string,
  links: ReadonlyArray<Pick<IssueLink, "line">>,
): string {
  const present = new Set(body.split(/\r?\n/u).map((line) => line.trim()));
  const lines = links.map((link) => link.line).filter((line) => !present.has(line));
  if (lines.length === 0) return body;
  return body ? `${body}\n\n${lines.join("\n")}` : lines.join("\n");
}

/** One `pr.linked` row per link, for a PR this call opened. */
export function recordIssueLinks(
  cwd: string,
  pr: { number: number; url: string; branch: string; base: string; head: string },
  links: readonly IssueLink[],
  context: { actor: LedgerActor; forge: ForgeKind; repo: string },
): Array<{ issue: string; id: string } | { issue: string; error: string }> {
  return links.map((link) => {
    const row = appendObserved(cwd, {
      type: "pr.linked",
      actor: context.actor,
      branch: pr.branch,
      head: pr.head,
      pr: pr.number,
      base: pr.base,
      url: pr.url,
      forge: context.forge,
      repo: context.repo,
      tracker: link.tracker,
      issue: link.id,
      issueRepo: link.repo,
      issueHost: link.host,
      issueUrl: link.url,
      relation: link.relation,
      source: link.source,
    });
    return row.ok
      ? { issue: label(link), id: String(row.value.id) }
      : { issue: label(link), error: row.error };
  });
}

/** `#42`, `owner/repo#42`, `IRPT-74`, or the URL of an issue on another forge. */
export const label = (link: Pick<IssueLink, "tracker" | "id" | "repo" | "url">): string =>
  link.tracker === "youtrack" ? link.id : (link.url ?? `${link.repo ?? ""}#${link.id}`);

export type LinkedIssue = {
  tracker: string;
  issue: string;
  repo: string | null;
  url: string | null;
  relation: string;
  source: string;
};

/** The issues `pr.linked` rows record for PR `pr` of `repo` (the CLI's own rows only). */
export function linkedIssues(
  rows: readonly ReadRow[],
  target: { pr: number; repo: string },
): LinkedIssue[] {
  const out = new Map<string, LinkedIssue>();
  for (const row of rows) {
    if (row.type !== "pr.linked" || row.observer !== "workit_cli" || row.pr !== target.pr) continue;
    if (typeof row.repo !== "string" || row.repo.toLowerCase() !== target.repo.toLowerCase())
      continue;
    if (typeof row.issue !== "string" || typeof row.tracker !== "string") continue;
    const repo = typeof row.issueRepo === "string" ? row.issueRepo : null;
    const url = typeof row.issueUrl === "string" ? row.issueUrl : null;
    out.set(`${row.tracker}:${url ?? repo ?? ""}#${row.issue}`, {
      tracker: row.tracker,
      issue: row.issue,
      repo,
      url,
      relation:
        typeof row.relation === "string"
          ? row.relation
          : row.tracker === "youtrack"
            ? "related"
            : "closes",
      source: typeof row.source === "string" ? row.source : "flag",
    });
  }
  return [...out.values()];
}

export type BacklinkOutcome = {
  issue: string;
  status: OnceOutcome["status"] | "skipped";
  note?: string;
};

const defaultYouTrackComment = (
  root: string,
  issueId: string,
  text: string,
  marker: string,
): Promise<OnceOutcome> =>
  writeOnce(issueId, marker, "comments", async () => {
    try {
      return {
        ok: true,
        data: unwrap(await defaultOperations.postComment(issueId, withMarker(text, marker), root)),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

/**
 * The forge an issue lives on: the PR's own, or another repository on the
 * same forge host under the same verified credential. Null for another host:
 * no account is verified there.
 */
function issueForge(
  resolved: ResolvedForge,
  link: IssueLink,
  runner: ForgeRunner | undefined,
): Forge | null {
  if (link.tracker === "youtrack") return null;
  if (link.repo === null && link.host === null) return resolved.forge;
  const apiHost = resolved.forge.apiHost;
  if (link.tracker !== resolved.forge.kind || !same(link.host ?? apiHost, apiHost)) return null;
  const options = {
    apiHost,
    repo: link.repo ?? resolved.forge.repo,
    runner: runner ?? resolved.runner,
  };
  return link.tracker === "github" ? createGitHubForge(options) : createGitLabForge(options);
}

/**
 * The tracker backlink (`issues.backlink: true`): a comment with the PR URL
 * on each linked issue, posted at most once: a marker naming the PR is read
 * back first. Forge issues on the PR's host go through the workspace's
 * verified credential; one on another forge host is skipped (no account is
 * verified there). YouTrack goes through its API behind WORKFLOW_YT_WRITE=1,
 * like `workit youtrack note`. A failure is reported per issue and never
 * undoes the PR.
 */
export async function postBacklinks(
  cwd: string,
  resolved: ResolvedForge,
  pr: { number: number; url: string },
  links: readonly IssueLink[],
  deps: { runner?: ForgeRunner; env?: NodeJS.ProcessEnv } = {},
): Promise<BacklinkOutcome[]> {
  const env = deps.env ?? process.env;
  const noun = resolved.forge.kind === "github" ? `PR #${pr.number}` : `MR !${pr.number}`;
  const text = `Linked from ${noun}: ${pr.url}`;
  const out: BacklinkOutcome[] = [];
  for (const link of links) {
    const issue = label(link);
    if (link.tracker === "youtrack") {
      if (env.WORKFLOW_YT_WRITE !== "1") {
        out.push({
          issue,
          status: "failed",
          note: "YouTrack writes need WORKFLOW_YT_WRITE=1 (as for workit youtrack note)",
        });
        continue;
      }
      const marker = youTrackMarker({ operation: "pr.backlink", issueId: link.id, pr: pr.url });
      if (!marker) {
        out.push({
          issue,
          status: "failed",
          note: "YouTrack credentials are unavailable (youtrack.json / youtrack.token)",
        });
        continue;
      }
      const outcome = await defaultYouTrackComment(cwd, link.id, text, marker);
      out.push({
        issue,
        status: outcome.status,
        ...("error" in outcome ? { note: outcome.error } : {}),
      });
      continue;
    }
    const forge = issueForge(resolved, link, deps.runner);
    if (!forge) {
      out.push({
        issue,
        status: "skipped",
        note: `an issue on another forge host is not backlinked: no verified account for ${link.host ?? resolved.forge.apiHost}`,
      });
      continue;
    }
    const marker = `<!-- workit-backlink:${pr.url} -->`;
    const number = Number(link.id);
    const existing = forge.issueComments(number);
    if (!existing.ok) {
      out.push({ issue, status: "failed", note: existing.error });
      continue;
    }
    if (existing.data.some((body) => body.includes(marker))) {
      out.push({ issue, status: "already_done" });
      continue;
    }
    const posted = forge.commentIssue(number, withMarker(text, marker));
    out.push(
      posted.ok ? { issue, status: "done" } : { issue, status: "failed", note: posted.error },
    );
  }
  return out;
}
