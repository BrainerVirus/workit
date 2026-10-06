// Release tracks at runtime: one repository, several independent release lines
// (e.g. `nun-develop` -> `nun-master` beside `develop` -> `master`). The
// workspace's `releaseTracks` (workspaces.ts) name each line; this module
// decides which line a branch belongs to, so branch creation, PR targets,
// merges and the branch policy follow that line instead of one workspace-wide
// default.
//
// - readReleaseTracks is the lenient runtime reader (D17): an unknown or
//   malformed track field is reported and ignored (the track is dropped when
//   it lacks a usable production or integration branch, but every branch it
//   names stays protected), unless the track lists that field (or a parent of
//   it) in its `critical` array, in which case the read fails closed so an
//   older Workit never routes work on a track it misreads.
// - resolveReleaseTrack is pure: git facts come through an injected probe, so
//   the decision table is testable without a repository. Resolution order,
//   cheapest deterministic signal first:
//     1. an explicit `--track`;
//     2. the branch is a track's integration, production or base branch;
//     3. WORKFLOW_RELEASE_TRACK (a host session's choice);
//     4. only one track, when the workspace default target is on it;
//     5. the base `workit git branch` recorded for the branch
//        (git config branch.<b>.workitBase), followed through stacked
//        parents;
//     6. the branch reflog's "Created from <track branch>";
//     7. for a branch created at HEAD (plain `git checkout -b` / `switch -c`,
//        branch reflog "Created from HEAD"), the HEAD reflog's
//        "checkout: moving from <track branch> to <b>";
//     8. ancestry by fork point: the track whose merge-base with the branch
//        strictly descends from every other track's merge-base.
//   When the workspace default target belongs to no track it is an implicit
//   line of its own (resolving to it means "no track": the legacy default).
//   A tie or no usable signal falls back to the workspace default and says so
//   in `warnings`; with two or more tracks it also sets `blocking`, which
//   mutating verbs (git branch, pr create, stack plan) refuse on. It never
//   guesses.
// - No configured tracks: status "none", and every caller keeps its legacy
//   behavior unchanged (an explicit `--track` is then an error).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { currentBranch, mergeBase, pushRemoteName, remoteNames, resolveRef } from "../git/rev";
import { readFileSync } from "node:fs";
import { vcsConfigPath } from "./config";
import { resolveRuntimeReleaseTracks, workspaceDefaultTarget } from "./workspaces";

export type RuntimeReleaseTrack = {
  name: string;
  productionBranch: string;
  integrationBranch: string;
  /** Where new work branches start; defaults to the integration branch. */
  baseBranch: string;
  /** Where work branch PRs go; defaults to the integration branch. */
  pullRequestTarget: string;
  /** Branches a change landed on the production branch must flow back into. */
  mergeBackBranches: string[];
  /** Branch name templates (`feature/{name}`, `release/{version}`, …). */
  naming: { feature?: string; release?: string; hotfix?: string };
};

export type ReleaseTracksRead = {
  tracks: RuntimeReleaseTrack[];
  /** Reported, non-fatal problems (unknown or malformed fields, dropped tracks). */
  issues: string[];
  /** Set when a problem touches a field a track marked `critical`: fail closed. */
  error: string | null;
  /**
   * Every branch name any track entry names, usable or not: the protected
   * union is built from this, so a dropped track never loses protection.
   */
  protectedBranches: string[];
};

/** A release-track problem that must fail closed; callers turn it into a refusal. */
export class ReleaseTrackError extends Error {}

const KNOWN_FIELDS = new Set([
  "strategy",
  "productionBranch",
  "integrationBranch",
  "naming",
  "baseBranch",
  "mergeBackBranches",
  "pullRequestTarget",
  "tagNamespace",
  "versionSource",
  "requiredChecks",
  "critical",
]);
const BRANCH_FIELDS = ["productionBranch", "integrationBranch", "baseBranch", "pullRequestTarget"];
const PLACEHOLDER = /\{[^}]*\}/gu;
const HAS_PLACEHOLDER = /\{[^}]*\}/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const branchName = (value: unknown): string | null =>
  typeof value === "string" && value.trim() && !value.trim().startsWith("-") ? value.trim() : null;

/** Every branch-valued string an entry names, whatever else is wrong with it. */
const namedBranches = (entry: Record<string, unknown>): string[] =>
  [
    ...BRANCH_FIELDS.map((field) => branchName(entry[field])),
    ...(Array.isArray(entry.mergeBackBranches) ? entry.mergeBackBranches.map(branchName) : []),
  ].filter((name): name is string => name !== null);

