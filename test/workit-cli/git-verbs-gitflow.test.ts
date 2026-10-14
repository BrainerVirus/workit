import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { shellBranchPolicyViolation } from "@/packages/workit-core/src/core/route-intent";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";

// git-flow awareness of `workit git branch` and `workit git push --release`
// per preset (gitflow configured or detected, github-flow, custom), against a
// real checkout whose origin is a local bare repository.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-gitflow-config-");
  configDir = configHome.configDir;
});
afterAll(() => configHome.restore());

const repos: RemoteRepo[] = [];
afterEach(() => {
  for (const name of ["workspaces.json", "config.json", "vcs.json"])
    rmSync(path.join(configDir, name), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

/** main plus a develop that is one commit ahead of it, both on origin. */
const flowRepo = (config: Record<string, unknown> | null): RemoteRepo => {
  if (config) writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config));
  const repo = makeRemoteRepo();
  repos.push(repo);
  repo.git("switch", "-q", "-c", "develop");
  repo.write("develop.txt", "develop\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore: develop");
  repo.git("push", "-q", "origin", "develop");
  repo.git("switch", "-q", "main");
  return repo;
};

const workspace = (repo: RemoteRepo, entry: Record<string, unknown>) =>
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "w", glob: `${repo.root.replaceAll("\\", "/")}/**`, ...entry }],
    }),
  );

const run = async (argv: string[], cwd: string) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "author-1" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

/** Branch, report the base, and return to main for the next case. */
const baseOf = async (repo: RemoteRepo, args: string[]) => {
  const result = await run(["git", "branch", ...args, "--json"], repo.cwd);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  repo.git("switch", "-q", "main");
  return result.json().data as { branch: string; base: string; notes: string[] };
};

const GITFLOW = { branchPolicy: { preset: "gitflow" } };

test("Given git-flow (configured), When a kind branches with no --base, Then feature, bugfix and release start from develop and hotfix from main", async () => {
  const repo = flowRepo(GITFLOW);
  const develop = repo.git("rev-parse", "develop");
  const mainSha = repo.git("rev-parse", "main");
  for (const [kind, base] of [
    ["feature", "develop"],
    ["bugfix", "develop"],
    ["release", "develop"],
    ["hotfix", "main"],
  ]) {
    const data = await baseOf(repo, ["--kind", kind, "--slug", `s-${kind}`]);
    expect(data, kind).toMatchObject({ branch: `${kind}/s-${kind}`, base });
    expect(repo.git("rev-parse", `${kind}/s-${kind}`)).toBe(base === "develop" ? develop : mainSha);
  }
  // A positional name routes by its prefix, and release/hotfix say where they land.
  const release = await baseOf(repo, ["release/4.1.0"]);
  expect(release.base).toBe("develop");
  expect(release.notes.join("\n")).toContain(
    "release/* lands on main (workit pr create targets it), then main merges back into develop",
  );
});

test("Given git-flow detected from develop + main (no policy configured), When feature branches with no --base, Then the base is develop, never main", async () => {
  const repo = flowRepo({});
  expect((await baseOf(repo, ["--kind", "feature", "--slug", "x"])).base).toBe("develop");
  // A global vcs.json default of main does not make main the integration branch.
  writeFileSync(path.join(configDir, "vcs.json"), JSON.stringify({ defaultTargetBranch: "main" }));
  writeFileSync(path.join(configDir, "config.json"), JSON.stringify(GITFLOW));
  expect((await baseOf(repo, ["--kind", "bugfix", "--slug", "y"])).base).toBe("develop");
  expect((await baseOf(repo, ["--kind", "hotfix", "--slug", "z"])).base).toBe("main");
});

test("Given git-flow, When --base names the other long-lived branch, Then it is refused with the route (a feature from main, a hotfix from develop)", async () => {
  const repo = flowRepo(GITFLOW);
  const feature = await run(
    ["git", "branch", "--kind", "feature", "--slug", "x", "--base", "main", "--json"],
    repo.cwd,
  );
  expect(feature.code).toBe(3);
  expect(feature.json().error).toBe(
    "gitflow_base: git-flow starts feature/* from develop, not main",
  );
  expect(feature.json().unblock).toContain("without --base it starts from develop");
  const hotfix = await run(["git", "branch", "hotfix/y", "--base", "origin/develop"], repo.cwd);
  expect(hotfix.code).toBe(3);
  expect(hotfix.stderr).toContain("git-flow starts hotfix/* from main, not develop");
  expect(repo.git("branch", "--list", "feature/*", "hotfix/*")).toBe("");
  // A stack parent (an unprotected local branch) stays a valid base.
  await baseOf(repo, ["feature/parent"]);
  expect((await baseOf(repo, ["feature/child", "--base", "feature/parent"])).base).toBe(
    "feature/parent",
  );
  // The workspace may name its integration branch.
  repo.git("push", "-q", "origin", "develop:refs/heads/dev");
  workspace(repo, { branchPolicy: { preset: "gitflow", developBranch: "dev" } });
  expect((await baseOf(repo, ["--kind", "release", "--slug", "5.0.0"])).base).toBe("dev");
});

