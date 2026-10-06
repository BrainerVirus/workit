import { describe, expect, test } from "bun:test";
import {
  namingGlob,
  readReleaseTracks,
  resolveReleaseTrack,
  trackBranchName,
  trackBranches,
  type RuntimeReleaseTrack,
  type TrackInput,
  type TrackProbe,
} from "@/packages/workit-core/src/core/release-tracks";
import { validateWorkspacesDocument } from "@/packages/workit-core/src/core/workspaces";

// Release tracks at runtime (core/release-tracks.ts). The ri-web shape: two
// independent lines in one repository. The workspace default target is the
// `nun` line, so every "standard" expectation below fails if the resolver
// fell back to the default instead of deciding.

const RAW = {
  nun: {
    strategy: "gitflow",
    productionBranch: "nun-master",
    integrationBranch: "nun-develop",
    naming: {
      feature: "feature/nun-{name}",
      release: "release/nun-{version}",
      hotfix: "hotfix/nun-{name}",
    },
    baseBranch: "nun-develop",
    mergeBackBranches: ["nun-develop"],
    pullRequestTarget: "nun-develop",
    tagNamespace: "nun/",
    versionSource: { kind: "git-tag" },
    requiredChecks: [],
  },
  standard: {
    strategy: "gitflow",
    productionBranch: "master",
    integrationBranch: "develop",
    naming: { feature: "feature/{name}", release: "release/{version}", hotfix: "hotfix/{name}" },
    baseBranch: "develop",
    mergeBackBranches: ["develop"],
    pullRequestTarget: "develop",
    tagNamespace: "",
    versionSource: { kind: "git-tag" },
    requiredChecks: [],
  },
};
const TRACKS: RuntimeReleaseTrack[] = readReleaseTracks(RAW).tracks;
const WORKSPACE_DEFAULT = "nun-develop";

type Facts = {
  remotes?: string[];
  recorded?: Record<string, string>;
  created?: Record<string, string>;
  checkout?: Record<string, string>;
  /** `${branch}|${trackBranch}` -> merge-base commit */
  forks?: Record<string, string>;
  /** commit -> its ancestors (a toy DAG) */
  history?: Record<string, string[]>;
};
const probe = (facts: Facts = {}): TrackProbe & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    remotes: () => facts.remotes ?? ["origin"],
    recordedBase: (branch) => {
      calls.push(`recorded:${branch}`);
      return facts.recorded?.[branch] ?? null;
    },
    createdFrom: (branch) => {
      calls.push(`created:${branch}`);
      return facts.created?.[branch] ?? null;
    },
    checkedOutFrom: (branch) => {
      calls.push(`checkout:${branch}`);
      return facts.checkout?.[branch] ?? null;
    },
    mergeBase: (branch, ref) => {
      calls.push(`merge-base:${branch}|${ref}`);
      return facts.forks?.[`${branch}|${ref}`] ?? null;
    },
    isAncestor: (ancestor, descendant) => (facts.history?.[descendant] ?? []).includes(ancestor),
  };
};
const resolve = (input: Partial<TrackInput> & { branch: string | null; facts?: Facts }) =>
  resolveReleaseTrack({
    tracks: TRACKS,
    defaultBranch: WORKSPACE_DEFAULT,
    probe: probe(input.facts),
    ...input,
  });
const picked = (result: ReturnType<typeof resolveReleaseTrack>) =>
  result.status === "resolved"
    ? {
        track: result.track?.name ?? null,
        source: result.source,
        target: result.track?.pullRequestTarget ?? null,
      }
    : result;
const blocking = (result: ReturnType<typeof resolveReleaseTrack>) =>
  result.status === "resolved" ? result.blocking : "(not resolved)";

// Commits: D0 (develop's base) <- D1 <- D2 (develop tip); N1 forks nun from
// D0. A develop feature forks at D2, a nun feature at N1.
const HISTORY = { D1: ["D0"], D2: ["D0", "D1"], N1: ["D0"], N2: ["D0", "N1"] };
const FROM_DEVELOP: Facts = {
  history: HISTORY,
  forks: { "feature/x|develop": "D2", "feature/x|nun-develop": "D0" },
};
const FROM_NUN: Facts = {
  history: HISTORY,
  forks: { "feature/y|develop": "D0", "feature/y|nun-develop": "N1" },
};