/** A naming template needs literal text besides placeholders and globs, or it would allow anything. */
const literalOf = (template: string): string =>
  template.replace(PLACEHOLDER, "").replace(/[*/]/gu, "").trim();

/** Lenient read of a workspace's raw `releaseTracks` value (D17). */
export function readReleaseTracks(raw: unknown): ReleaseTracksRead {
  const out: ReleaseTracksRead = { tracks: [], issues: [], error: null, protectedBranches: [] };
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) {
    out.issues.push("releaseTracks is not an object; ignored");
    return out;
  }
  const fatal: string[] = [];
  const protectedNames = new Set<string>();
  for (const [name, entry] of Object.entries(raw).toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    const label = `release track ${JSON.stringify(name)}`;
    if (!isRecord(entry)) {
      out.issues.push(`${label} is not an object; ignored`);
      continue;
    }
    for (const branch of namedBranches(entry)) protectedNames.add(branch);
    if (!name.trim()) {
      out.issues.push("a release track with a blank name was ignored");
      continue;
    }
    let critical: string[] = [];
    if (Array.isArray(entry.critical))
      critical = entry.critical.filter((item): item is string => typeof item === "string");
    else if (entry.critical !== undefined)
      out.issues.push(`${label} critical: must be a list of field names; ignored`);
    // A critical entry covers the field and everything under it (`naming` covers `naming.feature`).
    const isCritical = (field: string) =>
      critical.some((item) => field === item || field.startsWith(`${item}.`));
    const problem = (field: string, message: string) => {
      if (isCritical(field)) fatal.push(`${label} ${field}: ${message}`);
      else out.issues.push(`${label} ${field}: ${message}`);
    };
    for (const key of Object.keys(entry))
      if (!KNOWN_FIELDS.has(key)) problem(key, "unknown field, ignored");
    const productionBranch = branchName(entry.productionBranch);
    const integrationBranch = branchName(entry.integrationBranch);
    if (!productionBranch) problem("productionBranch", "missing or not a branch name");
    if (!integrationBranch) problem("integrationBranch", "missing or not a branch name");
    const optionalBranch = (field: "baseBranch" | "pullRequestTarget"): string | null => {
      if (entry[field] === undefined) return null;
      const value = branchName(entry[field]);
      if (!value) problem(field, "not a branch name; using the integration branch");
      return value;
    };
    const baseBranch = optionalBranch("baseBranch");
    const pullRequestTarget = optionalBranch("pullRequestTarget");
    let mergeBackBranches: string[] = [];
    if (entry.mergeBackBranches !== undefined) {
      const list = Array.isArray(entry.mergeBackBranches)
        ? entry.mergeBackBranches.map(branchName)
        : [null];
      if (list.some((item) => item === null))
        problem("mergeBackBranches", "must be a list of branch names; ignored");
      else mergeBackBranches = [...new Set(list as string[])];
    }
    const naming: RuntimeReleaseTrack["naming"] = {};
    if (entry.naming !== undefined) {
      if (!isRecord(entry.naming)) problem("naming", "not an object; ignored");
      else
        for (const kind of ["feature", "release", "hotfix"] as const) {
          const template = entry.naming[kind];
          if (template === undefined) continue;
          if (typeof template !== "string" || !template.trim())
            problem(`naming.${kind}`, "not a template string; ignored");
          else if (!literalOf(template))
            problem(`naming.${kind}`, "needs literal text besides placeholders; ignored");
          else naming[kind] = template.trim();
        }
    }
    if (!productionBranch || !integrationBranch) {
      out.issues.push(`${label} was skipped: it needs a productionBranch and integrationBranch`);
      continue;
    }
    out.tracks.push({
      name,
      productionBranch,
      integrationBranch,
      baseBranch: baseBranch ?? integrationBranch,
      pullRequestTarget: pullRequestTarget ?? integrationBranch,
      mergeBackBranches,
      naming,
    });
  }
  out.protectedBranches = [...protectedNames];
  if (fatal.length)
    out.error = `workspace releaseTracks cannot be read by this Workit (${fatal.join("; ")}); upgrade Workit or fix the track`;
  return out;
}

