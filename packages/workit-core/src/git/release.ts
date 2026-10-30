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
import { readLedger, appendObserved, type LedgerActor } from "../ledger";
import { failure, success, type ForgeResult } from "../forge/types";
import { vcsConfig } from "../core/vcs-config";
import { trackBranchName } from "../core/release-tracks";
import { resolveChangelogPaths } from "../core/changelog-gate";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  resolveRuntimeWorkspacePolicy,
  workspaceChangelog,
  workspaceReleaseNotes,
  type ReleaseNotesMode,
} from "../core/workspaces";
import { compareUrl, highlightsOf, previousTag, renderReleaseNotes } from "../core/release-notes";
import {
  git,
  gitBranch,
  gitError,
  inProgressFailure,
  operationInProgress,
  releaseLinesOf,
  type ReleaseLine,
} from "./ops";
import {
  currentBranch,
  deriveForge,
  fetchRefs,
  gitCommonDir,
  pushRemoteName,
  pushUrl,
  remoteRefTip,
  resolveRef,
} from "./rev";

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
  input: {
    version: string;
    hotfix?: boolean;
    track?: string | null;
    actor: LedgerActor;
  },
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
  /** What the finish pushes: production and the merge-back branches, never a release branch. */
  pushBranches: string[];
  /** A hotfix's merge-back target when a release branch is open (git-flow), else null. */
  openRelease: string | null;
  /** git-flow merges locally; elsewhere finish opens a release PR. */
  gitflow: boolean;
  remote: string | null;
  /** The release branch's tip (from the ledger once the branch is deleted). */
  releaseTip: string;
  /** The remote release branch's tip when it was published, else null. */
  published: string | null;
  /** The commit the tag marks: the production merge, once made. */
  tagTarget: string | null;
  /** A release.merged row exists (a merge resolved by hand has none). */
  mergeRecorded: boolean;
  state: FinishState;
  /** The tag's prefix (`v` in v1.4.0). */
  tagPrefix: string;
  /** The changelog section of this version (the workspace's changelogPath), when there is one. */
  changelog: string | null;
  notes: string[];
  /** Said before merging, never blocking (integration mode pr). */
  warnings: string[];
};

const KINDS: ReleaseKind[] = ["release", "hotfix"];

