// `workit release start|finish|publish`: a git-flow release or hotfix without
// the git-flow binary, with `git flow release finish` semantics.
//
// - start cuts release/<version> (hotfix/<version> from production) on the
//   line's integration branch through gitBranch, locally. It never pushes.
// - finish (local half, here): --no-ff merge of the release branch into
//   production, an annotated tag <prefix><version> on that merge (message: the
//   changelog section when there is one), a --no-ff merge of the tag into
//   every merge-back branch (git-flow merges back through the tag), then
//   `git branch -d` of the release branch. Every step is decided from the
//   repository state plus the ledger rows of earlier runs, so an interrupted
//   finish resumes without repeating a merge or a tag. The CLI verb then
//   pushes production, the merge-back branches and the tag through the
//   existing `--release` push, publishes the forge release and verifies it.
// - publish is the one path that pushes a release branch (verbs/release.ts).
import { existsSync } from "node:fs";
import { readLedger, appendObserved, type LedgerActor } from "../ledger";
import { failure, success, type ForgeResult } from "../forge/types";
import { vcsConfig } from "../core/vcs-config";
import { trackBranchName } from "../core/release-tracks";
import {
  git,
  gitBranch,
  gitError,
  inProgressFailure,
  operationInProgress,
  releaseLinesOf,
  type ReleaseLine,
} from "./ops";
import { currentBranch, fetchRefs, pushRemoteName, remoteRefTip, resolveRef } from "./rev";

export type ReleaseKind = "release" | "hotfix";

const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,99}$/u;
const PLACEHOLDER = /\{[^}]*\}/gu;

const validVersion = (version: string): boolean =>
  VERSION.test(version) && !version.includes("..") && !version.endsWith(".lock");

/** The branch template of a line and kind: the track's naming, else `<kind>/{version}`. */
const templateOf = (line: ReleaseLine, kind: ReleaseKind): string => {
  const template = line.naming[kind];
  if (!template) return `${kind}/{version}`;
  return /\{[^}]*\}/u.test(template) ? template : `${template.replace(/\/?\*?$/u, "")}/{version}`;
};

const branchFor = (line: ReleaseLine, kind: ReleaseKind, version: string): string =>
  trackBranchName({ naming: line.naming }, kind, version) ?? `${kind}/${version}`;

/** The version a release branch name carries under `template`, or null. */
const versionIn = (template: string, branch: string): string | null => {
  const pattern = template
    .split(PLACEHOLDER)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("(.+)");
  const match = new RegExp(`^${pattern}$`, "u").exec(branch);
  return match?.[1] && validVersion(match[1]) ? match[1] : null;
};

type ReleaseRow = Record<string, unknown> & { type: string };

/** This repository's release.* ledger rows, oldest first. */
const releaseRows = (cwd: string): ReleaseRow[] => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) return [];
  return ledger.value.rows.filter((row) => row.type.startsWith("release."));
};

const record = (cwd: string, actor: LedgerActor, row: ReleaseRow): void => {
  appendObserved(cwd, { ...row, actor });
};

// ---------------------------------------------------------------------------
// start

export type ReleaseStartOutcome = {
  version: string;
  kind: ReleaseKind;
  branch: string;
  base: string;
  baseSha: string;
  track: string | null;
  tag: string;
  notes: string[];
};

/** The line `--track`, else the checkout's resolved release track, names. */
function lineFor(cwd: string, track: string | null): ForgeResult<ReleaseLine> {
  const lines = releaseLinesOf(cwd);
  let name = track;
  if (name === null && lines.length > 1) {
    const resolved = vcsConfig("resolve", cwd);
    if (resolved.ok === false) return failure("blocked", String(resolved.error));
    if (resolved.releaseTrack?.blocking)
      return failure("blocked", String(resolved.releaseTrack.blocking), "pass --track <name>");
    name = resolved.releaseTrack?.track?.name ?? null;
  }
  const line = lines.find((entry) => entry.track === name);
  if (!line)
    return failure(
      "invalid_input",
      `no release track ${JSON.stringify(name)} (configured: ${
        lines
          .map((entry) => entry.track)
          .filter(Boolean)
          .join(", ") || "none"
      })`,
    );
  return success(line);
}