test("Given github-flow, When any kind branches with no --base, Then it starts from main", async () => {
  const repo = flowRepo({ branchPolicy: { preset: "github-flow" } });
  for (const kind of ["feature", "bugfix", "release", "hotfix"])
    expect((await baseOf(repo, ["--kind", kind, "--slug", kind])).base, kind).toBe("main");
  // No git-flow route, so --base main is fine for a feature.
  expect((await baseOf(repo, ["feature/m", "--base", "main"])).base).toBe("main");
});

test("Given a custom preset, When kinds branch, Then the default target is the base and an off-policy kind names the allowed ones", async () => {
  const repo = flowRepo({
    branchPolicy: { preset: "custom", allowed: ["feature/*", "release/*"], protected: ["main"] },
  });
  expect((await baseOf(repo, ["--kind", "release", "--slug", "1.0.0"])).base).toBe("develop");
  const hotfix = await run(["git", "branch", "--kind", "hotfix", "--slug", "x"], repo.cwd);
  expect(hotfix.code).toBe(3);
  expect(hotfix.stderr).toContain("the allowed kinds are feature/, release/");
  const chore = await run(["git", "branch", "chore/deps"], repo.cwd);
  expect(chore.stderr).toContain('use "feature/deps"');
});

// ---------------------------------------------------------------------------
// push --release

/** Finish a release locally: merge it into main and tag main. */
const finishRelease = (repo: RemoteRepo, tag = "v1.0.0") => {
  repo.git("switch", "-q", "-c", "release/1.0.0", "develop");
  repo.git("switch", "-q", "main");
  repo.git("merge", "-q", "--no-ff", "-m", "chore: release 1.0.0", "release/1.0.0");
  repo.git("tag", "-a", tag, "-m", tag);
  return repo.git("rev-parse", "HEAD");
};

const rows = (cwd: string, type: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === type);
};

test("Given a finished git-flow release and no release grant, When pushed, Then plain push names --release and --release is refused naming the grant", async () => {
  const repo = flowRepo(GITFLOW);
  finishRelease(repo);
  const before = repo.remoteTip("main");
  const plain = await run(["git", "push", "--json"], repo.cwd);
  expect(plain.code).toBe(3);
  expect(plain.json().unblock).toContain("workit git push --release main");
  const refused = await run(
    ["git", "push", "--release", "main", "--release", "v1.0.0", "--json"],
    repo.cwd,
  );
  expect(refused.code).toBe(3);
  expect(refused.json()).toMatchObject({ code: "blocked", data: { reason: "grant_required" } });
  expect(refused.json().error).toContain("release is not granted");
  expect(refused.json().unblock).toContain("release=true");
  expect(repo.remoteTip("main")).toBe(before);
});

test("Given the release grant, When main, develop and the v tag are pushed with --release, Then they land fast-forward, are verified and recorded", async () => {
  const repo = flowRepo(GITFLOW);
  workspace(repo, { autonomy: { release: true } });
  const head = finishRelease(repo);
  repo.git("switch", "-q", "develop");
  repo.git("merge", "-q", "--no-ff", "-m", "chore: back-merge 1.0.0", "main");
  const developHead = repo.git("rev-parse", "HEAD");
  repo.git("switch", "-q", "main");
  const pushed = await run(
    ["git", "push", "--release", "main", "--release", "develop", "--release", "v1.0.0", "--json"],
    repo.cwd,
  );
  expect(pushed.code, pushed.stdout + pushed.stderr).toBe(0);
  expect(pushed.json().data.refs).toMatchObject([
    { kind: "branch", name: "main", sha: head, pushed: true },
    { kind: "branch", name: "develop", sha: developHead, pushed: true },
    { kind: "tag", name: "v1.0.0", ref: "refs/tags/v1.0.0", sha: head, pushed: true },
  ]);
  expect(repo.remoteTip("main")).toBe(head);
  expect(repo.remoteTip("develop")).toBe(developHead);
  const row = rows(repo.cwd, "release.pushed").at(-1);
  expect(row).toMatchObject({ observer: "workit_cli", grant: "autonomy", remote: "origin" });
  expect(row?.refs).toHaveLength(3);
  // Again: nothing moves, still verified.
  const again = await run(["git", "push", "--release", "main", "--release", "v1.0.0"], repo.cwd);
  expect(again.code).toBe(0);
  expect(again.stdout).toContain("is already at");
});

