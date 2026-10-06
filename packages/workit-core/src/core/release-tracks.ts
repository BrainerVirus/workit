// Release tracks at runtime: one repository, several independent release lines
// (e.g. `nun-develop` -> `nun-master` beside `develop` -> `master`). The
// workspace's `releaseTracks` (workspaces.ts) name each line; this module
// decides which line a branch belongs to, so branch creation, PR targets,
// merges and the branch policy follow that line instead of one workspace-wide
// default.
//
// - readReleaseTracks is the lenient runtime reader (D17): an unknown or
//   malformed track field is reported and skipped (the track is dropped when
//   it lacks a usable production or integration branch), unless the track
//   lists that field in its `critical` array, in which case the read fails
//   closed so an older Workit never routes work on a track it misreads.
// - resolveReleaseTrack is pure: git facts come through an injected probe, so
//   the decision table is testable without a repository. Resolution order,
//   cheapest deterministic signal first:
//     1. an explicit track (`--track`, WORKFLOW_RELEASE_TRACK);
//     2. the branch is a track's integration, production or base branch;
//     3. only one track is configured;
//     4. the base `workit git branch` recorded for the branch
//        (git config branch.<b>.workitBase), followed through stacked
//        parents;
//     5. the reflog's "Created from <ref>" when it names a track branch;
//     6. ancestry: the track whose integration (or base) branch the branch
//        is fewest commits ahead of, then fewest behind.
//   A tie or no usable signal falls back to the workspace default (the track
//   whose integration branch or PR target is the configured default target,
//   else the legacy default) and says so in `warnings`; it never guesses.
// - No configured tracks: status "none", and every caller keeps its legacy
//   behavior unchanged.
import { spawnSync } from "node:child_process";
import { aheadBehind, currentBranch, pushRemoteName, resolveRef } from "../git/rev";
import { resolveRuntimeReleaseTracks } from "./workspaces";

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
};

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const branchName = (value: unknown): string | null =>
  typeof value === "string" && value.trim() && !value.trim().startsWith("-") ? value.trim() : null;

/** Lenient read of a workspace's raw `releaseTracks` value (D17). */
export function readReleaseTracks(raw: unknown): ReleaseTracksRead {
  const out: ReleaseTracksRead = { tracks: [], issues: [], error: null };
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) {
    out.issues.push("releaseTracks is not an object; ignored");
    return out;
  }
  const fatal: string[] = [];
  for (const [name, entry] of Object.entries(raw).toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    const label = `release track ${JSON.stringify(name)}`;
    if (!name.trim()) {
      out.issues.push("a release track with a blank name was ignored");
      continue;
    }
    if (!isRecord(entry)) {
      out.issues.push(`${label} is not an object; ignored`);
      continue;
    }
    const critical = new Set(
      Array.isArray(entry.critical)
        ? entry.critical.filter((item): item is string => typeof item === "string")
        : [],
    );
    const problem = (field: string, message: string) => {
      if (critical.has(field)) fatal.push(`${label} ${field}: ${message}`);
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
          if (typeof template === "string" && template.trim()) naming[kind] = template.trim();
          else problem(`naming.${kind}`, "not a template string; ignored");
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

/** A naming template as an allowed-branch glob (`feature/{name}` -> `feature/*`). */
export const namingGlob = (template: string): string => template.replace(/\{[^}]*\}/gu, "*");

/** The branch name a track's naming gives `<kind>/<slug>`; null when it has no template. */
export const trackBranchName = (
  track: Pick<RuntimeReleaseTrack, "naming"> | null,
  kind: string,
  slug: string,
): string | null => {
  const template = track?.naming[kind as keyof RuntimeReleaseTrack["naming"]];
  if (!template) return null;
  return /\{[^}]*\}/u.test(template)
    ? template.replace(/\{[^}]*\}/gu, slug)
    : `${template.replace(/\/?\*?$/u, "")}/${slug}`;
};

/** Git facts the resolver needs, injected so the decision itself stays pure. */
export type TrackProbe = {
  /** The base `workit git branch` recorded for a branch, if any. */
  recordedBase: (branch: string) => string | null;
  /** The ref the reflog says the branch was created from, if any. */
  createdFrom: (branch: string) => string | null;
  /** Commits the branch has that `trackBranch` lacks (ahead) and vice versa. */
  distance: (branch: string, trackBranch: string) => { ahead: number; behind: number } | null;
};