export function releaseStart(
  cwd: string,
  input: { version: string; hotfix?: boolean; track?: string | null; actor: LedgerActor },
): ForgeResult<ReleaseStartOutcome> {
  const version = input.version.trim();
  if (!validVersion(version))
    return failure("invalid_input", `${JSON.stringify(version)} is not a version (e.g. 1.4.0)`);
  const kind: ReleaseKind = input.hotfix ? "hotfix" : "release";
  const lineResult = lineFor(cwd, input.track ?? null);
  if (!lineResult.ok) return lineResult;
  const line = lineResult.data;
  // git-flow allows one release (or hotfix) in flight per line.
  const template = templateOf(line, kind);
  const existing = git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
    .stdout.split("\n")
    .filter((name) => name && versionIn(template, name) !== null);
  if (existing.length)
    return failure(
      "blocked",
      `release_exists: ${existing[0]} is still open; git-flow finishes one ${kind} before starting the next`,
      `workit release finish  # on ${existing[0]}`,
    );
  const tag = `${line.tagPrefix}${version}`;
  if (resolveRef(cwd, `refs/tags/${tag}`))
    return failure(
      "blocked",
      `tag_exists: ${tag} already exists`,
      "start the next version instead",
    );
  const base = kind === "hotfix" ? line.production : line.integration;
  // The release starts from the fetched remote base (gitBranch); local
  // commits on it that the remote lacks would silently stay out of it.
  const remote = pushRemoteName(cwd, base);
  if (remote) {
    fetchRefs(cwd, remote, [`+refs/heads/${base}:refs/remotes/${remote}/${base}`]);
    const local = resolveRef(cwd, `refs/heads/${base}`);
    const tracked = resolveRef(cwd, `refs/remotes/${remote}/${base}`);
    if (
      local &&
      tracked &&
      local !== tracked &&
      !git(cwd, ["merge-base", "--is-ancestor", local, tracked]).ok
    )
      return failure(
        "blocked",
        `base_unpushed: local ${base} has commits ${remote}/${base} lacks; the ${kind} would start without them`,
        `land them on ${remote}/${base} first, or: git switch ${base} && git reset --keep ${remote}/${base}`,
      );
  }
  const branched = gitBranch(cwd, {
    name: branchFor(line, kind, version),
    base,
    ...(line.track ? { track: line.track } : {}),
  });
  if (!branched.ok) return branched;
  record(cwd, input.actor, {
    type: "release.started",
    version,
    kind,
    branch: branched.data.branch,
    head: branched.data.baseSha,
    base,
    track: line.track,
    tag,
  });
  return success({
    version,
    kind,
    branch: branched.data.branch,
    base,
    baseSha: branched.data.baseSha,
    track: line.track,
    tag,
    notes: branched.data.notes,
  });
}

// ---------------------------------------------------------------------------
// finish: the plan

export type FinishState = {
  merged: boolean;
  tagged: boolean;
  /** Merge-back branch -> already holds the tag. */
  mergedBack: Record<string, boolean>;
  branchDeleted: boolean;
};

export type FinishPlan = {
  version: string;
  kind: ReleaseKind;
  branch: string;
  track: string | null;
  tag: string;
  production: string;
  mergeBack: string[];
  /** git-flow merges locally; elsewhere finish opens a release PR. */
  gitflow: boolean;
  remote: string | null;
  /** The release branch's tip (from the ledger once the branch is deleted). */
  releaseTip: string;
  /** The remote release branch's tip when it was published, else null. */
  published: string | null;
  /** The commit the tag marks: the production merge, once made. */
  tagTarget: string | null;
  state: FinishState;
  /** The CHANGELOG.md section of this version, when there is one. */
  changelog: string | null;
  notes: string[];
};

const KINDS: ReleaseKind[] = ["release", "hotfix"];

type Located = { line: ReleaseLine; kind: ReleaseKind; version: string; branch: string };

/**
 * Which release to finish: `version` (on the given or any line), else the
 * checked-out release branch, else the newest started release this ledger
 * has not finished, else the only release branch.
 */
