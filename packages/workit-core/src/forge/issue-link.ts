// Issue links for `workit pr create` (#324): which issues a PR links, the body
// line each one gets in the forge's own syntax, the `pr.linked` ledger rows,
// the optional tracker backlink, and the links `pr status` lists.
//
// Issues come from `--issue` (repeatable), else the fanout slice the branch
// belongs to (its `issue` field), else the branch name when the workspace
// tracker has `link: true`. The id's shape picks the tracker: `#42`, `42`,
// `owner/repo#42` and forge issue URLs are issues on the PR's forge
// (`Closes #42`, `Refs #42`); `IRPT-74` and `.../issue/IRPT-74` are YouTrack
// (`Related to: <baseUrl>/issue/IRPT-74`).
import { vcsConfig, type IssueTracker } from "../core/vcs-config";
import { youTrackBaseUrl } from "../core/youtrack";
import { defaultOperations, ISSUE_RE, unwrap } from "../core/youtrack-tools";
import { withMarker, writeOnce, youTrackMarker, type OnceOutcome } from "../core/youtrack-writes";
import { sliceIssuesFor } from "../fanout";
import { appendObserved, type LedgerActor, type ReadRow } from "../ledger";
import { deriveGhIssueFromBranch, deriveYouTrackIssueFromBranch } from "./pr-body";
import type { ResolvedForge } from "./resolve";

export type ForgeKind = "github" | "gitlab";
export type IssueRelation = "closes" | "refs";

export type IssueLink = {
  tracker: ForgeKind | "youtrack";
  /** The issue number on a forge, the issue id on YouTrack. */
  id: string;
  /** Another repository on the same forge (`owner/repo#42`), else null. */
  repo: string | null;
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
};

type ParsedRef = { tracker: ForgeKind | "youtrack"; id: string; repo: string | null };

/** One `--issue` value: `#42`, `42`, `owner/repo#42`, `IRPT-74` or an issue URL. */
export function parseIssueRef(
  raw: string,
  forge: { kind: ForgeKind; repo: string },
): { ok: true; ref: ParsedRef } | { ok: false; error: string } {
  const value = raw.trim();
  const own = (repo: string | null): string | null =>
    repo && repo.toLowerCase() !== forge.repo.toLowerCase() ? repo : null;
  if (ISSUE_RE.test(value))
    return { ok: true, ref: { tracker: "youtrack", id: value, repo: null } };
  const short = /^(?:([\w.-]+(?:\/[\w.-]+)+))?#?(\d+)$/u.exec(value);
  if (short && (short[1] === undefined || value.includes("#")))
    return { ok: true, ref: { tracker: forge.kind, id: short[2], repo: own(short[1] ?? null) } };
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
      return { ok: true, ref: { tracker: "youtrack", id: youtrack[1], repo: null } };
    const gitlab = /^\/(.+?)\/-\/(?:issues|work_items)\/(\d+)$/u.exec(pathname);
    const github = /^\/([^/]+\/[^/]+)\/issues\/(\d+)$/u.exec(pathname);
    const found: [ForgeKind, RegExpExecArray] | null = gitlab
      ? ["gitlab", gitlab]
      : github
        ? ["github", github]
        : null;
    if (found) {
      const [kind, match] = found;
      if (kind !== forge.kind)
        return {
          ok: false,
          error: `${value} is a ${kind} issue, but the PR is on ${forge.kind}; put the link in the body instead`,
        };
      return { ok: true, ref: { tracker: kind, id: match[2], repo: own(match[1]) } };
    }
  }
  return {
    ok: false,
    error: `cannot read issue "${raw}" (use #42, owner/repo#42, IRPT-74 or an issue URL)`,
  };
}