export type TrackSource =
  | "flag"
  | "branch"
  | "only-track"
  | "recorded-base"
  | "reflog"
  | "ancestry"
  | "default";

export type TrackResolution =
  | { status: "none"; issues: string[] }
  | {
      status: "resolved";
      /** Null only when falling back with no track matching the workspace default. */
      track: RuntimeReleaseTrack | null;
      source: TrackSource;
      detail: string;
      warnings: string[];
      tracks: RuntimeReleaseTrack[];
    }
  | { status: "invalid"; error: string; issues: string[] };

export type TrackInput = {
  tracks: readonly RuntimeReleaseTrack[];
  /** `--track` / WORKFLOW_RELEASE_TRACK. */
  requested?: string | null;
  /** The branch being resolved (current branch, or a PR base); null when detached. */
  branch: string | null;
  /** The workspace's legacy default target (vcs.defaultTargetBranch or policy default). */
  defaultBranch: string | null;
  probe: TrackProbe;
  /** Problems the reader reported; carried into the warnings. */
  issues?: readonly string[];
};

const ownedBy = (tracks: readonly RuntimeReleaseTrack[], branch: string): RuntimeReleaseTrack[] =>
  tracks.filter((track) =>
    [track.integrationBranch, track.productionBranch, track.baseBranch].includes(branch),
  );