test("Given the release grant, When --release names a feature branch, a non-v tag, a moved tag or a rewritten main, Then each is refused and nothing moves", async () => {
  const repo = flowRepo(GITFLOW);
  workspace(repo, { autonomy: { release: true } });
  finishRelease(repo);
  repo.git("branch", "feature/a");
  const feature = await run(["git", "push", "--release", "feature/a", "--json"], repo.cwd);
  expect(feature.code).toBe(3);
  expect(feature.json().error).toContain(
    "release_push_refused: feature/a is not a git-flow release branch (main, develop)",
  );
  repo.git("tag", "build-7");
  const tag = await run(["git", "push", "--release", "build-7", "--json"], repo.cwd);
  expect(tag.json().error).toContain("is not a release tag");
  // Someone else moved origin/main: a release push never rewrites it.
  repo.pushFromElsewhere("main");
  const behind = await run(["git", "push", "--release", "main", "--json"], repo.cwd);
  expect(behind.code).toBe(1);
  expect(behind.json().error).toContain("non_fast_forward");
  // A tag that exists remotely at another commit never moves.
  repo.git("push", "-q", "origin", "develop:refs/tags/v2.0.0");
  repo.git("tag", "v2.0.0", "main");
  const moved = await run(["git", "push", "--release", "v2.0.0", "--json"], repo.cwd);
  expect(moved.code).toBe(3);
  expect(moved.json().error).toContain("tag_exists");
  expect(rows(repo.cwd, "release.pushed")).toEqual([]);
});

test("Given git-flow configured with no tag prefix (gitflow.prefix.versiontag empty), When --release names the bare 4.2.0 tag, Then it lands; a non-version tag is still refused", async () => {
  const repo = flowRepo(GITFLOW);
  workspace(repo, { autonomy: { release: true } });
  repo.git("config", "gitflow.prefix.versiontag", "");
  const head = finishRelease(repo, "4.2.0");
  const pushed = await run(
    ["git", "push", "--release", "main", "--release", "4.2.0", "--json"],
    repo.cwd,
  );
  expect(pushed.code, pushed.stdout + pushed.stderr).toBe(0);
  expect(pushed.json().data.refs).toMatchObject([
    { kind: "branch", name: "main", sha: head, pushed: true },
    { kind: "tag", name: "4.2.0", ref: "refs/tags/4.2.0", sha: head, pushed: true },
  ]);
  repo.git("tag", "build-7");
  const other = await run(["git", "push", "--release", "build-7", "--json"], repo.cwd);
  expect(other.json().error).toContain("is not a release tag (<version>");
  // A v tag is not this repository's convention once the prefix is empty.
  repo.git("tag", "v4.2.1");
  const v = await run(["git", "push", "--release", "v4.2.1", "--json"], repo.cwd);
  expect(v.json().error).toContain("is not a release tag");
});

test("Given git-flow with a custom tag prefix (release-), When --release names release-1.0.0, Then it lands", async () => {
  const repo = flowRepo(GITFLOW);
  workspace(repo, { autonomy: { release: true } });
  repo.git("config", "gitflow.prefix.versiontag", "release-");
  finishRelease(repo, "release-1.0.0");
  const pushed = await run(
    ["git", "push", "--release", "main", "--release", "release-1.0.0", "--json"],
    repo.cwd,
  );
  expect(pushed.code, pushed.stdout + pushed.stderr).toBe(0);
});

// ---------------------------------------------------------------------------
// Every behaviour per preset: git-flow, github-flow and custom (task/* and
// release/* allowed, main and stable protected, develop the default target).

const PRESETS = {
  gitflow: GITFLOW,
  "github-flow": { branchPolicy: { preset: "github-flow" } },
  custom: {
    branchPolicy: {
      preset: "custom",
      allowed: ["task/*", "release/*"],
      protected: ["main", "stable"],
    },
  },
} as const;
type Preset = keyof typeof PRESETS;
const ALL: Preset[] = ["gitflow", "github-flow", "custom"];