describe("resolveReleaseTrack", () => {
  test("given two tracks, when branch feature/x forks from develop after nun's fork point, then the standard track and target develop", () => {
    const result = resolve({ branch: "feature/x", facts: FROM_DEVELOP });
    expect(picked(result)).toEqual({ track: "standard", source: "ancestry", target: "develop" });
    expect(blocking(result)).toBeNull();
    expect(result.status === "resolved" && result.warnings).toEqual([]);
  });

  test("given two tracks, when branch feature/y forks from nun-develop, then the nun track and target nun-develop", () => {
    expect(picked(resolve({ branch: "feature/y", facts: FROM_NUN }))).toEqual({
      track: "nun",
      source: "ancestry",
      target: "nun-develop",
    });
  });

  test("given nun forked from develop after the feature did (equal fork points), then ambiguous: the default, a warning, and blocking", () => {
    // feature/old forked at D0; nun-develop later forked from develop at D1:
    // both merge-bases are D0. Commit counts would have said "nun".
    const result = resolve({
      branch: "feature/old",
      facts: {
        history: HISTORY,
        forks: { "feature/old|develop": "D0", "feature/old|nun-develop": "D0" },
      },
    });
    expect(picked(result)).toEqual({ track: "nun", source: "default", target: "nun-develop" });
    expect(blocking(result)).toContain("can't tell which release line feature/old is on");
    expect(blocking(result)).toContain("--track");
    expect(result.status === "resolved" && result.warnings.join("\n")).toContain(
      "release track not determined",
    );
  });

  test("given unrelated fork points (neither descends from the other), then ambiguous", () => {
    const result = resolve({
      branch: "feature/z",
      facts: { history: {}, forks: { "feature/z|develop": "A", "feature/z|nun-develop": "B" } },
    });
    expect(picked(result)).toMatchObject({ source: "default" });
    expect(blocking(result)).not.toBeNull();
  });

  test("given the checkout is a track's own branch, then that track, without reading history", () => {
    const facts = probe();
    const onDevelop = resolveReleaseTrack({
      tracks: TRACKS,
      defaultBranch: WORKSPACE_DEFAULT,
      branch: "develop",
      probe: facts,
    });
    expect(picked(onDevelop)).toEqual({ track: "standard", source: "branch", target: "develop" });
    expect(picked(resolve({ branch: "master" }))).toMatchObject({ track: "standard" });
    expect(picked(resolve({ branch: "nun-master" }))).toMatchObject({ track: "nun" });
    expect(facts.calls).toEqual([]);
  });

  test("given --track, then it wins over every signal", () => {
    expect(picked(resolve({ branch: "feature/x", facts: FROM_DEVELOP, requested: "nun" }))).toEqual(
      { track: "nun", source: "flag", target: "nun-develop" },
    );
    expect(picked(resolve({ branch: "develop", requested: "nun" }))).toMatchObject({
      track: "nun",
    });
  });

  test("given an unknown --track, then resolution is invalid and names the configured tracks", () => {
    const result = resolve({ branch: "feature/x", requested: "nope" });
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.error).toContain("nun, standard");
  });

  test("given --track and no configured tracks, then invalid (never silently ignored)", () => {
    const result = resolveReleaseTrack({
      tracks: [],
      requested: "nun",
      defaultBranch: "develop",
      branch: "feature/x",
      probe: probe(),
    });
    expect(result).toMatchObject({ status: "invalid" });
    expect(result.status === "invalid" && result.error).toContain("no release tracks configured");
  });

  test("given WORKFLOW_RELEASE_TRACK, then it selects a work branch's track but never outranks a track branch", () => {
    expect(
      picked(resolve({ branch: "feature/x", facts: FROM_DEVELOP, envRequested: "nun" })),
    ).toMatchObject({ track: "nun", source: "env" });
    expect(picked(resolve({ branch: "develop", envRequested: "nun" }))).toMatchObject({
      track: "standard",
      source: "branch",
    });
  });

  test("given WORKFLOW_RELEASE_TRACK naming no track, then it is ignored with a warning and marks the resolution blocking", () => {
    const result = resolve({ branch: "feature/x", facts: FROM_DEVELOP, envRequested: "bogus" });
    expect(picked(result)).toMatchObject({ track: "standard", source: "ancestry" });
    expect(blocking(result)).toContain("WORKFLOW_RELEASE_TRACK=bogus");
    expect(result.status === "resolved" && result.warnings.join("\n")).toContain("bogus");
  });

  test("given a recorded base of develop, then standard, even when ancestry would say nun", () => {
    const result = resolve({
      branch: "feature/x",
      facts: { recorded: { "feature/x": "develop" }, ...FROM_NUN },
    });
    expect(picked(result)).toEqual({
      track: "standard",
      source: "recorded-base",
      target: "develop",
    });
  });

  test("given a stacked branch, then the recorded base is followed through its parent", () => {
    const result = resolve({
      branch: "feature/b",
      facts: { recorded: { "feature/b": "feature/a", "feature/a": "nun-develop" } },
    });
    expect(picked(result)).toEqual({
      track: "nun",
      source: "recorded-base",
      target: "nun-develop",
    });
  });

  test("given a recorded-base cycle, then it stops and falls through to the next signal", () => {
    const result = resolve({
      branch: "feature/x",
      facts: { recorded: { "feature/x": "feature/w", "feature/w": "feature/x" }, ...FROM_DEVELOP },
    });
    expect(picked(result)).toMatchObject({ track: "standard", source: "ancestry" });
  });

  test("given the branch reflog says Created from upstream/develop (any remote), then standard", () => {
    const result = resolve({
      branch: "feature/x",
      facts: { remotes: ["upstream"], created: { "feature/x": "upstream/develop" }, ...FROM_NUN },
    });
    expect(picked(result)).toEqual({ track: "standard", source: "reflog", target: "develop" });
  });

  test("given plain git checkout -b from develop (HEAD reflog), then standard", () => {
    const result = resolve({
      branch: "feature/x",
      facts: { checkout: { "feature/x": "develop" }, ...FROM_NUN },
    });
    expect(picked(result)).toEqual({ track: "standard", source: "checkout", target: "develop" });
  });

  test("given no track branch can be compared, then the default with a warning", () => {
    const result = resolve({ branch: "feature/z" });
    expect(picked(result)).toMatchObject({ track: "nun", source: "default" });
    expect(result.status === "resolved" && result.warnings[0]).toContain(
      "fetch the track branches",
    );
  });

  test("given a detached HEAD, then the default with a warning", () => {
    const result = resolve({ branch: null });
    expect(picked(result)).toMatchObject({ track: "nun", source: "default" });
    expect(blocking(result)).not.toBeNull();
  });

  test("given a default target no track owns, then that line competes as an implicit track (resolving to no track)", () => {
    const result = resolve({
      branch: "feature/m",
      defaultBranch: "main",
      facts: {
        history: { M1: ["D0"], D2: ["D0"] },
        forks: {
          "feature/m|main": "M1",
          "feature/m|develop": "D0",
          "feature/m|nun-develop": "D0",
        },
      },
    });
    expect(picked(result)).toEqual({ track: null, source: "ancestry", target: null });
    expect(blocking(result)).toBeNull();
  });

  test("given one track that owns the workspace default, then it is used without reading history", () => {
    const facts = probe();
    const result = resolveReleaseTrack({
      tracks: TRACKS.filter((track) => track.name === "standard"),
      defaultBranch: "develop",
      branch: "feature/x",
      probe: facts,
    });
    expect(picked(result)).toMatchObject({ track: "standard", source: "only-track" });
    expect(facts.calls).toEqual([]);
  });

  test("given one track and a default line it does not own, then a branch of the default line gets no track", () => {
    const result = resolveReleaseTrack({
      tracks: TRACKS.filter((track) => track.name === "nun"),
      defaultBranch: "develop",
      branch: "feature/x",
      probe: probe(FROM_DEVELOP),
    });
    expect(picked(result)).toEqual({ track: null, source: "ancestry", target: null });
  });

  test("given no tracks, then status none (callers keep today's behavior)", () => {
    expect(
      resolveReleaseTrack({
        tracks: [],
        defaultBranch: "develop",
        branch: "feature/x",
        probe: probe(),
      }),
    ).toEqual({ status: "none", issues: [] });
  });
});