function locate(cwd: string, version: string | null, track: string | null): ForgeResult<Located> {
  const lines = releaseLinesOf(cwd).filter((line) => track === null || line.track === track);
  if (!lines.length) return failure("invalid_input", `no release track ${JSON.stringify(track)}`);
  const rows = releaseRows(cwd);
  const started = rows.filter((row) => row.type === "release.started");
  const finished = new Set(
    rows.filter((row) => row.type === "release.finished").map((row) => String(row.branch)),
  );
  /** The started row of `branch`, newest first: it names the release's line. */
  const startedRow = (branch: string) =>
    started.findLast((row) => row.branch === branch && !finished.has(branch));
  const lineOf = (branch: string, candidates: ReleaseLine[]): ReleaseLine => {
    const row = startedRow(branch);
    const byRow = row ? candidates.find((line) => line.track === (row.track ?? null)) : undefined;
    if (byRow) return byRow;
    const resolved = vcsConfig("resolve", cwd, { branch });
    const name = resolved.ok === false ? null : (resolved.releaseTrack?.track?.name ?? null);
    return candidates.find((line) => line.track === name) ?? candidates[0];
  };
  const match = (branch: string): Located | null => {
    const hits: Array<{ line: ReleaseLine; kind: ReleaseKind; version: string }> = [];
    for (const line of lines)
      for (const kind of KINDS) {
        const found = versionIn(templateOf(line, kind), branch);
        if (found) hits.push({ line, kind, version: found });
      }
    if (!hits.length) return null;
    const line = lineOf(
      branch,
      hits.map((hit) => hit.line),
    );
    const hit = hits.find((entry) => entry.line === line) ?? hits[0];
    return { ...hit, branch };
  };
  if (version !== null) {
    if (!validVersion(version))
      return failure("invalid_input", `${JSON.stringify(version)} is not a version`);
    for (const line of lines)
      for (const kind of KINDS) {
        const branch = branchFor(line, kind, version);
        if (resolveRef(cwd, `refs/heads/${branch}`) || startedRow(branch)) {
          const located = match(branch);
          if (located) return success(located);
        }
      }
    return failure(
      "not_found",
      `no release or hotfix branch for ${version} here, and none this ledger started`,
    );
  }
  const current = currentBranch(cwd);
  const here = current ? match(current) : null;
  if (here) return success(here);
  const open = started.findLast((row) => !finished.has(String(row.branch)));
  if (open) {
    const located = match(String(open.branch));
    if (located) return success(located);
  }
  const branches = git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
    .stdout.split("\n")
    .map((name) => (name ? match(name) : null))
    .filter((entry): entry is Located => entry !== null);
  if (branches.length === 1) return success(branches[0]);
  return failure(
    branches.length ? "invalid_input" : "not_found",
    branches.length
      ? `several releases are open (${branches.map((entry) => entry.branch).join(", ")}); name one`
      : "no release or hotfix branch to finish",
    branches.length
      ? `workit release finish ${branches[0].version}`
      : "workit release start <version>",
  );
}

const isAncestor = (cwd: string, ancestor: string, descendant: string): boolean =>
  git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]).ok;

/**
 * The CHANGELOG.md section for `version` at `ref`: a `## [1.4.0]`, `## 1.4.0`
 * or `# [1.4.0](…)` heading (a `v` before the version is fine), up to the next
 * heading of the same or a higher level. Null without one.
 */
export function changelogSection(cwd: string, ref: string, version: string): string | null {
  const shown = git(cwd, ["show", `${ref}:CHANGELOG.md`]);
  if (!shown.ok) return null;
  const lines = shown.stdout.split(/\r?\n/u);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const heading = new RegExp(`^(#{1,3})\\s+\\[?v?${escaped}\\]?(?:[\\s(]|$)`, "u");
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return null;
  const level = heading.exec(lines[start])?.[1].length ?? 2;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const hashes = /^(#+)\s/u.exec(lines[index])?.[1].length;
    if (hashes !== undefined && hashes <= level) {
      end = index;
      break;
    }
  }
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  return body || null;
}