type Located = {
  line: ReleaseLine;
  kind: ReleaseKind;
  version: string;
  branch: string;
};

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
    const hits: Array<{
      line: ReleaseLine;
      kind: ReleaseKind;
      version: string;
    }> = [];
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
 * The changelog section for `version` at `ref` (`file`: the first file the
 * workspace's changelogPath resolves to at `ref`, default CHANGELOG.md): a `## [1.4.0]`, `## 1.4.0` or
 * `# [1.4.0](…)` heading (a `v` before the version is fine), up to the next
 * heading of the same or a higher level. Null without one.
 */
export function changelogSection(
  cwd: string,
  ref: string,
  version: string,
  file: string | undefined = resolveChangelogPaths(cwd, workspaceChangelog(cwd).paths, ref)[0],
): string | null {
  if (!file) return null;
  const shown = git(cwd, ["show", `${ref}:${file}`]);
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
  const rows = releaseRows(cwd).filter((row) => row.branch === branch || row.release === branch);
  // git-flow: a hotfix finished while a release is open merges back into
  // that release branch instead of develop (the release carries it there).
  // Recorded once, so a resumed finish keeps the same target.
  const recordedOpen = rows.findLast((row) => row.type === "release.hotfix_target");
  const openRelease =
    kind !== "hotfix"
      ? null
      : typeof recordedOpen?.target === "string"
        ? recordedOpen.target
        : (git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
            .stdout.split("\n")
            .find((name) => name && versionIn(templateOf(line, "release"), name) !== null) ?? null);
  const mergeBack = openRelease
    ? [...new Set(line.mergeBack.map((name) => (name === line.integration ? openRelease : name)))]
    : line.mergeBack;
  if (openRelease)
    notes.push(
      `${openRelease} is open: the hotfix merges back into it instead of ${line.integration}`,
    );
  const remote = pushRemoteName(cwd, line.production);
  if (remote) {
    const wanted = [line.production, ...mergeBack, branch];
    for (const name of wanted)
      fetchRefs(cwd, remote, [`+refs/heads/${name}:refs/remotes/${remote}/${name}`]);
  }
  const branchTip = resolveRef(cwd, `refs/heads/${branch}`);
  const remoteBranch = remote ? resolveRef(cwd, `refs/remotes/${remote}/${branch}`) : null;
  const mergedRow = rows.findLast((row) => row.type === "release.merged");
  const deletedRow = rows.findLast((row) => row.type === "release.branch_deleted");
  // Once the branch is gone its tip is in the ledger: the recorded merge, or
  // the deletion (a merge resolved by hand left no release.merged row).
  const recordedTip = [mergedRow?.releaseTip, deletedRow?.head].find(
    (value): value is string => typeof value === "string",
  );
  const releaseTip = branchTip ?? recordedTip ?? null;
  if (!releaseTip)
    return failure(
      "not_found",
      `${branch} is gone and this ledger did not record its merge; nothing to resume`,
    );
  // Production and every merge-back branch: local, not behind the remote,
  // and ahead of it only by this release's own merges.
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
    if (!tracked || name === openRelease) continue;
    if (!isAncestor(cwd, tracked, local))
      return failure(
        "blocked",
        `branch_behind: local ${name} is behind or diverged from ${remote}/${name}; git-flow finishes only onto up-to-date branches`,
        `git switch ${name} && git merge --ff-only ${remote}/${name}  # then: workit release finish ${version}`,
      );
    // Published production commits arrive through the merge-back; not new.
    const productionTracked = remote
      ? resolveRef(cwd, `refs/remotes/${remote}/${line.production}`)
      : null;
    const foreign = git(cwd, [
      "rev-list",
      local,
      `^${tracked}`,
      `^${releaseTip}`,
      ...(productionTracked ? [`^${productionTracked}`] : []),
    ])
      .stdout.split("\n")
      .filter(Boolean)
      .filter(
        (sha) =>
          !(
            git(cwd, ["rev-parse", "-q", "--verify", `${sha}^2`]).ok &&
            isAncestor(cwd, releaseTip, sha)
          ),
      );
    if (foreign.length)
      return failure(
        "blocked",
        `branch_ahead: local ${name} has ${foreign.length} commit(s) ${remote}/${name} lacks that are not part of ${branch}; the finish push would publish them`,
        `land them through review first, or: git switch ${name} && git reset --keep ${remote}/${name}  # then: workit release finish ${version}`,
      );
  }
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
    pushBranches: [line.production, ...mergeBack.filter((name) => name !== openRelease)],
    openRelease,
    gitflow: line.gitflow,
    remote,
    releaseTip,
    published: remoteBranch,
    tagTarget,
    mergeRecorded: mergedRow !== undefined,
    state,
    tagPrefix: line.tagPrefix,
    changelog: changelogSection(cwd, branchTip ?? production, version),
    notes,
    warnings: integrationPrWarning(cwd, line.production),
  });
}

/**
 * A workspace that sets `integration: "pr"` lands work through reviewed PRs;
 * its forge may also protect production against the finish push. Said, not
 * enforced: git-flow finishes locally either way.
 */