/** Every long-lived branch the tracks name: protected by the branch policy. */
export const trackBranches = (tracks: readonly RuntimeReleaseTrack[]): string[] => [
  ...new Set(
    tracks.flatMap((track) => [
      track.productionBranch,
      track.integrationBranch,
      track.baseBranch,
      track.pullRequestTarget,
      ...track.mergeBackBranches,
    ]),
  ),
];

/**
 * A naming template as an allowed-branch glob: `feature/{name}` -> `feature/*`;
 * a template without a placeholder is a prefix (`nun/feature` -> `nun/feature/*`).
 */
export const namingGlob = (template: string): string =>
  HAS_PLACEHOLDER.test(template)
    ? template.replace(PLACEHOLDER, "*")
    : `${template.replace(/\/?\*?$/u, "")}/*`;

/** The branch name a track's naming gives `<kind>/<slug>`; null when it has no template. */
export const trackBranchName = (
  track: Pick<RuntimeReleaseTrack, "naming"> | null,
  kind: string,
  slug: string,
): string | null => {
  const template = track?.naming[kind as keyof RuntimeReleaseTrack["naming"]];
  if (!template) return null;
  return HAS_PLACEHOLDER.test(template)
    ? template.replace(PLACEHOLDER, slug)
    : `${template.replace(/\/?\*?$/u, "")}/${slug}`;
};

/** Git facts the resolver needs, injected so the decision itself stays pure. */
export type TrackProbe = {
  /** Configured remote names (for stripping `<remote>/` from recorded refs). */
  remotes: () => string[];
  /** The base `workit git branch` recorded for a branch, if any. */
  recordedBase: (branch: string) => string | null;
  /** The branch reflog's "Created from <ref>", if it names a ref (not HEAD). */
  createdFrom: (branch: string) => string | null;
  /**
   * For a branch created at HEAD (`git checkout -b` / `switch -c` without a
   * start point), the HEAD reflog's oldest "checkout: moving from <X> to <branch>": X.
   */
  checkedOutFrom: (branch: string) => string | null;
  /** The fork point (merge-base) of a branch and a track branch, or null. */
  mergeBase: (branch: string, trackBranch: string) => string | null;
  /** True when commit `ancestor` is in the history of commit `descendant`. */
  isAncestor: (ancestor: string, descendant: string) => boolean;
};

export type TrackSource =
  | "flag"
  | "env"
  | "branch"
  | "only-track"
  | "recorded-base"
  | "reflog"
  | "checkout"
  | "ancestry"
  | "default";

export type TrackResolution =
  | { status: "none"; issues: string[] }
  | {
      status: "resolved";
      /** Null: the legacy workspace default line (no track applies). */
      track: RuntimeReleaseTrack | null;
      source: TrackSource;
      detail: string;
      warnings: string[];
      tracks: RuntimeReleaseTrack[];
      /**
       * Set when the line could not be decided (or WORKFLOW_RELEASE_TRACK is
       * wrong): read-only verbs warn, mutating verbs refuse with this.
       */
      blocking: string | null;
    }
  | { status: "invalid"; error: string; issues: string[] };

export type TrackInput = {
  tracks: readonly RuntimeReleaseTrack[];
  /** An explicit `--track`. */
  requested?: string | null;
  /** WORKFLOW_RELEASE_TRACK: below "the branch is a track branch". */
  envRequested?: string | null;
  /** The branch being resolved (current branch, or a base); null when detached. */
  branch: string | null;
  /** The workspace's legacy default target (vcs.defaultTargetBranch or policy default). */
  defaultBranch: string | null;
  probe: TrackProbe;
  /** Problems the reader reported; carried into the warnings. */
  issues?: readonly string[];
};

/** The implicit track standing for the legacy default line; resolving to it yields no track. */
const IMPLICIT = "";

const ownedBy = (tracks: readonly RuntimeReleaseTrack[], branch: string): RuntimeReleaseTrack[] =>
  tracks.filter((track) =>
    [track.integrationBranch, track.productionBranch, track.baseBranch].includes(branch),
  );