/** Strip `refs/heads/`, `refs/remotes/<remote>/` and a leading `origin/`. */
const shortRef = (ref: string): string =>
  ref
    .replace(/^refs\/heads\//u, "")
    .replace(/^refs\/remotes\/[^/]+\//u, "")
    .replace(/^origin\//u, "");

const MAX_RECORDED_HOPS = 10;

/** Pick the release track for a branch. Pure: git facts come from `probe`. */
export function resolveReleaseTrack(input: TrackInput): TrackResolution {
  const tracks = [...input.tracks];
  const issues = [...(input.issues ?? [])];
  if (tracks.length === 0) return { status: "none", issues };
  const done = (
    track: RuntimeReleaseTrack | null,
    source: TrackSource,
    detail: string,
    warnings: string[] = [],
  ): TrackResolution => ({
    status: "resolved",
    track,
    source,
    detail,
    warnings: [...issues, ...warnings],
    tracks,
  });

  const requested = input.requested?.trim();
  if (requested) {
    const named = tracks.find((track) => track.name === requested);
    if (!named)
      return {
        status: "invalid",
        error: `no release track ${JSON.stringify(requested)}; configured: ${tracks.map((track) => track.name).join(", ")}`,
        issues,
      };
    return done(named, "flag", `track ${named.name} was requested explicitly`);
  }

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
    return done(track, "default", `${why}; using the workspace ${target}`, [
      `release track not determined: ${why}; using the workspace ${target} (pass --track <name> to choose)`,
    ]);
  };
  const branch = input.branch;
  if (!branch) return fallback("HEAD is detached");

  // A track's own long-lived branch: no history needed.
  const owners = ownedBy(tracks, branch);
  if (owners.length === 1)
    return done(owners[0], "branch", `${branch} is a ${owners[0].name} branch`);
  if (owners.length > 1)
    return fallback(
      `${branch} belongs to more than one track (${owners.map((track) => track.name).join(", ")})`,
    );
  if (tracks.length === 1)
    return done(tracks[0], "only-track", `${tracks[0].name} is the only track`);

  // The base workit recorded when it created the branch, followed through
  // stacked parents (feature/b on feature/a on develop).
  let cursor = branch;
  const seen = new Set<string>([branch]);
  for (let hop = 0; hop < MAX_RECORDED_HOPS; hop += 1) {
    const recorded = input.probe.recordedBase(cursor);
    if (!recorded) break;
    const base = shortRef(recorded);
    const owner = ownedBy(tracks, base);
    if (owner.length === 1)
      return done(owner[0], "recorded-base", `${branch} was created from ${base}`);
    if (owner.length > 1 || seen.has(base)) break;
    seen.add(base);
    cursor = base;
  }

  const created = input.probe.createdFrom(branch);
  if (created) {
    const base = shortRef(created);
    const owner = ownedBy(tracks, base);
    if (owner.length === 1)
      return done(owner[0], "reflog", `${branch} was created from ${base} (reflog)`);
  }

  // Ancestry: the closest track by (ahead, behind) against its integration
  // and base branches.
  type Scored = { track: RuntimeReleaseTrack; ref: string; ahead: number; behind: number };
  const scored: Scored[] = [];
  for (const track of tracks) {
    let best: Scored | null = null;
    for (const ref of new Set([track.integrationBranch, track.baseBranch])) {
      const distance = input.probe.distance(branch, ref);
      if (!distance) continue;
      const candidate = { track, ref, ...distance };
      if (
        !best ||
        candidate.ahead < best.ahead ||
        (candidate.ahead === best.ahead && candidate.behind < best.behind)
      )
        best = candidate;
    }
    if (best) scored.push(best);
  }
  if (scored.length === 0)
    return fallback(`no track branch could be compared with ${branch} (fetch the track branches)`);
  scored.sort((a, b) => a.ahead - b.ahead || a.behind - b.behind);
  const [first, second] = scored;
  if (second && second.ahead === first.ahead && second.behind === first.behind)
    return fallback(
      `${branch} is equally close to ${scored
        .filter((item) => item.ahead === first.ahead && item.behind === first.behind)
        .map((item) => `${item.ref} (${item.track.name})`)
        .join(" and ")}`,
    );
  return done(
    first.track,
    "ancestry",
    `${branch} is ${first.ahead} ahead / ${first.behind} behind ${first.ref}${second ? `, closer than ${second.ref} (${second.ahead} ahead / ${second.behind} behind)` : ""}`,
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

export function gitTrackProbe(cwd: string): TrackProbe {
  const remote = pushRemoteName(cwd) ?? "origin";
  const tip = (branch: string): string | null =>
    resolveRef(cwd, `refs/remotes/${remote}/${branch}`) ?? resolveRef(cwd, `refs/heads/${branch}`);
  return {
    recordedBase: (branch) => git(cwd, ["config", "--get", recordedBaseKey(branch)]) || null,
    createdFrom: (branch) => {
      const log = git(cwd, ["reflog", "show", "--format=%gs", `refs/heads/${branch}`, "--"]);
      const oldest = log?.split("\n").findLast(Boolean) ?? "";
      const match = /^branch: Created from (\S+)$/u.exec(oldest);
      return match && match[1] !== "HEAD" ? match[1] : null;
    },
    distance: (branch, trackBranch) => {
      const head = resolveRef(cwd, `refs/heads/${branch}`);
      const base = tip(trackBranch);
      if (!head || !base) return null;
      const counted = aheadBehind(cwd, base, head);
      return counted ? { ahead: counted.ahead, behind: counted.behind } : null;
    },
  };
}

/** The tracks configured for the workspace matching cwd (lenient). */
export function workspaceReleaseTracks(cwd: string): ReleaseTracksRead & {
  workspace: string | null;
} {
  const raw = resolveRuntimeReleaseTracks(cwd);
  return { workspace: raw?.workspace ?? null, ...readReleaseTracks(raw?.releaseTracks) };
}

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
  if (read.tracks.length === 0) return { status: "none", issues: read.issues };
  return resolveReleaseTrack({
    tracks: read.tracks,
    requested: options.track ?? (process.env.WORKFLOW_RELEASE_TRACK?.trim() || null),
    branch: options.branch === undefined ? currentBranch(cwd) : options.branch,
    defaultBranch: options.defaultBranch,
    probe: options.probe ?? gitTrackProbe(cwd),
    issues: read.issues,
  });
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
 * The configured tracks and the one cwd resolves to. `defaultBranch` is the
 * workspace default target before tracks (vcsConfig's
 * workspaceDefaultTargetBranch); omitted, the workspace's own
 * vcs.defaultTargetBranch or branchPolicy.developBranch is used, which keeps
 * this importable from the doctor without the VCS resolver.
 */
export function releaseTracksReport(
  cwd: string,
  defaultBranch?: string | null,
): ReleaseTracksReport {
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
  const resolution = resolveTrackFor(cwd, {
    defaultBranch: defaultBranch === undefined ? (raw?.defaultTargetBranch ?? null) : defaultBranch,
  });
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