/** One case per preset: the expected outcome, or null when the case does not apply. */
const each = async (
  cases: Record<Preset, unknown>,
  check: (repo: RemoteRepo, expected: unknown, preset: Preset) => Promise<void>,
) => {
  for (const preset of ALL) {
    const repo = flowRepo(PRESETS[preset]);
    await check(repo, cases[preset], preset);
    for (const done of repos.splice(0)) done.cleanup();
  }
};

test("per preset, When each kind branches with no --base, Then the base is the preset's (git-flow route, github-flow main, custom default target) or the kind is refused with the preset's own kinds", async () => {
  const table: Record<Preset, Record<string, string>> = {
    gitflow: { feature: "develop", bugfix: "develop", release: "develop", hotfix: "main" },
    "github-flow": { feature: "main", bugfix: "main", release: "main", hotfix: "main" },
    custom: {
      feature: 'use "task/x"',
      bugfix: 'use "task/x"',
      release: "develop",
      hotfix: 'use "task/x"',
    },
  };
  await each(table, async (repo, expected, preset) => {
    for (const [kind, outcome] of Object.entries(expected as Record<string, string>)) {
      const result = await run(
        ["git", "branch", "--kind", kind, "--slug", "x", "--json"],
        repo.cwd,
      );
      if (outcome.startsWith("use ")) {
        expect(result.code, `${preset} ${kind}`).toBe(3);
        expect(result.json().error, `${preset} ${kind}`).toContain(outcome);
        expect(result.json().error).toContain("the allowed kinds are task/, release/");
        // The correction names only the custom kinds.
        expect(result.json().unblock).not.toMatch(/feature|bugfix|hotfix/);
      } else {
        expect(result.code, `${preset} ${kind}: ${result.stdout}`).toBe(0);
        expect(result.json().data.base, `${preset} ${kind}`).toBe(outcome);
        repo.git("switch", "-q", "main");
      }
    }
  });
});

test("per preset, When --base main is explicit for a feature-like branch, Then only git-flow refuses it", async () => {
  await each(
    { gitflow: "gitflow_base", "github-flow": null, custom: null },
    async (repo, expected, preset) => {
      const name = preset === "custom" ? "task/m" : "feature/m";
      const result = await run(["git", "branch", name, "--base", "main", "--json"], repo.cwd);
      if (expected) {
        expect(result.code, preset).toBe(3);
        expect(result.json().error).toContain(String(expected));
      } else {
        expect(result.code, `${preset}: ${result.stdout}`).toBe(0);
        expect(result.json().data.base).toBe("main");
      }
    },
  );
});

test("Given custom with a configured default target, When a kind branches with no --base, Then it starts there", async () => {
  const repo = flowRepo(PRESETS.custom);
  repo.git("push", "-q", "origin", "main:refs/heads/integration");
  workspace(repo, { vcs: { provider: "github", defaultTargetBranch: "integration" } });
  expect((await baseOf(repo, ["--kind", "release", "--slug", "2.0.0"])).base).toBe("integration");
});

test("per preset, When --kind is not a kind, Then the hint uses the preset's own allowed kinds", async () => {
  await each(
    {
      gitflow: "did you mean --kind feature?",
      "github-flow": "this workspace allows any non-protected name",
      custom: "did you mean --kind release?",
    },
    async (repo, expected, preset) => {
      const result = await run(["git", "branch", "--kind", "chore", "--slug", "x"], repo.cwd);
      expect(result.code, preset).toBe(2);
      expect(result.stderr, preset).toContain(String(expected));
    },
  );
  // A custom policy whose kinds --kind cannot spell gets a name to pass.
  const repo = flowRepo({
    branchPolicy: { preset: "custom", allowed: ["task/*"], protected: ["main"] },
  });
  const result = await run(["git", "branch", "--kind", "chore", "--slug", "x"], repo.cwd);
  expect(result.stderr).toContain(
    "this workspace allows task/: pass a name, e.g. workit git branch task/<slug>",
  );
  expect(result.stderr).not.toContain("did you mean --kind");
});

test("per preset, When raw git creates chore/x, Then the deny suggests the preset's own closest name (github-flow allows it)", async () => {
  await each(
    { gitflow: 'use "feature/x"', "github-flow": null, custom: 'use "task/x"' },
    async (repo, expected, preset) => {
      const verdict = shellBranchPolicyViolation(
        repo.cwd,
        "git fetch -q && git switch -c chore/x origin/main",
      );
      if (expected === null) expect(verdict, preset).toEqual({ ok: true });
      else {
        expect(verdict?.ok, preset).toBe(false);
        if (verdict?.ok === false) {
          expect(verdict.correction, preset).toContain(String(expected));
          if (preset === "custom") expect(verdict.correction).not.toMatch(/feature|bugfix|hotfix/);
        }
      }
    },
  );
});