/** Strip `refs/heads/`, `refs/remotes/<remote>/` and a leading `<remote>/`. */
const shortRef = (ref: string, remotes: readonly string[]): string => {
  const bare = ref.replace(/^refs\/heads\//u, "").replace(/^refs\/remotes\/[^/]+\//u, "");
  const remote = remotes.find((name) => bare.startsWith(`${name}/`));
  return remote ? bare.slice(remote.length + 1) : bare;
};

const MAX_RECORDED_HOPS = 10;

/** Pick the release track for a branch. Pure: git facts come from `probe`. */
export function resolveReleaseTrack(input: TrackInput): TrackResolution {
  const tracks = [...input.tracks];
  const issues = [...(input.issues ?? [])];
  const requested = input.requested?.trim();
  if (tracks.length === 0) {
    if (requested)
      return {
        status: "invalid",
        error: `no release tracks configured for this workspace; --track ${requested} cannot apply`,
        issues,
      };
    return { status: "none", issues };
  }
  const names = tracks.map((track) => track.name).join(", ");
  let envProblem: string | null = null;
  const done = (
    track: RuntimeReleaseTrack | null,
    source: TrackSource,
    detail: string,
    warnings: string[] = [],
    ambiguous: string | null = null,
  ): TrackResolution => ({
    status: "resolved",
    track: track && track.name !== IMPLICIT ? track : null,
    source,
    detail,
    warnings: [...issues, ...(envProblem ? [envProblem] : []), ...warnings],
    tracks,
    blocking: envProblem ?? ambiguous,
  });

  if (requested) {
    const named = tracks.find((track) => track.name === requested);
    if (!named)
      return {
        status: "invalid",
        error: `no release track ${JSON.stringify(requested)}; configured: ${names}`,
        issues,
      };
    return done(named, "flag", `track ${named.name} was requested explicitly`);
  }

  // The legacy default line, when no track owns it, competes as an implicit track.
  const owned = (branch: string | null) =>
    branch !== null &&
    tracks.some((track) =>
      [
        track.integrationBranch,
        track.productionBranch,
        track.baseBranch,
        track.pullRequestTarget,
      ].includes(branch),
    );
  const implicit: RuntimeReleaseTrack | null =
    input.defaultBranch && !owned(input.defaultBranch)
      ? {
          name: IMPLICIT,
          productionBranch: input.defaultBranch,
          integrationBranch: input.defaultBranch,
          baseBranch: input.defaultBranch,
          pullRequestTarget: input.defaultBranch,
          mergeBackBranches: [],
          naming: {},
        }
      : null;
  const candidates = implicit ? [...tracks, implicit] : tracks;
  const label = (track: RuntimeReleaseTrack) =>
    track.name === IMPLICIT
      ? `the workspace default line (${track.integrationBranch})`
      : `track ${track.name}`;

  const fallback = (why: string): TrackResolution => {
    const byDefault = input.defaultBranch
      ? tracks.filter(
          (track) =>
            track.integrationBranch === input.defaultBranch ||
            track.pullRequestTarget === input.defaultBranch,
        )
      : [];
    const track = byDefault.length === 1 ? byDefault[0] : null;
    const target = track
      ? `track ${track.name}`
      : `default target ${input.defaultBranch ?? "(none)"}`;
    // Count lines, not configured tracks: one track beside a distinct default
    // line is still two lines to choose between.
    const ambiguous =
      candidates.length >= 2
        ? `can't tell which release line ${input.branch ?? "HEAD"} is on (${why}); pass --track <name> (${names}) or --base <branch>`
        : null;
    return done(
      track,
      "default",
      `${why}; using the workspace ${target}`,
      [
        `release track not determined: ${why}; using the workspace ${target} (pass --track <name> to choose)`,
      ],
      ambiguous,
    );
  };
  const branch = input.branch;

  // A track's own long-lived branch: no history needed, and nothing outranks it but --track.
  if (branch) {
    const owners = ownedBy(candidates, branch);
    if (owners.length === 1)
      return done(owners[0], "branch", `${branch} is a branch of ${label(owners[0])}`);
    if (owners.length > 1)
      return fallback(
        `${branch} belongs to more than one track (${owners.map((track) => track.name).join(", ")})`,
      );
  }

  const env = input.envRequested?.trim();
  if (env) {
    const named = tracks.find((track) => track.name === env);
    if (named) return done(named, "env", `WORKFLOW_RELEASE_TRACK selects track ${named.name}`);
    envProblem = `WORKFLOW_RELEASE_TRACK=${env} names no release track of this workspace (${names}); ignored`;
  }

  if (!branch) return fallback("HEAD is detached");
  if (tracks.length === 1 && !implicit)
    return done(tracks[0], "only-track", `${tracks[0].name} is the only track`);

  let remotes: readonly string[] | null = null;
  const short = (ref: string) => shortRef(ref, (remotes ??= input.probe.remotes()));
  const ownerOf = (ref: string): RuntimeReleaseTrack | null => {
    const owner = ownedBy(candidates, short(ref));
    return owner.length === 1 ? owner[0] : null;
  };

  // The base workit recorded when it created a branch, followed through
  // stacked parents (feature/b on feature/a on develop).
  const followRecorded = (start: string): RuntimeReleaseTrack | null => {
    let cursor = start;
    const seen = new Set<string>([start]);
    for (let hop = 0; hop < MAX_RECORDED_HOPS; hop += 1) {
      const recorded = input.probe.recordedBase(cursor);
      if (!recorded) return null;
      const base = short(recorded);
      const owner = ownerOf(base);
      if (owner) return owner;
      if (ownedBy(candidates, base).length > 1 || seen.has(base)) return null;
      seen.add(base);
      cursor = base;
    }
    return null;
  };
  const recordedOwner = followRecorded(branch);
  if (recordedOwner)
    return done(
      recordedOwner,
      "recorded-base",
      `${branch} was created on ${label(recordedOwner)}'s line (recorded base)`,
    );

  // Where the branch started, from the reflogs; a start that is itself a
  // stacked work branch is followed through its recorded base.
  for (const source of ["reflog", "checkout"] as const) {
    const ref =
      source === "reflog" ? input.probe.createdFrom(branch) : input.probe.checkedOutFrom(branch);
    if (!ref) continue;
    const owner = ownerOf(ref) ?? followRecorded(short(ref));
    if (owner)
      return done(
        owner,
        source,
        `${branch} was created from ${short(ref)} (${source === "reflog" ? "branch reflog" : "HEAD reflog"})`,
      );
  }

  // Ancestry by fork point: a line wins only when its merge-base with the
  // branch strictly descends from every other line's merge-base. Equal fork
  // points (a line forked from another, or one that merges the other in) are
  // ambiguous, never a guess by commit counts.
  type Fork = { track: RuntimeReleaseTrack; ref: string; sha: string };
  const forks: Fork[] = [];
  for (const track of candidates)
    for (const ref of new Set([track.integrationBranch, track.baseBranch])) {
      const sha = input.probe.mergeBase(branch, ref);
      if (sha) forks.push({ track, ref, sha });
    }
  if (forks.length === 0)
    return fallback(`no track branch could be compared with ${branch} (fetch the track branches)`);
  const ancestry = new Map<string, boolean>();
  const descends = (older: string, newer: string): boolean => {
    if (older === newer) return false;
    const key = `${older}>${newer}`;
    if (!ancestry.has(key)) ancestry.set(key, input.probe.isAncestor(older, newer));
    return ancestry.get(key) as boolean;
  };
  const winners = forks.filter((fork) =>
    forks.every((other) => other.track === fork.track || descends(other.sha, fork.sha)),
  );
  const winningTracks = [...new Set(winners.map((fork) => fork.track))];
  if (winningTracks.length === 1 && forks.some((fork) => fork.track !== winningTracks[0])) {
    const win = winners[0];
    return done(
      win.track,
      "ancestry",
      `${branch} forked from ${win.ref} at ${win.sha.slice(0, 12)}, after every other line's fork point`,
    );
  }
  if (winningTracks.length === 1)
    return fallback(`only ${label(winningTracks[0])} could be compared with ${branch}`);
  const newest = forks.filter((fork) => !forks.some((other) => descends(fork.sha, other.sha)));
  return fallback(
    `${branch} has the same or unrelated fork points with ${[...new Set(newest.map((fork) => `${fork.ref} (${fork.track.name === IMPLICIT ? "workspace default" : fork.track.name})`))].join(" and ")}`,
  );
}

// ---------------------------------------------------------------------------
// git-backed probe and the workspace entry point

const git = (cwd: string, args: string[]): string | null => {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return run.status === 0 ? (run.stdout ?? "").trim() : null;
};

/** The git config key `workit git branch` records a new branch's base under. */
export const recordedBaseKey = (branch: string): string => `branch.${branch}.workitBase`;

/** Record the base a new branch was created from (best effort). */
export const recordBranchBase = (cwd: string, branch: string, base: string): void => {
  git(cwd, ["config", recordedBaseKey(branch), base]);
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

type ReflogEntry = { sha: string; time: number; subject: string };

/** A ref's reflog, newest first, with unix times. */
const reflog = (cwd: string, ref: string): ReflogEntry[] =>
  (git(cwd, ["log", "-g", "--date=unix", "--format=%H%x09%gd%x09%gs", ref, "--"]) ?? "")
    .split("\n")
    .map((line) => {
      const [sha = "", selector = "", ...subject] = line.split("\t");
      return {
        sha,
        time: Number(/@\{(\d+)\}$/u.exec(selector)?.[1] ?? Number.NaN),
        subject: subject.join("\t"),
      };
    })
    .filter((entry) => entry.sha && Number.isFinite(entry.time));

export function gitTrackProbe(cwd: string): TrackProbe {
  let remote: string | null | undefined;
  let remotes: string[] | undefined;
  const tip = (branch: string): string | null => {
    remote ??= pushRemoteName(cwd) ?? "origin";
    return (
      resolveRef(cwd, `refs/remotes/${remote}/${branch}`) ?? resolveRef(cwd, `refs/heads/${branch}`)
    );
  };
  return {
    remotes: () => (remotes ??= remoteNames(cwd)),
    recordedBase: (branch) => git(cwd, ["config", "--get", recordedBaseKey(branch)]) || null,
    createdFrom: (branch) => {
      const log = git(cwd, ["reflog", "show", "--format=%gs", `refs/heads/${branch}`, "--"]);
      const oldest = log?.split("\n").findLast(Boolean) ?? "";
      const match = /^branch: Created from (\S+)$/u.exec(oldest);
      return match && match[1] !== "HEAD" ? match[1] : null;
    },
    checkedOutFrom: (branch) => {
      // Only a branch started at HEAD ("Created from HEAD"): then the branch
      // HEAD was on is its start. `switch -c b <sha>` names another start point.
      const own = reflog(cwd, `refs/heads/${branch}`);
      const created = own.at(-1);
      if (!created || created.subject !== "branch: Created from HEAD") return null;
      // A reused name leaves older "moving from X to <b>" entries behind: only
      // an entry at or after this branch's creation, landing on its creation
      // commit, counts. The oldest such entry is the creation itself (a later
      // switch back to the branch before any commit lands on the same commit).
      const pattern = new RegExp(`^checkout: moving from (\\S+) to ${escapeRegExp(branch)}$`, "u");
      const entry = reflog(cwd, "HEAD").findLast(
        (item) =>
          item.time >= created.time && item.sha === created.sha && pattern.test(item.subject),
      );
      return entry ? (pattern.exec(entry.subject)?.[1] ?? null) : null;
    },
    mergeBase: (branch, trackBranch) => {
      const base = tip(trackBranch);
      return base && resolveRef(cwd, `refs/heads/${branch}`)
        ? mergeBase(cwd, base, `refs/heads/${branch}`)
        : null;
    },
    isAncestor: (ancestor, descendant) =>
      git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]) !== null,
  };
}