describe("readReleaseTracks (lenient, D17)", () => {
  test("defaults baseBranch and pullRequestTarget to the integration branch", () => {
    const read = readReleaseTracks({
      lean: { productionBranch: "main", integrationBranch: "next" },
    });
    expect(read).toEqual({
      tracks: [
        {
          name: "lean",
          productionBranch: "main",
          integrationBranch: "next",
          baseBranch: "next",
          pullRequestTarget: "next",
          mergeBackBranches: [],
          naming: {},
        },
      ],
      issues: [],
      error: null,
      protectedBranches: ["main", "next"],
    });
  });

  test("an unknown or malformed field is reported, and the rest of the track still works", () => {
    const read = readReleaseTracks({
      ...RAW,
      standard: { ...RAW.standard, futureKnob: 1, mergeBackBranches: "develop" },
    });
    expect(read.error).toBeNull();
    expect(read.tracks.map((track) => track.name)).toEqual(["nun", "standard"]);
    expect(read.tracks[1].mergeBackBranches).toEqual([]);
    expect(read.issues).toEqual([
      'release track "standard" futureKnob: unknown field, ignored',
      'release track "standard" mergeBackBranches: must be a list of branch names; ignored',
    ]);
  });

  test("a dropped track is reported, not fatal, and its branches stay protected", () => {
    const read = readReleaseTracks({ ...RAW, broken: { productionBranch: "hotline" }, odd: 3 });
    expect(read.error).toBeNull();
    expect(read.tracks.map((track) => track.name)).toEqual(["nun", "standard"]);
    expect(read.issues).toContain('release track "odd" is not an object; ignored');
    expect(read.issues).toContain(
      'release track "broken" was skipped: it needs a productionBranch and integrationBranch',
    );
    expect(read.protectedBranches).toContain("hotline");
  });

  test("a problem in a field the track marks critical fails closed", () => {
    const read = readReleaseTracks({
      ...RAW,
      standard: { ...RAW.standard, freezeWindow: "fri", critical: ["freezeWindow"] },
    });
    expect(read.error).toContain('release track "standard" freezeWindow');
    expect(read.error).toContain("upgrade Workit");
  });

  test("critical: [naming] covers naming.* problems; a non-list critical is reported", () => {
    const covered = readReleaseTracks({
      ...RAW,
      standard: { ...RAW.standard, naming: { feature: 7 }, critical: ["naming"] },
    });
    expect(covered.error).toContain("naming.feature");
    const odd = readReleaseTracks({ ...RAW, standard: { ...RAW.standard, critical: "naming" } });
    expect(odd.error).toBeNull();
    expect(odd.issues).toContain(
      'release track "standard" critical: must be a list of field names; ignored',
    );
  });

  test("a naming template that is only a placeholder is rejected, not a catch-all", () => {
    const read = readReleaseTracks({
      ...RAW,
      standard: { ...RAW.standard, naming: { feature: "{name}", hotfix: "*/{name}" } },
    });
    expect(read.tracks[1].naming).toEqual({});
    expect(read.issues).toContain(
      'release track "standard" naming.feature: needs literal text besides placeholders; ignored',
    );
  });
});