/** Preflight and state of a finish: nothing changes here except fetched remote-tracking refs. */
export function planReleaseFinish(
  cwd: string,
  input: { version?: string | null; track?: string | null },
): ForgeResult<FinishPlan> {
  const progress = operationInProgress(cwd);
  if (progress) return inProgressFailure(progress.operation, "finish the release");
  const located = locate(cwd, input.version?.trim() || null, input.track ?? null);
  if (!located.ok) return located;
  const { line, kind, version, branch } = located.data;
  const notes: string[] = [];
  const dirty = git(cwd, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim();
  if (dirty)
    return failure(
      "blocked",
      "dirty_worktree: tracked files have uncommitted changes; a release finish merges on a clean tree",
      "workit git commit -m '<msg>' -- <paths>  # on the release branch, or stash them",
    );
  const tag = `${line.tagPrefix}${version}`;
  const mergeBack = line.mergeBack;
  const remote = pushRemoteName(cwd, line.production);
  if (remote) {
    const wanted = [line.production, ...mergeBack, branch];
    for (const name of wanted)
      fetchRefs(cwd, remote, [`+refs/heads/${name}:refs/remotes/${remote}/${name}`]);
  }
  // Production and every merge-back branch: local, and not behind the remote.
  for (const name of [line.production, ...mergeBack]) {
    const local = resolveRef(cwd, `refs/heads/${name}`);
    const tracked = remote ? resolveRef(cwd, `refs/remotes/${remote}/${name}`) : null;
    if (!local && tracked) {
      const created = git(cwd, ["branch", "--no-track", name, tracked]);
      if (!created.ok)
        return failure("failed", `could not create local ${name}: ${gitError(created)}`);
      notes.push(`created local ${name} from ${remote}/${name}`);
      continue;
    }
    if (!local)
      return failure("not_found", `${name} exists neither locally nor on ${remote ?? "a remote"}`);
    if (tracked && !isAncestor(cwd, tracked, local))
      return failure(
        "blocked",
        `branch_behind: local ${name} is behind or diverged from ${remote}/${name}; git-flow finishes only onto up-to-date branches`,
        `git switch ${name} && git merge --ff-only ${remote}/${name}  # then: workit release finish ${version}`,
      );
  }
  const rows = releaseRows(cwd).filter((row) => row.branch === branch || row.release === branch);
  const branchTip = resolveRef(cwd, `refs/heads/${branch}`);
  const remoteBranch = remote ? resolveRef(cwd, `refs/remotes/${remote}/${branch}`) : null;
  const mergedRow = rows.findLast((row) => row.type === "release.merged");
  const releaseTip =
    branchTip ?? (typeof mergedRow?.releaseTip === "string" ? mergedRow.releaseTip : null);
  if (!releaseTip)
    return failure(
      "not_found",
      `${branch} is gone and this ledger did not record its merge; nothing to resume`,
    );
  if (branchTip && remoteBranch && !isAncestor(cwd, remoteBranch, branchTip))
    return failure(
      "blocked",
      `release_behind: ${remote}/${branch} has commits local ${branch} lacks`,
      `git switch ${branch} && git merge --ff-only ${remote}/${branch}`,
    );
  const production = resolveRef(cwd, `refs/heads/${line.production}`) as string;
  const merged = isAncestor(cwd, releaseTip, production);
  const localTag = resolveRef(cwd, `refs/tags/${tag}`);
  if (localTag && !(isAncestor(cwd, localTag, production) && isAncestor(cwd, releaseTip, localTag)))
    return failure(
      "blocked",
      `tag_exists: ${tag} (${localTag.slice(0, 12)}) is not this release's merge on ${line.production}`,
      "a release tag never moves; finish under the next version",
    );
  if (remote) {
    const remoteTag = remoteRefTip(cwd, remote, `refs/tags/${tag}`);
    if (remoteTag.ok && remoteTag.sha && remoteTag.sha !== localTag)
      return failure(
        "blocked",
        `tag_exists: ${remote} already has ${tag} at ${remoteTag.sha.slice(0, 12)}`,
        "a release tag never moves; finish under the next version",
      );
  }
  const recordedMerge = typeof mergedRow?.merge === "string" ? mergedRow.merge : null;
  const tagTarget = localTag ?? (merged ? (recordedMerge ?? production) : null);
  const state: FinishState = {
    merged,
    tagged: localTag !== null,
    mergedBack: Object.fromEntries(
      mergeBack.map((name) => [
        name,
        localTag !== null &&
          isAncestor(cwd, localTag, resolveRef(cwd, `refs/heads/${name}`) as string),
      ]),
    ),
    branchDeleted: branchTip === null,
  };
  return success({
    version,
    kind,
    branch,
    track: line.track,
    tag,
    production: line.production,
    mergeBack,
    gitflow: line.gitflow,
    remote,
    releaseTip,
    published: remoteBranch,
    tagTarget,
    state,
    changelog: changelogSection(cwd, branchTip ?? production, version),
    notes,
  });
}

// ---------------------------------------------------------------------------
// finish: the local merges

export type LocalFinish = {
  /** Steps run now (the rest were already done). */
  ran: string[];
  tagTarget: string;
};

const switchTo = (cwd: string, branch: string): ForgeResult<void> => {
  if (currentBranch(cwd) === branch) return success(undefined);
  const switched = git(cwd, ["switch", "-q", branch]);
  return switched.ok
    ? success(undefined)
    : failure("failed", `git switch ${branch} failed: ${gitError(switched)}`);
};

/** A --no-ff merge of `what` into the checked-out branch; a conflict stops with the resume command. */
const mergeNoFf = (
  cwd: string,
  what: string,
  into: string,
  version: string,
): ForgeResult<string> => {
  const merged = git(cwd, ["merge", "--no-ff", "--no-edit", what], { timeoutMs: 10 * 60_000 });
  if (!merged.ok) {
    const conflicted = existsSync(
      git(cwd, ["rev-parse", "--git-path", "MERGE_HEAD"]).stdout.trim(),
    );
    return failure(
      "failed",
      conflicted
        ? `merge_conflict: merging ${what} into ${into} conflicts`
        : `git merge ${what} into ${into} failed: ${gitError(merged)}`,
      conflicted
        ? `resolve the conflicts, git add <files>, git merge --continue, then: workit release finish ${version}`
        : undefined,
    );
  }
  return success(git(cwd, ["rev-parse", "HEAD"]).stdout.trim());
};

/**
 * The local half of `git flow release finish`, each step skipped when the
 * plan's state says it is done and recorded as a ledger row when run.
 */
export function finishLocally(
  cwd: string,
  plan: FinishPlan,
  actor: LedgerActor,
): ForgeResult<LocalFinish> {
  const ran: string[] = [];
  const base = { version: plan.version, release: plan.branch, tag: plan.tag, track: plan.track };
  let tagTarget = plan.tagTarget;
  if (!plan.state.merged) {
    const on = switchTo(cwd, plan.production);
    if (!on.ok) return on;
    const merged = mergeNoFf(cwd, plan.branch, plan.production, plan.version);
    if (!merged.ok) return merged;
    tagTarget = merged.data;
    ran.push("merge");
    record(cwd, actor, {
      type: "release.merged",
      ...base,
      branch: plan.production,
      head: merged.data,
      merge: merged.data,
      releaseTip: plan.releaseTip,
    });
  }
  if (!tagTarget) return failure("failed", `cannot tell which ${plan.production} commit to tag`);
  if (!plan.state.tagged) {
    const message = plan.changelog ?? `Release ${plan.version}`;
    const tagged = git(cwd, ["tag", "-a", plan.tag, "-m", message, tagTarget]);
    if (!tagged.ok) return failure("failed", `git tag ${plan.tag} failed: ${gitError(tagged)}`);
    ran.push("tag");
    record(cwd, actor, {
      type: "release.tagged",
      ...base,
      branch: plan.production,
      head: tagTarget,
    });
  }
  for (const name of plan.mergeBack) {
    if (plan.state.mergedBack[name]) continue;
    const on = switchTo(cwd, name);
    if (!on.ok) return on;
    const merged = mergeNoFf(cwd, plan.tag, name, plan.version);
    if (!merged.ok) return merged;
    ran.push(`merge-back ${name}`);
    record(cwd, actor, { type: "release.merged_back", ...base, branch: name, head: merged.data });
  }
  if (!plan.state.branchDeleted) {
    if (currentBranch(cwd) === plan.branch) {
      const on = switchTo(cwd, plan.mergeBack.at(-1) ?? plan.production);
      if (!on.ok) return on;
    }
    // -d, not -D: git refuses when the release has commits nothing merged.
    const deleted = git(cwd, ["branch", "-d", plan.branch]);
    if (!deleted.ok)
      return failure("failed", `git branch -d ${plan.branch} failed: ${gitError(deleted)}`);
    ran.push("delete-branch");
    record(cwd, actor, {
      type: "release.branch_deleted",
      ...base,
      branch: plan.branch,
      head: plan.releaseTip,
    });
  }
  return success({ ran, tagTarget });
}

/** Check out the release branch (the release PR path pushes it from there). */
export const switchToRelease = (cwd: string, plan: FinishPlan): ForgeResult<void> =>
  switchTo(cwd, plan.branch);

/** A ledger row for a finish step the CLI ran (push, forge release, done). */
export function recordReleaseStep(
  cwd: string,
  actor: LedgerActor,
  plan: FinishPlan,
  row: ReleaseRow,
): void {
  record(cwd, actor, {
    version: plan.version,
    release: plan.branch,
    tag: plan.tag,
    track: plan.track,
    ...row,
  });
}

// ---------------------------------------------------------------------------
// publish

/** The release branch `workit release publish` pushes: the named version's, else the checkout's. */
export function releaseToPublish(cwd: string, version: string | null): ForgeResult<Located> {
  const located = locate(cwd, version, null);
  if (!located.ok) return located;
  if (!resolveRef(cwd, `refs/heads/${located.data.branch}`))
    return failure("not_found", `${located.data.branch} is not a local branch`);
  return located;
}