/** The tracks configured for the workspace matching cwd (lenient). */
export function workspaceReleaseTracks(cwd: string): ReleaseTracksRead & {
  workspace: string | null;
} {
  const raw = resolveRuntimeReleaseTracks(cwd);
  return { workspace: raw?.workspace ?? null, ...readReleaseTracks(raw?.releaseTracks) };
}

/** vcs.json's global `defaultTargetBranch`, read leniently (display only; vcsConfig reports a malformed file). */
const globalDefaultTarget = (): unknown => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(vcsConfigPath(), "utf8"));
    return isRecord(parsed) ? parsed.defaultTargetBranch : undefined;
  } catch {
    return undefined;
  }
};

// Per-process memo: a CLI command asks several times (vcsConfig callers,
// policy checks). Keyed on every input, including a digest of all branch tips,
// so a long-lived host never sees a stale answer after a fetch or commit.
const memo = new Map<string, TrackResolution>();
const MEMO_LIMIT = 64;

/** Resolve the release track for cwd's workspace and a branch (default: HEAD). */
export function resolveTrackFor(
  cwd: string,
  options: {
    track?: string | null;
    branch?: string | null;
    defaultBranch: string | null;
    probe?: TrackProbe;
  },
): TrackResolution {
  const read = workspaceReleaseTracks(cwd);
  if (read.error) return { status: "invalid", error: read.error, issues: read.issues };
  if (read.tracks.length === 0 && !options.track?.trim())
    return { status: "none", issues: read.issues };
  const branch = options.branch === undefined ? currentBranch(cwd) : options.branch;
  const envRequested = process.env.WORKFLOW_RELEASE_TRACK?.trim() || null;
  const input = {
    tracks: read.tracks,
    requested: options.track ?? null,
    envRequested,
    branch,
    defaultBranch: options.defaultBranch,
    issues: read.issues,
  };
  let key: string | null = null;
  if (!options.probe) {
    const refs =
      git(cwd, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads",
        "refs/remotes",
      ]) ?? "";
    const head = git(cwd, ["reflog", "show", "-n", "1", "--format=%H %gs", "HEAD", "--"]) ?? "";
    // A deleted and recreated branch name, or a changed recorded base, must miss.
    const own = branch
      ? [
          git(cwd, [
            "log",
            "-g",
            "-n",
            "1",
            "--date=unix",
            "--format=%H %gd %gs",
            `refs/heads/${branch}`,
            "--",
          ]) ?? "",
          git(cwd, ["config", "--get", recordedBaseKey(branch)]) ?? "",
        ]
      : [];
    key = createHash("sha256")
      .update(JSON.stringify({ cwd, input, refs, head, own }))
      .digest("hex");
    const hit = memo.get(key);
    if (hit) return hit;
  }
  const resolution = resolveReleaseTrack({ ...input, probe: options.probe ?? gitTrackProbe(cwd) });
  if (key) {
    if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value as string);
    memo.set(key, resolution);
  }
  return resolution;
}