test("per preset, Given the release grant, When --release names a branch or a v tag, Then only git-flow pushes main and develop; every preset pushes a landed tag and refuses an unmerged one", async () => {
  const table: Record<Preset, Record<string, string | null>> = {
    gitflow: {
      main: null,
      develop: null,
      stable: "is not a git-flow release branch (main, develop)",
    },
    "github-flow": {
      main: "the github-flow policy lands main only through a reviewed PR",
      develop: "the github-flow policy lands develop only through a reviewed PR",
    },
    custom: {
      main: "the custom policy lands main only through a reviewed PR",
      stable: "the custom policy lands stable only through a reviewed PR",
    },
  };
  await each(table, async (repo, expected, preset) => {
    workspace(repo, { autonomy: { release: true } });
    repo.git("branch", "stable", "main");
    // custom's default target is develop: its tags must already be there.
    const landed = preset === "custom" ? "develop" : "main";
    repo.git("tag", "v0.1.0", landed);
    for (const [branch, refusal] of Object.entries(expected as Record<string, string | null>)) {
      const result = await run(["git", "push", "--release", branch, "--json"], repo.cwd);
      if (refusal === null) expect(result.code, `${preset} ${branch}: ${result.stdout}`).toBe(0);
      else {
        expect(result.code, `${preset} ${branch}`).toBe(3);
        expect(result.json().error, `${preset} ${branch}`).toContain(refusal);
        if (preset !== "gitflow")
          expect(result.json().unblock).toContain(`workit pr create --base ${branch}`);
      }
    }
    const tag = await run(["git", "push", "--release", "v0.1.0", "--json"], repo.cwd);
    expect(tag.code, `${preset} tag: ${tag.stdout}`).toBe(0);
    // A tag on an unmerged feature commit is never a release.
    repo.git("switch", "-q", "-c", "feature/unmerged");
    repo.write("unmerged.txt", "x\n");
    repo.git("add", "-A");
    repo.git("commit", "-qm", "feat: unmerged");
    repo.git("tag", "v9.0.0");
    const unmerged = await run(["git", "push", "--release", "v9.0.0", "--json"], repo.cwd);
    expect(unmerged.code, preset).toBe(3);
    expect(unmerged.json().error, preset).toContain("tag_unreleased: v9.0.0");
    expect(repo.git("ls-remote", "--tags", "origin", "v9.0.0")).toBe("");
    repo.git("switch", "-q", "main");
    // Plain workit git push on main names --release only in git-flow.
    const plain = await run(["git", "push", "--json"], repo.cwd);
    if (preset === "gitflow")
      expect(plain.json().unblock).toContain("workit git push --release main");
    else expect(plain.json().unblock, preset).not.toContain("--release");
  });
  const repo = flowRepo(PRESETS["github-flow"]);
  const usage = await run(["git", "push", "--release", "--set-upstream"], repo.cwd);
  expect(usage.code).toBe(2);
});

test("Given the release grant but push=false, When --release runs, Then the push grant refuses it and nothing moves", async () => {
  const repo = flowRepo(GITFLOW);
  workspace(repo, { autonomy: { release: true, push: false } });
  const head = finishRelease(repo);
  const refused = await run(["git", "push", "--release", "main", "--json"], repo.cwd);
  expect(refused.code).toBe(3);
  expect(refused.json()).toMatchObject({ data: { reason: "grant_required" } });
  expect(refused.json().error).toContain("push is not granted");
  expect(repo.remoteTip("main")).not.toBe(head);
});

test("Given a remote that rejects the tag, When main and the tag go in one --release push, Then it is atomic: main does not move either", async () => {
  const repo = flowRepo(GITFLOW);
  workspace(repo, { autonomy: { release: true } });
  const before = repo.remoteTip("main");
  finishRelease(repo);
  // A per-ref update hook: refuses tags, accepts branches.
  const hook = path.join(repo.bare, "hooks", "update");
  writeFileSync(hook, '#!/bin/sh\ncase "$1" in refs/tags/*) exit 1 ;; esac\nexit 0\n', {
    mode: 0o755,
  });
  const pushed = await run(
    ["git", "push", "--release", "main", "--release", "v1.0.0", "--json"],
    repo.cwd,
  );
  expect(pushed.code).not.toBe(0);
  expect(repo.remoteTip("main")).toBe(before);
});