const lineFor = (ref: ParsedRef, relation: IssueRelation, youtrackBase: string | null): string => {
  if (ref.tracker === "youtrack")
    return youtrackBase
      ? `Related to: ${youtrackBase.replace(/\/+$/u, "")}/issue/${ref.id}`
      : `Related to: ${ref.id}`;
  return `${relation === "refs" ? "Refs" : "Closes"} ${ref.repo ?? ""}#${ref.id}`;
};

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
    forge: { kind: ForgeKind; repo: string };
  },
  tracker: IssueTracker | null = trackerFor(cwd),
): { ok: true; data: IssueLinkPlan } | { ok: false; error: string } {
  const relation: IssueRelation = input.refs ? "refs" : (tracker?.relation ?? "closes");
  const youtrackBase = tracker?.baseUrl ?? youTrackBaseUrl();
  const fromFanout = input.issues.length ? [] : sliceIssuesFor(cwd, input.branch);
  const named = input.issues.length ? input.issues : fromFanout;
  const source: IssueLink["source"] = input.issues.length ? "flag" : "fanout";
  const refs: Array<{ ref: ParsedRef; source: IssueLink["source"] }> = [];
  for (const raw of named) {
    const parsed = parseIssueRef(raw, input.forge);
    if (!parsed.ok)
      return {
        ok: false,
        error: source === "fanout" ? `fanout slice issue: ${parsed.error}` : parsed.error,
      };
    refs.push({ ref: parsed.ref, source });
  }
  if (refs.length === 0 && tracker?.link && input.branch) {
    if (tracker.provider === "youtrack") {
      const id = deriveYouTrackIssueFromBranch(input.branch);
      if (id && youtrackBase)
        refs.push({ ref: { tracker: "youtrack", id, repo: null }, source: "branch" });
    } else if (tracker.provider === input.forge.kind) {
      const id = deriveGhIssueFromBranch(input.branch);
      if (id) refs.push({ ref: { tracker: tracker.provider, id, repo: null }, source: "branch" });
    }
  }
  const seen = new Set<string>();
  const links: IssueLink[] = [];
  for (const { ref, source: from } of refs) {
    const key = `${ref.tracker}:${ref.repo?.toLowerCase() ?? ""}#${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ ...ref, relation, source: from, line: lineFor(ref, relation, youtrackBase) });
  }
  return { ok: true, data: { links, backlink: tracker?.backlink === true, tracker } };
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
      relation: link.relation,
      source: link.source,
    });
    return row.ok
      ? { issue: label(link), id: String(row.value.id) }
      : { issue: label(link), error: row.error };
  });
}

/** `#42`, `owner/repo#42` or `IRPT-74`. */
export const label = (link: Pick<IssueLink, "tracker" | "id" | "repo">): string =>
  link.tracker === "youtrack" ? link.id : `${link.repo ?? ""}#${link.id}`;

export type LinkedIssue = {
  tracker: string;
  issue: string;
  repo: string | null;
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
    out.set(`${row.tracker}:${repo ?? ""}#${row.issue}`, {
      tracker: row.tracker,
      issue: row.issue,
      repo,
      relation: typeof row.relation === "string" ? row.relation : "closes",
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

/** Posts a YouTrack comment at most once (the marker is read back first). */
export type YouTrackCommenter = (
  issueId: string,
  text: string,
  marker: string,
) => Promise<OnceOutcome>;

const defaultYouTrackCommenter =
  (root: string): YouTrackCommenter =>
  (issueId, text, marker) =>
    writeOnce(issueId, marker, "comments", async () => {
      try {
        return {
          ok: true,
          data: unwrap(
            await defaultOperations.postComment(issueId, withMarker(text, marker), root),
          ),
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

/**
 * The tracker backlink (`issues.backlink: true`): a comment with the PR URL
 * on each linked issue, posted at most once (a marker naming the PR is read
 * back first). Same-repository forge issues and YouTrack issues only; a
 * failure is reported per issue and never undoes the PR.
 */
export async function postBacklinks(
  cwd: string,
  resolved: ResolvedForge,
  pr: { number: number; url: string },
  links: readonly IssueLink[],
  deps: { youtrack?: YouTrackCommenter } = {},
): Promise<BacklinkOutcome[]> {
  const noun = resolved.forge.kind === "github" ? `PR #${pr.number}` : `MR !${pr.number}`;
  const text = `Linked from ${noun}: ${pr.url}`;
  const out: BacklinkOutcome[] = [];
  for (const link of links) {
    const issue = label(link);
    if (link.tracker === "youtrack") {
      const marker = youTrackMarker({ operation: "pr.backlink", issueId: link.id, pr: pr.url });
      if (!marker) {
        out.push({
          issue,
          status: "failed",
          note: "YouTrack credentials are unavailable (youtrack.json / youtrack.token)",
        });
        continue;
      }
      const outcome = await (deps.youtrack ?? defaultYouTrackCommenter(cwd))(link.id, text, marker);
      out.push({
        issue,
        status: outcome.status,
        ...("error" in outcome ? { note: outcome.error } : {}),
      });
      continue;
    }
    if (link.repo) {
      out.push({
        issue,
        status: "skipped",
        note: "an issue in another repository is not backlinked",
      });
      continue;
    }
    const marker = `<!-- workit-backlink:${pr.url} -->`;
    const number = Number(link.id);
    const existing = resolved.forge.issueComments(number);
    if (!existing.ok) {
      out.push({ issue, status: "failed", note: existing.error });
      continue;
    }
    if (existing.data.some((body) => body.includes(marker))) {
      out.push({ issue, status: "already_done" });
      continue;
    }
    const posted = resolved.forge.commentIssue(number, withMarker(text, marker));
    out.push(
      posted.ok ? { issue, status: "done" } : { issue, status: "failed", note: posted.error },
    );
  }
  return out;
}