/** What `workit grant show` and `workit doctor` print about release tracks. */
export type ReleaseTracksReport = {
  workspace: string | null;
  tracks: { name: string; integrationBranch: string; productionBranch: string }[];
  /** The track cwd's checkout resolves to; null without tracks or on error. */
  resolved: { name: string | null; source: string; detail: string } | null;
  /** Reader issues and resolution warnings (non-fatal). */
  warnings: string[];
  /** A fatal problem (a critical track field, an unreadable config). */
  error: string | null;
};

/**
 * The configured tracks and the one cwd resolves to, for display. The default
 * target comes from workspaceDefaultTarget, the computation vcsConfig uses,
 * without importing the VCS resolver (the doctor stays light); it resolves once.
 */
export function releaseTracksReport(cwd: string): ReleaseTracksReport {
  let raw: ReturnType<typeof resolveRuntimeReleaseTracks>;
  try {
    raw = resolveRuntimeReleaseTracks(cwd);
  } catch (error) {
    return {
      workspace: null,
      tracks: [],
      resolved: null,
      warnings: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const read = readReleaseTracks(raw?.releaseTracks);
  const tracks = read.tracks.map(({ name, integrationBranch, productionBranch }) => ({
    name,
    integrationBranch,
    productionBranch,
  }));
  const base = { workspace: raw?.workspace ?? null, tracks };
  if (read.error) return { ...base, resolved: null, warnings: read.issues, error: read.error };
  if (tracks.length === 0) return { ...base, resolved: null, warnings: read.issues, error: null };
  let defaultBranch: string;
  try {
    // The same default vcsConfig uses, so the display matches the commands.
    defaultBranch = workspaceDefaultTarget(cwd, globalDefaultTarget());
  } catch (error) {
    return {
      ...base,
      resolved: null,
      warnings: read.issues,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const resolution = resolveTrackFor(cwd, { defaultBranch });
  if (resolution.status === "invalid")
    return { ...base, resolved: null, warnings: resolution.issues, error: resolution.error };
  if (resolution.status === "none")
    return { ...base, resolved: null, warnings: resolution.issues, error: null };
  return {
    ...base,
    resolved: {
      name: resolution.track?.name ?? null,
      source: resolution.source,
      detail: resolution.detail,
    },
    warnings: resolution.warnings,
    error: null,
  };
}

/** One human line per fact, shared by grant show and doctor. */
export const describeReleaseTracks = (report: ReleaseTracksReport): string[] =>
  report.tracks.length === 0 && !report.error
    ? []
    : [
        `release tracks: ${report.tracks.map((track) => `${track.name} (${track.integrationBranch} -> ${track.productionBranch})`).join(", ") || "(none usable)"}`,
        ...(report.resolved
          ? [
              `this checkout: ${report.resolved.name ?? "workspace default"} (${report.resolved.detail})`,
            ]
          : []),
        ...(report.error ? [`release tracks error: ${report.error}`] : []),
        ...report.warnings.map((warning) => `note: ${warning}`),
      ];