function integrationPrWarning(cwd: string, production: string): string[] {
  try {
    const selected = resolveRuntimeWorkspacePolicy(
      cwd,
      "branch",
      process.env.WORKFLOW_PROFILE?.trim() || undefined,
    ).policy as { integration?: unknown } | undefined;
    return selected?.integration === "pr"
      ? [
          `the workspace integration mode is pr: the remote may require pull requests on ${production}, which would reject the finish push`,
        ]
      : [];
  } catch {
    return [];
  }
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
  const merged = git(cwd, ["merge", "--no-ff", "--no-edit", what], {
    timeoutMs: 10 * 60_000,
  });
  if (!merged.ok) {
    const conflicted = git(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok;
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
  const base = {
    version: plan.version,
    release: plan.branch,
    tag: plan.tag,
    track: plan.track,
  };
  let tagTarget = plan.tagTarget;
  // Once per release: a resumed finish reads the target back from this row.
  if (
    plan.openRelease &&
    !releaseRows(cwd).some(
      (row) => row.type === "release.hotfix_target" && row.release === plan.branch,
    )
  )
    record(cwd, actor, {
      type: "release.hotfix_target",
      ...base,
      branch: plan.branch,
      target: plan.openRelease,
    });
  // A merge resolved by hand (`git merge --continue`) left no row: record
  // what the repository shows, so a resume after the branch is gone has its tip.
  if (plan.state.merged && !plan.mergeRecorded && tagTarget)
    record(cwd, actor, {
      type: "release.merged",
      ...base,
      branch: plan.production,
      head: tagTarget,
      merge: tagTarget,
      releaseTip: plan.releaseTip,
      observed: true,
    });
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
    // verbatim: a changelog's `### Fixed` is not a comment to strip.
    const tagged = git(cwd, [
      "tag",
      "-a",
      "--cleanup=verbatim",
      plan.tag,
      "-m",
      message,
      tagTarget,
    ]);
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
    record(cwd, actor, {
      type: "release.merged_back",
      ...base,
      branch: name,
      head: merged.data,
    });
  }
  if (!plan.state.branchDeleted) {
    if (currentBranch(cwd) === plan.branch) {
      const on = switchTo(cwd, plan.mergeBack.at(-1) ?? plan.production);
      if (!on.ok) return on;
    }
    // -d, not -D: git refuses when the release has commits nothing merged.
    const deleted = git(cwd, ["branch", "-d", plan.branch]);
    // A published branch is checked against its upstream: commits made
    // after publishing would be lost with it.
    if (!deleted.ok)
      return failure(
        "failed",
        `git branch -d ${plan.branch} failed: ${gitError(deleted)}`,
        plan.published
          ? `workit release publish ${plan.version}  # its remote copy lacks commits; then: workit release finish ${plan.version}`
          : undefined,
      );
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

// ---------------------------------------------------------------------------
// release notes: the draft, its approval, and what finish publishes

export type ReleaseNotesContext = {
  version: string;
  tag: string;
  track: string | null;
  mode: ReleaseNotesMode;
  /** Where the mode comes from (`track`, `workspace` or `default`). */
  modeFrom: "track" | "workspace" | "default";
  changelog: string | null;
  /** The compare link from the previous tag, or null. */
  compare: string | null;
  previousTag: string | null;
};

/** The forge's compare link from the tag before `tag` (same prefix), or null. */
function compareLink(
  cwd: string,
  production: string,
  prefix: string,
  version: string,
  tag: string,
) {
  const before = previousTag(
    git(cwd, ["tag", "-l"]).stdout.split("\n").filter(Boolean),
    prefix,
    version,
  );
  const remote = pushRemoteName(cwd, production);
  const url = remote ? pushUrl(cwd, remote) : null;
  const forge = url ? deriveForge(url) : null;
  return {
    previousTag: before,
    compare:
      before && forge
        ? compareUrl(forge.kind, `https://${forge.apiHost}/${forge.repo}`, before, tag)
        : null,
  };
}

/**
 * What the notes of `version` are built from: its release branch when one is
 * here (or the tag once finished, else HEAD), the line's tag prefix, and the
 * workspace's (or release track's) releaseNotes mode.
 */
export function releaseNotesContext(
  cwd: string,
  input: { version: string; track?: string | null },
): ForgeResult<ReleaseNotesContext> {
  const version = input.version.trim();
  if (!validVersion(version))
    return failure("invalid_input", `${JSON.stringify(version)} is not a version (e.g. 1.4.0)`);
  const located = locate(cwd, version, input.track ?? null);
  let line: ReleaseLine;
  let ref = "HEAD";
  if (located.ok) {
    line = located.data.line;
    if (resolveRef(cwd, `refs/heads/${located.data.branch}`)) ref = located.data.branch;
  } else {
    const lines = releaseLinesOf(cwd).filter(
      (entry) => input.track == null || entry.track === input.track,
    );
    if (!lines.length)
      return failure("invalid_input", `no release track ${JSON.stringify(input.track)}`);
    line = lines[0];
  }
  const tag = `${line.tagPrefix}${version}`;
  if (ref === "HEAD" && resolveRef(cwd, `refs/tags/${tag}`)) ref = tag;
  const mode = workspaceReleaseNotes(cwd, line.track);
  return success({
    version,
    tag,
    track: line.track,
    mode: mode.mode,
    modeFrom: mode.from,
    changelog: changelogSection(cwd, ref, version),
    ...compareLink(cwd, line.production, line.tagPrefix, version, tag),
  });
}

/** Where the draft of `version` lives: the git common dir, never committed. */
export const releaseNotesDraftPath = (cwd: string, version: string): string | null => {
  const common = gitCommonDir(cwd);
  return common ? path.join(common, "workit", "release-notes", `${version}.md`) : null;
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export type ReleaseNotesDraft = { path: string; notes: string; sha256: string };

/** The draft of `version`, or null when none was written. */
export function readReleaseNotesDraft(cwd: string, version: string): ReleaseNotesDraft | null {
  const file = releaseNotesDraftPath(cwd, version);
  if (!file || !existsSync(file)) return null;
  const notes = readFileSync(file, "utf8");
  return { path: file, notes, sha256: sha256(notes) };
}

/**
 * Write the draft of `version` from its changelog section. An existing
 * draft's Highlights stay unless `reset`.
 */
export function writeReleaseNotesDraft(
  cwd: string,
  context: ReleaseNotesContext,
  options: { reset?: boolean } = {},
): ForgeResult<ReleaseNotesDraft & { keptHighlights: boolean }> {
  const file = releaseNotesDraftPath(cwd, context.version);
  if (!file) return failure("invalid_input", "not a git repository: nowhere to keep the draft");
  const existing = options.reset ? null : readReleaseNotesDraft(cwd, context.version);
  const highlights = existing ? highlightsOf(existing.notes) : null;
  const notes = renderReleaseNotes({
    version: context.version,
    changelog: context.changelog,
    highlights,
    compare: context.compare,
  });
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, notes);
  return success({
    path: file,
    notes,
    sha256: sha256(notes),
    keptHighlights: highlights !== null,
  });
}

/** The newest `release.notes.approved` row of `version`, or null. */
export function latestReleaseNotesApproval(
  cwd: string,
  version: string,
): { sha256: string } | null {
  const row = releaseRows(cwd).findLast(
    (entry) => entry.type === "release.notes.approved" && entry.version === version,
  );
  return row && typeof row.sha256 === "string" ? { sha256: row.sha256 } : null;
}

/** Record the user's approval of the draft as it is now. */
export function recordReleaseNotesApproval(
  cwd: string,
  actor: LedgerActor,
  draft: ReleaseNotesDraft & { version: string; tag: string },
): void {
  record(cwd, actor, {
    type: "release.notes.approved",
    version: draft.version,
    tag: draft.tag,
    sha256: draft.sha256,
    path: draft.path,
  });
}

export type ReleaseNotesDecision =
  | { publish: false; mode: "off"; reason: string }
  | {
      publish: true;
      mode: ReleaseNotesMode;
      body: string;
      source: "draft" | "changelog";
    }
  | { publish: false; mode: "review"; blocked: string; unblock: string };

/**
 * What finish publishes as the forge release body: nothing under `off`; the
 * draft (else the notes built from the changelog) under `auto`; under
 * `review` only the draft whose hash the newest approval names.
 */
export function releaseNotesDecision(
  cwd: string,
  plan: Pick<FinishPlan, "version" | "track" | "tag" | "tagPrefix" | "production" | "changelog">,
): ReleaseNotesDecision {
  const setting = workspaceReleaseNotes(cwd, plan.track);
  const where =
    setting.from === "track" ? `release track ${plan.track}` : `workspace ${setting.workspace}`;
  if (setting.mode === "off")
    return {
      publish: false,
      mode: "off",
      reason: `releaseNotes is off (${where}): no forge release`,
    };
  const draft = readReleaseNotesDraft(cwd, plan.version);
  if (setting.mode === "review") {
    const approved = latestReleaseNotesApproval(cwd, plan.version);
    const draftCmd = `workit release notes draft ${plan.version}`;
    const approveCmd = `workit release notes approve ${plan.version}`;
    if (!draft)
      return {
        publish: false,
        mode: "review",
        blocked: `release_notes_unapproved: releaseNotes is review (${where}) and ${plan.version} has no draft`,
        unblock: `${draftCmd}  # write the Highlights, show the user, then ask the user to run, in a terminal outside the agent host: ${approveCmd}`,
      };
    if (!approved || approved.sha256 !== draft.sha256)
      return {
        publish: false,
        mode: "review",
        blocked: `release_notes_unapproved: releaseNotes is review (${where}) and the draft of ${plan.version} (${draft.path}) ${approved ? "changed after the user approved it" : "is not approved"}`,
        unblock: `ask the user to run, in a terminal outside the agent host (not Claude Code's \`!\` prefix or an agent shell): ${approveCmd}  # the draft: ${draftCmd}`,
      };
    return {
      publish: true,
      mode: "review",
      body: draft.notes,
      source: "draft",
    };
  }
  if (draft) return { publish: true, mode: "auto", body: draft.notes, source: "draft" };
  return {
    publish: true,
    mode: "auto",
    source: "changelog",
    body: renderReleaseNotes({
      version: plan.version,
      changelog: plan.changelog,
      compare: compareLink(cwd, plan.production, plan.tagPrefix, plan.version, plan.tag).compare,
    }),
  };
}

/**
 * The notes decision for a release tag `workit git push --release` pushes
 * (the release PR path: the tag is made after the PR merged). The changelog
 * section is read at the tag.
 */
export function releaseNotesForTag(
  cwd: string,
  tag: {
    name: string;
    production: string;
    version: string;
    track: string | null;
    tagPrefix: string;
  },
): ReleaseNotesDecision {
  return releaseNotesDecision(cwd, {
    version: tag.version,
    track: tag.track,
    tag: tag.name,
    tagPrefix: tag.tagPrefix,
    production: tag.production,
    changelog: changelogSection(cwd, `refs/tags/${tag.name}`, tag.version),
  });
}