describe("track helpers", () => {
  test("the protected union covers every long-lived branch of every track", () => {
    expect(trackBranches(TRACKS).toSorted()).toEqual([
      "develop",
      "master",
      "nun-develop",
      "nun-master",
    ]);
  });

  test("naming templates give branch names and allowed globs", () => {
    const nun = TRACKS.find((track) => track.name === "nun") ?? null;
    expect(trackBranchName(nun, "feature", "login")).toBe("feature/nun-login");
    expect(trackBranchName(nun, "bugfix", "login")).toBeNull();
    expect(trackBranchName(null, "feature", "login")).toBeNull();
    expect(namingGlob("release/nun-{version}")).toBe("release/nun-*");
    // No placeholder: a prefix.
    expect(namingGlob("nun/feature")).toBe("nun/feature/*");
    expect(trackBranchName({ naming: { feature: "nun/feature" } }, "feature", "x")).toBe(
      "nun/feature/x",
    );
    // Repeated calls stay stable (no stateful global regex).
    expect(namingGlob("feature/{name}")).toBe("feature/*");
    expect(namingGlob("feature/{name}")).toBe("feature/*");
  });
});

describe("workspaces.json schema agrees with the lenient runtime", () => {
  test("a minimal track (production + integration) with critical and a future field validates", () => {
    const result = validateWorkspacesDocument(
      {
        workspaces: [
          {
            name: "w",
            glob: "/x/**",
            releaseTracks: {
              lean: {
                productionBranch: "main",
                integrationBranch: "next",
                futureKnob: true,
                critical: ["futureKnob"],
              },
            },
          },
        ],
      },
      "workspaces.json",
    );
    expect(result.status).toBe("valid");
  });

  test("a track without an integration branch is still rejected at write time", () => {
    const result = validateWorkspacesDocument(
      {
        workspaces: [
          { name: "w", glob: "/x/**", releaseTracks: { bad: { productionBranch: "main" } } },
        ],
      },
      "workspaces.json",
    );
    expect(result.status).toBe("invalid");
  });
});
