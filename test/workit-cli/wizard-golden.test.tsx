import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { Wizard } from "../../packages/workit-cli/src/steps";
import type { SetupValues } from "../../packages/workit-cli/src/wizard-state";
import { emptyDetection } from "../../packages/workit-cli/src/admin/detect-hosts";
import { renderInk, type InkTty } from "../shared/helpers/ink-tty";

// React reports a render-loop or act() problem through console.error only; a
// wizard that logs one is broken even when every frame still looks right.
let consoleError: ReturnType<typeof spyOn<Console, "error">>;
beforeEach(() => {
  consoleError = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  const calls = consoleError.mock.calls.map((call) => String(call[0]));
  consoleError.mockRestore();
  expect(calls).toEqual([]);
});

// Golden transcripts of the setup wizard: every screen and every mode of the
// advanced workspace editor, frame by frame. They pin what a user sees and what
// onExit receives, so a refactor of the screen components cannot change either.

const ENTER = "\r";
const ESC = "\x1b\x1b\x1b";
const UP = "\u001b[A";
const DOWN = "\u001b[B";
const SPACE = " ";
const BACKSPACE = "\x7f";

const detection = {
  ...emptyDetection(),
  opencode: { detected: true, configured: false },
  cursor: { detected: true, configured: false },
};

type Sandbox = { root: string; project: string; config: string; home: string };

const ENV_KEYS = ["HOME", "WORKFLOW_TOOLKIT_CONFIG", "WORKFLOW_WORKSPACE_ROOT"] as const;

async function inSandbox(run: (box: Sandbox) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-golden-")));
  const box: Sandbox = {
    root,
    project: path.join(root, "project"),
    config: path.join(root, "config"),
    home: path.join(root, "home"),
  };
  for (const dir of [box.project, box.config, box.home]) mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(box.config, "config.json"),
    JSON.stringify({
      locale: "en",
      localeOptions: ["en", "es-CL"],
      branchPolicy: {
        preset: "gitflow",
        allowed: ["feature/*", "bugfix/*", "hotfix/*", "release/*"],
        protected: ["main", "develop"],
      },
      commitPolicy: { preset: "conventional" },
    }),
  );
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const cwd = process.cwd();
  process.env.HOME = box.home;
  process.env.WORKFLOW_TOOLKIT_CONFIG = box.config;
  delete process.env.WORKFLOW_WORKSPACE_ROOT;
  process.chdir(box.project);
  try {
    await run(box);
  } finally {
    process.chdir(cwd);
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function recorder(box: Sandbox, tty: InkTty) {
  const frames: string[] = [];
  const normalize = (text: string) => text.replaceAll(box.root, "<tmp>").replace(/[ \t]+$/gm, "");
  return {
    frames,
    normalize,
    async step(label: string, ...keys: string[]) {
      await tty.keys(...keys);
      frames.push(`### ${label}\n${normalize(tty.lastFrame())}`);
    },
  };
}

const up = (n: number) => Array.from({ length: n }, () => UP);
const down = (n: number) => Array.from({ length: n }, () => DOWN);

test("golden: a full walk through every wizard screen and editor mode renders the same frames and exit values", async () => {
  await inSandbox(async (box) => {
    const exits: Array<{ complete: boolean; values?: SetupValues }> = [];
    const tty = await renderInk(
      <Wizard
        onExit={(complete, values) => exits.push({ complete, values })}
        detection={detection}
      />,
    );
    const rec = recorder(box, tty);
    await rec.step("platforms");
    await rec.step("platforms: toggle OpenCode off", DOWN, DOWN, SPACE);
    await rec.step("platforms: clear all", UP, SPACE);
    await rec.step("platforms: select all available", UP, SPACE);
    await rec.step("locale", ENTER);
    await rec.step("locale: search", "esp");
    await rec.step("locale: search other", ...Array.from({ length: 3 }, () => BACKSPACE), "Oth");
    await rec.step("localeOther", ENTER);
    await rec.step("localeOther: typed", "es-CL");
    await rec.step("branchPreset", ENTER);
    await rec.step("branchPreset: github-flow", DOWN);
    await rec.step("branchPreset: custom", DOWN, DOWN);
    await rec.step("branchAllowed", ENTER);
    await rec.step("branchProtected", ENTER);
    await rec.step("issueTracker", ENTER);
    await rec.step("youtrack", ENTER);
    await rec.step("youtrack: invalid", "http://x", ENTER);
    await rec.step("youtrack: fixed", ...Array.from({ length: 8 }, () => BACKSPACE));
    await rec.step("vcs", "https://example.youtrack.cloud", ENTER);
    await rec.step("basePath", UP, ENTER);
    await rec.step("workspaces: empty", box.project, ENTER);
    await rec.step("workspaceName", UP, UP, ENTER);
    await rec.step("workspaceGlob", "work", ENTER);
    await rec.step("workspaceGlob: preview", `${box.project}/**`);
    await rec.step("workspaceProvider", ENTER);
    await rec.step("workspaces: one entry", DOWN, ENTER);
    await rec.step("workspaces: add current", UP, ENTER);
    await rec.step("workspaces: edit first", ...up(10), ENTER);
    await rec.step("workspaces: edit glob", ENTER);
    await rec.step("workspaces: edit provider", ENTER);
    await rec.step("workspaces: edited", ENTER);
    await rec.step("workspaces: remove second", ...up(3), ENTER);
    await rec.step("advanced: main", ...down(2), ENTER);
    await rec.step("advanced value: text", ...up(21), ENTER);
    await rec.step("advanced: after text", "octo", ENTER);
    await rec.step("advanced value: enum", ...up(18), ENTER);
    await rec.step("advanced: after enum", DOWN, ENTER);
    await rec.step("profiles: empty", UP, UP, ENTER);
    await rec.step("profileName", UP, ENTER);
    await rec.step("profileName: empty error", ENTER);
    await rec.step("profileEdit: created", "release", ENTER);
    await rec.step("profileValue: enum", ...up(11), ENTER);
    await rec.step("profileEdit: after enum", DOWN, ENTER);
    await rec.step("profileValue: text", ...up(10), ENTER);
    await rec.step("profileEdit: after text", "release/*", ENTER);
    await rec.step("profiles: one", ENTER);
    await rec.step("profiles: highlight back", DOWN);
    await rec.step("profiles: set default", ...up(3), ENTER);
    await rec.step("profileName: again", DOWN, DOWN, ENTER);
    await rec.step("profileName: duplicate error", "release", ENTER);
    await rec.step("profileEdit: second", "2", ENTER);
    await rec.step("profiles: two", ENTER);
    await rec.step("profiles: two, highlight back", DOWN);
    await rec.step("profiles: delete second", UP, UP, ENTER);
    await rec.step("profiles: after delete, highlight back", DOWN);
    await rec.step("profileEdit: via edit", ...up(4), ENTER);
    await rec.step("profileEdit: highlight done", ...down(11));
    await rec.step("profiles: back from edit", ENTER);
    await rec.step("profiles: back from edit, highlight back", DOWN);
    await rec.step("advanced: back from profiles", ENTER);
    await rec.step("tracks: empty", UP, ENTER);
    await rec.step("trackName", UP, ENTER);
    await rec.step("trackName: empty error", ENTER);
    await rec.step("trackEdit: created", "stable", ENTER);
    await rec.step("trackValue: enum", ...up(14), ENTER);
    await rec.step("trackEdit: after enum", DOWN, ENTER);
    await rec.step("trackValue: text", ...up(13), ENTER);
    await rec.step("trackEdit: after text", "trunk", ENTER);
    await rec.step("tracks: one", ENTER);
    await rec.step("tracks: one, highlight back", DOWN);
    await rec.step("trackName: duplicate error", UP, ENTER, "stable", ENTER);
    await rec.step("trackEdit: second", "2", ENTER);
    await rec.step("tracks: two", ENTER);
    await rec.step("tracks: two, highlight back", DOWN);
    await rec.step("tracks: delete second", UP, UP, ENTER);
    await rec.step("trackEdit: via edit", ...up(3), ENTER);
    await rec.step("trackEdit: highlight done", ...down(14));
    await rec.step("tracks: back from edit", ENTER);
    await rec.step("tracks: back from edit, highlight back", DOWN);
    await rec.step("advanced: back from tracks", ENTER);
    await rec.step("advanced value: default profile", ...up(5), ENTER);
    await rec.step("advanced: after default profile", DOWN, ENTER);
    await rec.step("workspaces: saved", ENTER);
    await rec.step("globalCommitPolicy", DOWN, ENTER);
    await rec.step("globalCommitPolicy: gitmoji", DOWN, ENTER);
    await rec.step("globalCommitPattern", ...down(5), ENTER);
    await rec.step("globalCommitPolicy: after pattern", "^feat", ENTER);
    await rec.step("workspaces: back from commit policy", ...down(10), ENTER);
    await rec.step("project: refused", ENTER);
    await rec.step("summary", "y");
    await rec.step("summary: apply", "y");
    tty.unmount();
    rec.frames.push(`### onExit\n${rec.normalize(JSON.stringify(exits, null, 2))}`);
    expect(rec.frames.join("\n\n")).toMatchInlineSnapshot(`
      "### platforms
      workit — workflow rails for agentic codingStep 1 — PlatformsChoose the detected tools where Workit should be configured.Use Space to toggle, or choose Select all available / Clear all.❯ Select all available  Clear all  [✓] OpenCode · detected  [✓] Cursor · detected  [ ] Codex · unavailable  [ ] Pi · unavailable  [ ] Claude Code · unavailableEnter to continue · Esc Cancel

      ### platforms: toggle OpenCode off
      workit — workflow rails for agentic codingStep 1 — PlatformsChoose the detected tools where Workit should be configured.Use Space to toggle, or choose Select all available / Clear all.  Select all available  Clear all❯ [ ] OpenCode · detected  [✓] Cursor · detected  [ ] Codex · unavailable  [ ] Pi · unavailable  [ ] Claude Code · unavailableEnter to continue · Esc Cancel

      ### platforms: clear all
      workit — workflow rails for agentic codingStep 1 — PlatformsChoose the detected tools where Workit should be configured.Use Space to toggle, or choose Select all available / Clear all.  Select all available❯ Clear all  [ ] OpenCode · detected  [ ] Cursor · detected  [ ] Codex · unavailable  [ ] Pi · unavailable  [ ] Claude Code · unavailableEnter to continue · Esc Cancel

      ### platforms: select all available
      workit — workflow rails for agentic codingStep 1 — PlatformsChoose the detected tools where Workit should be configured.Use Space to toggle, or choose Select all available / Clear all.❯ Select all available  Clear all  [✓] OpenCode · detected  [✓] Cursor · detected  [ ] Codex · unavailable  [ ] Pi · unavailable  [ ] Claude Code · unavailableEnter to continue · Esc Cancel

      ### locale
      workit — workflow rails for agentic codingStep 2 — Global config · LocaleLocale (BCP-47):Current: enType to search languages…  Español (Latinoamérica)  Español (Chile)  Español (México)  Español (Argentina)❯ EnglishType to filter · Enter to continue · b Back · Esc Cancel

      ### locale: search
      workit — workflow rails for agentic codingStep 2 — Global config · LocaleLocale (BCP-47):Current: enesp❯ Español (España)  Español (Latinoamérica)  Español (Chile)  Español (México)  Español (Argentina)Type to filter · Enter to continue · b Back · Esc Cancel

      ### locale: search other
      workit — workflow rails for agentic codingStep 2 — Global config · LocaleLocale (BCP-47):Current: enOth❯ Other…Type to filter · Enter to continue · b Back · Esc Cancel

      ### localeOther
      workit — workflow rails for agentic codingStep 2 — Global config · Locale (custom)Type a BCP-47 locale (e.g. en or es-CL):e.g. en-US or es-CLEnter to continue · Esc Back

      ### localeOther: typed
      workit — workflow rails for agentic codingStep 2 — Global config · Locale (custom)Type a BCP-47 locale (e.g. en or es-CL):es-CLEnter to continue · Esc Back

      ### branchPreset
      workit — workflow rails for agentic codingStep 2 — Global config · Branch policyBranch policy preset:❯ GitFlow  GitHub Flow  Trunk-based  Customfeature/*, bugfix/*, hotfix/*, release/* allowed · main, develop, master, prod, production protected · work merges intodevelop via PRs or merge commitsAllowed: feature/*, bugfix/*, hotfix/*, release/*Protected: main, develop, master, prod, productionEnter to continue · b Back · Esc Cancel

      ### branchPreset: github-flow
      workit — workflow rails for agentic codingStep 2 — Global config · Branch policyBranch policy preset:  GitFlow❯ GitHub Flow  Trunk-based  CustomAnything goes (*) · only main is protected · branches off main, back to mainAllowed: *Protected: mainEnter to continue · b Back · Esc Cancel

      ### branchPreset: custom
      workit — workflow rails for agentic codingStep 2 — Global config · Branch policyBranch policy preset:  GitFlow  GitHub Flow  Trunk-based❯ CustomDefine your own allowed and protected patterns in the next promptsAllowed: feature/*, bugfix/*, hotfix/*, release/*Protected: main, develop, master, prod, productionEnter to continue — define the patterns next · b Back · Esc Cancel

      ### branchAllowed
      workit — workflow rails for agentic codingStep 2 — Global config · Allowed branch patternsAllowed branch patterns (comma-separated):feature/*, bugfix/*, hotfix/*, release/*Enter to continue · Esc Back

      ### branchProtected
      workit — workflow rails for agentic codingStep 2 — Global config · Protected branch namesProtected branch names (comma-separated):main, develop, master, prod, productionEnter to continue · Esc Back

      ### issueTracker
      workit — workflow rails for agentic codingStep 3 — Issue trackerWhere do issues live?❯ YouTrack  GitHub Issues  GitLab Issues  NoneEnter to continue · b Back · Esc Cancel

      ### youtrack
      workit — workflow rails for agentic codingStep 3 — YouTrackBase URL (https):e.g. https://example.youtrack.cloudEnter to continue · Esc Back

      ### youtrack: invalid
      workit — workflow rails for agentic codingStep 3 — YouTrackBase URL (https):http://xbase URL must use httpsEnter to continue · Esc Back

      ### youtrack: fixed
      workit — workflow rails for agentic codingStep 3 — YouTrackBase URL (https):e.g. https://example.youtrack.cloudEnter to continue · Esc Back

      ### vcs
      workit — workflow rails for agentic codingStep 4 — Version controlProvider:  GitLab  GitHub❯ Skip — configure laterEnter to continue · b Back · Esc Cancel

      ### basePath
      workit — workflow rails for agentic codingStep 5 — Workspace rootAbsolute path where your projects live (e.g. /work):Enter to continue · Esc Back

      ### workspaces: empty
      workit — workflow rails for agentic codingStep 5 — WorkspacesNo workspaces configured yet.  Add workspace  Use current project (<tmp>/project)❯ Done  Advanced global commit policyEnter to continue · b Back · Esc Cancel

      ### workspaceName
      workit — workflow rails for agentic codingStep 5 — Workspaces · NameNew workspace name:e.g. workEnter to continue · Esc Back

      ### workspaceGlob
      workit — workflow rails for agentic codingStep 5 — Workspaces · PatternWorkspace pattern (glob, e.g. /work/**):e.g. /work/**Enter to continue · Esc Back

      ### workspaceGlob: preview
      workit — workflow rails for agentic codingStep 5 — Workspaces · PatternWorkspace pattern (glob, e.g. /work/**):<tmp>/project/**Match preview (shared matcher):✓ matches <tmp>/project✗ no match <tmp>✓ matches <tmp>/project/child-repoEnter to continue · Esc Back

      ### workspaceProvider
      workit — workflow rails for agentic codingStep 5 — Workspaces · ProviderVersion control provider for this workspace:  GitLab❯ GitHub  Skip — configure laterEnter to save · b Back · Esc Cancel

      ### workspaces: one entry
      workit — workflow rails for agentic codingStep 5 — Workspaces✓ matches work — ? — <tmp>/project/**  Edit work (<tmp>/project/**)  Remove work  Add workspace  Use current project (<tmp>/project)❯ Done  Advanced global commit policy  Advanced settings for workEnter to continue · b Back · Esc Cancel

      ### workspaces: add current
      workit — workflow rails for agentic codingStep 5 — Workspaces✓ matches work — ? — <tmp>/project/**✓ matches project — github — <tmp>/project/**  Edit work (<tmp>/project/**)  Edit project (<tmp>/project/**)  Remove work  Remove project  Add workspace  Use current project (<tmp>/project)❯ Done  Advanced global commit policy  Advanced settings for work  Advanced settings for projectEnter to continue · b Back · Esc Cancel

      ### workspaces: edit first
      workit — workflow rails for agentic codingStep 5 — Workspaces · NameEdit workspace name (work):workEnter to continue · Esc Back

      ### workspaces: edit glob
      workit — workflow rails for agentic codingStep 5 — Workspaces · PatternWorkspace pattern (glob, e.g. /work/**):<tmp>/project/**Match preview (shared matcher):✓ matches <tmp>/project✗ no match <tmp>✓ matches <tmp>/project/child-repoEnter to continue · Esc Back

      ### workspaces: edit provider
      workit — workflow rails for agentic codingStep 5 — Workspaces · ProviderVersion control provider for this workspace:  GitLab  GitHub❯ Skip — configure laterEnter to save · b Back · Esc Cancel

      ### workspaces: edited
      workit — workflow rails for agentic codingStep 5 — Workspaces✓ matches work — ? — <tmp>/project/**✓ matches project — github — <tmp>/project/**  Edit work (<tmp>/project/**)  Edit project (<tmp>/project/**)  Remove work  Remove project  Add workspace  Use current project (<tmp>/project)❯ Done  Advanced global commit policy  Advanced settings for work  Advanced settings for projectEnter to continue · b Back · Esc Cancel

      ### workspaces: remove second
      workit — workflow rails for agentic codingStep 5 — Workspaces✓ matches work — ? — <tmp>/project/**  Edit work (<tmp>/project/**)  Remove work  Add workspace  Use current project (<tmp>/project)❯ Done  Advanced global commit policy  Advanced settings for workEnter to continue · b Back · Esc Cancel

      ### advanced: main
      workit — workflow rails for agentic codingAdvanced workspace settings · workChoose a setting to edit. Lists use comma-separated values; blank clears an override.Hosting provider account: inherited / unsetDefault target branch: inherited / unsetWorkspace YouTrack URL: inherited / unsetLink issues in YouTrack: inheritLink GitHub issues on pull requests: inheritBranch preset: inheritAllowed branch patterns: inherited / unsetProtected branches: inherited / unsetDevelop branch: inherited / unsetIntegration method (pr or merge): mergeFeature prefix: inherited / unsetBugfix prefix: inherited / unsetRelease prefix: inherited / unsetHotfix prefix: inherited / unsetCommit policy preset: inheritCustom commit pattern: inherited / unsetDefault profile name: inherited / unsetChangelog step before a PR: offDocs refresh before a PR: off  Hosting provider account  Default target branch  Workspace YouTrack URL  Link issues in YouTrack  Link GitHub issues on pull requests  Branch preset  Allowed branch patterns  Protected branches  Develop branch  Integration method (pr or merge)  Feature prefix  Bugfix prefix  Release prefix  Hotfix prefix  Commit policy preset  Custom commit pattern  Default profile name  Changelog step before a PR  Docs refresh before a PR  Manage profiles  Manage release tracks❯ Save workspace settings

      ### advanced value: text
      workit — workflow rails for agentic codingAdvanced workspace settings · Hosting provider accountLeave empty to clear this override. Use comma-separated values for lists.Enter to save · Esc Back

      ### advanced: after text
      workit — workflow rails for agentic codingAdvanced workspace settings · workChoose a setting to edit. Lists use comma-separated values; blank clears an override.Hosting provider account: inherited / unsetDefault target branch: inherited / unsetWorkspace YouTrack URL: inherited / unsetLink issues in YouTrack: inheritLink GitHub issues on pull requests: inheritBranch preset: inheritAllowed branch patterns: inherited / unsetProtected branches: inherited / unsetDevelop branch: inherited / unsetIntegration method (pr or merge): mergeFeature prefix: inherited / unsetBugfix prefix: inherited / unsetRelease prefix: inherited / unsetHotfix prefix: inherited / unsetCommit policy preset: inheritCustom commit pattern: inherited / unsetDefault profile name: inherited / unsetChangelog step before a PR: offDocs refresh before a PR: off  Hosting provider account  Default target branch  Workspace YouTrack URL  Link issues in YouTrack  Link GitHub issues on pull requests  Branch preset  Allowed branch patterns  Protected branches  Develop branch  Integration method (pr or merge)  Feature prefix  Bugfix prefix  Release prefix  Hotfix prefix  Commit policy preset  Custom commit pattern  Default profile name  Changelog step before a PR  Docs refresh before a PR  Manage profiles  Manage release tracks❯ Save workspace settings

      ### advanced value: enum
      workit — workflow rails for agentic codingAdvanced workspace settings · Link issues in YouTrackLeave empty to clear this override. Use comma-separated values for lists.❯ Inherit global behavior  Enabled  DisabledEnter to save · Esc Back

      ### advanced: after enum
      workit — workflow rails for agentic codingAdvanced workspace settings · workChoose a setting to edit. Lists use comma-separated values; blank clears an override.Hosting provider account: inherited / unsetDefault target branch: inherited / unsetWorkspace YouTrack URL: inherited / unsetLink issues in YouTrack: trueLink GitHub issues on pull requests: inheritBranch preset: inheritAllowed branch patterns: inherited / unsetProtected branches: inherited / unsetDevelop branch: inherited / unsetIntegration method (pr or merge): mergeFeature prefix: inherited / unsetBugfix prefix: inherited / unsetRelease prefix: inherited / unsetHotfix prefix: inherited / unsetCommit policy preset: inheritCustom commit pattern: inherited / unsetDefault profile name: inherited / unsetChangelog step before a PR: offDocs refresh before a PR: off  Hosting provider account  Default target branch  Workspace YouTrack URL  Link issues in YouTrack  Link GitHub issues on pull requests  Branch preset  Allowed branch patterns  Protected branches  Develop branch  Integration method (pr or merge)  Feature prefix  Bugfix prefix  Release prefix  Hotfix prefix  Commit policy preset  Custom commit pattern  Default profile name  Changelog step before a PR  Docs refresh before a PR  Manage profiles  Manage release tracks❯ Save workspace settings

      ### profiles: empty
      workit — workflow rails for agentic codingProfiles · default: noneProfiles can override branch rules and commit conventions.  Create profile❯ Back to advanced settings

      ### profileName
      workit — workflow rails for agentic codingCreate profileProfile name:Enter to create · Esc Back

      ### profileName: empty error
      workit — workflow rails for agentic codingCreate profileProfile name:Enter a profile name.Enter to create · Esc Back

      ### profileEdit: created
      workit — workflow rails for agentic codingEdit profile · releaseBranch preset: unsetAllowed patterns: unsetProtected branches: unsetDevelop branch: unsetIntegration (pr or merge): unsetFeature prefix: unsetBugfix prefix: unsetRelease prefix: unsetHotfix prefix: unsetCommit preset: conventionalCommit pattern: unset  Branch preset  Allowed patterns  Protected branches  Develop branch  Integration (pr or merge)  Feature prefix  Bugfix prefix  Release prefix  Hotfix prefix  Commit preset  Commit pattern❯ Done editing

      ### profileValue: enum
      workit — workflow rails for agentic codingProfile release · Branch preset❯ Inherit global  GitFlow  GitHub Flow  Trunk-based  CustomEnter to save · Esc Back

      ### profileEdit: after enum
      workit — workflow rails for agentic codingEdit profile · releaseBranch preset: gitflowAllowed patterns: unsetProtected branches: unsetDevelop branch: unsetIntegration (pr or merge): unsetFeature prefix: unsetBugfix prefix: unsetRelease prefix: unsetHotfix prefix: unsetCommit preset: conventionalCommit pattern: unset  Branch preset  Allowed patterns  Protected branches  Develop branch  Integration (pr or merge)  Feature prefix  Bugfix prefix  Release prefix  Hotfix prefix  Commit preset  Commit pattern❯ Done editing

      ### profileValue: text
      workit — workflow rails for agentic codingProfile release · Allowed patternsEnter to save · Esc Back

      ### profileEdit: after text
      workit — workflow rails for agentic codingEdit profile · releaseBranch preset: gitflowAllowed patterns: release/*Protected branches: unsetDevelop branch: unsetIntegration (pr or merge): unsetFeature prefix: unsetBugfix prefix: unsetRelease prefix: unsetHotfix prefix: unsetCommit preset: conventionalCommit pattern: unset  Branch preset  Allowed patterns  Protected branches  Develop branch  Integration (pr or merge)  Feature prefix  Bugfix prefix  Release prefix  Hotfix prefix  Commit preset  Commit pattern❯ Done editing

      ### profiles: one
      workit — workflow rails for agentic codingProfiles · default: noneProfiles can override branch rules and commit conventions.  Edit profile release  Set release as default  Delete profile release  Create profile❯ Back to advanced settings

      ### profiles: highlight back
      workit — workflow rails for agentic codingProfiles · default: noneProfiles can override branch rules and commit conventions.  Edit profile release  Set release as default  Delete profile release  Create profile❯ Back to advanced settings

      ### profiles: set default
      workit — workflow rails for agentic codingProfiles · default: releaseProfiles can override branch rules and commit conventions.  Edit profile release❯ Set release as default  Delete profile release  Create profile  Back to advanced settings

      ### profileName: again
      workit — workflow rails for agentic codingCreate profileProfile name:Enter to create · Esc Back

      ### profileName: duplicate error
      workit — workflow rails for agentic codingCreate profileProfile name:releaseProfile release already exists. Choose a different name or edit it from the list.Enter to create · Esc Back

      ### profileEdit: second
      workit — workflow rails for agentic codingEdit profile · release2Branch preset: unsetAllowed patterns: unsetProtected branches: unsetDevelop branch: unsetIntegration (pr or merge): unsetFeature prefix: unsetBugfix prefix: unsetRelease prefix: unsetHotfix prefix: unsetCommit preset: conventionalCommit pattern: unset  Branch preset  Allowed patterns  Protected branches  Develop branch  Integration (pr or merge)  Feature prefix  Bugfix prefix  Release prefix  Hotfix prefix  Commit preset  Commit pattern❯ Done editing

      ### profiles: two
      workit — workflow rails for agentic codingProfiles · default: releaseProfiles can override branch rules and commit conventions.  Edit profile release  Set release as default  Delete profile release  Edit profile release2  Set release2 as default  Delete profile release2  Create profile❯ Back to advanced settings

      ### profiles: two, highlight back
      workit — workflow rails for agentic codingProfiles · default: releaseProfiles can override branch rules and commit conventions.  Edit profile release  Set release as default  Delete profile release  Edit profile release2  Set release2 as default  Delete profile release2  Create profile❯ Back to advanced settings

      ### profiles: delete second
      workit — workflow rails for agentic codingProfiles · default: releaseProfiles can override branch rules and commit conventions.  Edit profile release  Set release as default  Delete profile release  Create profile  Back to advanced settings

      ### profiles: after delete, highlight back
      workit — workflow rails for agentic codingProfiles · default: releaseProfiles can override branch rules and commit conventions.  Edit profile release  Set release as default  Delete profile release  Create profile❯ Back to advanced settings

      ### profileEdit: via edit
      workit — workflow rails for agentic codingEdit profile · releaseBranch preset: gitflowAllowed patterns: release/*Protected branches: unsetDevelop branch: unsetIntegration (pr or merge): unsetFeature prefix: unsetBugfix prefix: unsetRelease prefix: unsetHotfix prefix: unsetCommit preset: conventionalCommit pattern: unset  Branch preset  Allowed patterns  Protected branches  Develop branch  Integration (pr or merge)  Feature prefix  Bugfix prefix  Release prefix  Hotfix prefix  Commit preset  Commit pattern❯ Done editing

      ### profileEdit: highlight done
      workit — workflow rails for agentic codingEdit profile · releaseBranch preset: gitflowAllowed patterns: release/*Protected branches: unsetDevelop branch: unsetIntegration (pr or merge): unsetFeature prefix: unsetBugfix prefix: unsetRelease prefix: unsetHotfix prefix: unsetCommit preset: conventionalCommit pattern: unset  Branch preset  Allowed patterns  Protected branches  Develop branch  Integration (pr or merge)  Feature prefix  Bugfix prefix  Release prefix  Hotfix prefix  Commit preset  Commit pattern❯ Done editing

      ### profiles: back from edit
      workit — workflow rails for agentic codingProfiles · default: releaseProfiles can override branch rules and commit conventions.  Edit profile release  Set release as default  Delete profile release  Create profile❯ Back to advanced settings

      ### profiles: back from edit, highlight back
      workit — workflow rails for agentic codingProfiles · default: releaseProfiles can override branch rules and commit conventions.  Edit profile release  Set release as default  Delete profile release  Create profile❯ Back to advanced settings

      ### advanced: back from profiles
      workit — workflow rails for agentic codingAdvanced workspace settings · workChoose a setting to edit. Lists use comma-separated values; blank clears an override.Hosting provider account: inherited / unsetDefault target branch: inherited / unsetWorkspace YouTrack URL: inherited / unsetLink issues in YouTrack: trueLink GitHub issues on pull requests: inheritBranch preset: inheritAllowed branch patterns: inherited / unsetProtected branches: inherited / unsetDevelop branch: inherited / unsetIntegration method (pr or merge): mergeFeature prefix: inherited / unsetBugfix prefix: inherited / unsetRelease prefix: inherited / unsetHotfix prefix: inherited / unsetCommit policy preset: inheritCustom commit pattern: inherited / unsetDefault profile name: releaseChangelog step before a PR: offDocs refresh before a PR: off  Hosting provider account  Default target branch  Workspace YouTrack URL  Link issues in YouTrack  Link GitHub issues on pull requests  Branch preset  Allowed branch patterns  Protected branches  Develop branch  Integration method (pr or merge)  Feature prefix  Bugfix prefix  Release prefix  Hotfix prefix  Commit policy preset  Custom commit pattern  Default profile name  Changelog step before a PR  Docs refresh before a PR  Manage profiles  Manage release tracks❯ Save workspace settings

      ### tracks: empty
      workit — workflow rails for agentic codingNamed release tracksEach track has its own branches, naming, version source, and checks.  Create release track❯ Back to advanced settings

      ### trackName
      workit — workflow rails for agentic codingCreate release trackTrack name:Enter to create · Esc Back

      ### trackName: empty error
      workit — workflow rails for agentic codingCreate release trackTrack name:Enter a release-track name.Enter to create · Esc Back

      ### trackEdit: created
      workit — workflow rails for agentic codingEdit release track · stableStrategy: gitflowProduction branch: mainIntegration branch: developFeature branch naming: feature/{name}Release branch naming: release/{version}Hotfix branch naming: hotfix/{name}Base branch: developMerge-back branches: developPull request target: developTag namespace: unsetVersion source (manual, git-tag, package-json): git-tagPackage.json path: unsetPackage version field: unsetRequired checks: unset  Strategy  Production branch  Integration branch  Feature branch naming  Release branch naming  Hotfix branch naming  Base branch  Merge-back branches  Pull request target  Tag namespace  Version source (manual, git-tag, package-json)  Package.json path  Package version field  Required checks❯ Done editing

      ### trackValue: enum
      workit — workflow rails for agentic codingRelease track stable · Strategy❯ GitFlow  GitHub Flow  Trunk-based  CustomLists use comma-separated values · Enter to save · Esc Back

      ### trackEdit: after enum
      workit — workflow rails for agentic codingEdit release track · stableStrategy: github-flowProduction branch: mainIntegration branch: developFeature branch naming: feature/{name}Release branch naming: release/{version}Hotfix branch naming: hotfix/{name}Base branch: developMerge-back branches: developPull request target: developTag namespace: unsetVersion source (manual, git-tag, package-json): git-tagPackage.json path: unsetPackage version field: unsetRequired checks: unset  Strategy  Production branch  Integration branch  Feature branch naming  Release branch naming  Hotfix branch naming  Base branch  Merge-back branches  Pull request target  Tag namespace  Version source (manual, git-tag, package-json)  Package.json path  Package version field  Required checks❯ Done editing

      ### trackValue: text
      workit — workflow rails for agentic codingRelease track stable · Production branchmainLists use comma-separated values · Enter to save · Esc Back

      ### trackEdit: after text
      workit — workflow rails for agentic codingEdit release track · stableStrategy: github-flowProduction branch: maintrunkIntegration branch: developFeature branch naming: feature/{name}Release branch naming: release/{version}Hotfix branch naming: hotfix/{name}Base branch: developMerge-back branches: developPull request target: developTag namespace: unsetVersion source (manual, git-tag, package-json): git-tagPackage.json path: unsetPackage version field: unsetRequired checks: unset  Strategy  Production branch  Integration branch  Feature branch naming  Release branch naming  Hotfix branch naming  Base branch  Merge-back branches  Pull request target  Tag namespace  Version source (manual, git-tag, package-json)  Package.json path  Package version field  Required checks❯ Done editing

      ### tracks: one
      workit — workflow rails for agentic codingNamed release tracksEach track has its own branches, naming, version source, and checks.  Edit release track stable  Delete release track stable  Create release track❯ Back to advanced settings

      ### tracks: one, highlight back
      workit — workflow rails for agentic codingNamed release tracksEach track has its own branches, naming, version source, and checks.  Edit release track stable  Delete release track stable  Create release track❯ Back to advanced settings

      ### trackName: duplicate error
      workit — workflow rails for agentic codingCreate release trackTrack name:stableRelease track stable already exists. Choose a different name or edit it from the list.Enter to create · Esc Back

      ### trackEdit: second
      workit — workflow rails for agentic codingEdit release track · stable2Strategy: gitflowProduction branch: mainIntegration branch: developFeature branch naming: feature/{name}Release branch naming: release/{version}Hotfix branch naming: hotfix/{name}Base branch: developMerge-back branches: developPull request target: developTag namespace: unsetVersion source (manual, git-tag, package-json): git-tagPackage.json path: unsetPackage version field: unsetRequired checks: unset  Strategy  Production branch  Integration branch  Feature branch naming  Release branch naming  Hotfix branch naming  Base branch  Merge-back branches  Pull request target  Tag namespace  Version source (manual, git-tag, package-json)  Package.json path  Package version field  Required checks❯ Done editing

      ### tracks: two
      workit — workflow rails for agentic codingNamed release tracksEach track has its own branches, naming, version source, and checks.  Edit release track stable  Delete release track stable  Edit release track stable2  Delete release track stable2  Create release track❯ Back to advanced settings

      ### tracks: two, highlight back
      workit — workflow rails for agentic codingNamed release tracksEach track has its own branches, naming, version source, and checks.  Edit release track stable  Delete release track stable  Edit release track stable2  Delete release track stable2  Create release track❯ Back to advanced settings

      ### tracks: delete second
      workit — workflow rails for agentic codingNamed release tracksEach track has its own branches, naming, version source, and checks.  Edit release track stable  Delete release track stable  Create release track❯ Back to advanced settings

      ### trackEdit: via edit
      workit — workflow rails for agentic codingEdit release track · stableStrategy: github-flowProduction branch: maintrunkIntegration branch: developFeature branch naming: feature/{name}Release branch naming: release/{version}Hotfix branch naming: hotfix/{name}Base branch: developMerge-back branches: developPull request target: developTag namespace: unsetVersion source (manual, git-tag, package-json): git-tagPackage.json path: unsetPackage version field: unsetRequired checks: unset  Strategy  Production branch  Integration branch  Feature branch naming  Release branch naming  Hotfix branch naming  Base branch  Merge-back branches  Pull request target  Tag namespace  Version source (manual, git-tag, package-json)  Package.json path  Package version field  Required checks❯ Done editing

      ### trackEdit: highlight done
      workit — workflow rails for agentic codingEdit release track · stableStrategy: github-flowProduction branch: maintrunkIntegration branch: developFeature branch naming: feature/{name}Release branch naming: release/{version}Hotfix branch naming: hotfix/{name}Base branch: developMerge-back branches: developPull request target: developTag namespace: unsetVersion source (manual, git-tag, package-json): git-tagPackage.json path: unsetPackage version field: unsetRequired checks: unset  Strategy  Production branch  Integration branch  Feature branch naming  Release branch naming  Hotfix branch naming  Base branch  Merge-back branches  Pull request target  Tag namespace  Version source (manual, git-tag, package-json)  Package.json path  Package version field  Required checks❯ Done editing

      ### tracks: back from edit
      workit — workflow rails for agentic codingNamed release tracksEach track has its own branches, naming, version source, and checks.  Edit release track stable  Delete release track stable  Create release track❯ Back to advanced settings

      ### tracks: back from edit, highlight back
      workit — workflow rails for agentic codingNamed release tracksEach track has its own branches, naming, version source, and checks.  Edit release track stable  Delete release track stable  Create release track❯ Back to advanced settings

      ### advanced: back from tracks
      workit — workflow rails for agentic codingAdvanced workspace settings · workChoose a setting to edit. Lists use comma-separated values; blank clears an override.Hosting provider account: inherited / unsetDefault target branch: inherited / unsetWorkspace YouTrack URL: inherited / unsetLink issues in YouTrack: trueLink GitHub issues on pull requests: inheritBranch preset: inheritAllowed branch patterns: inherited / unsetProtected branches: inherited / unsetDevelop branch: inherited / unsetIntegration method (pr or merge): mergeFeature prefix: inherited / unsetBugfix prefix: inherited / unsetRelease prefix: inherited / unsetHotfix prefix: inherited / unsetCommit policy preset: inheritCustom commit pattern: inherited / unsetDefault profile name: releaseChangelog step before a PR: offDocs refresh before a PR: off  Hosting provider account  Default target branch  Workspace YouTrack URL  Link issues in YouTrack  Link GitHub issues on pull requests  Branch preset  Allowed branch patterns  Protected branches  Develop branch  Integration method (pr or merge)  Feature prefix  Bugfix prefix  Release prefix  Hotfix prefix  Commit policy preset  Custom commit pattern  Default profile name  Changelog step before a PR  Docs refresh before a PR  Manage profiles  Manage release tracks❯ Save workspace settings

      ### advanced value: default profile
      workit — workflow rails for agentic codingAdvanced workspace settings · Default profile nameLeave empty to clear this override. Use comma-separated values for lists.  Inherit / no default profile❯ releaseEnter to save · Esc Back

      ### advanced: after default profile
      workit — workflow rails for agentic codingAdvanced workspace settings · workChoose a setting to edit. Lists use comma-separated values; blank clears an override.Hosting provider account: inherited / unsetDefault target branch: inherited / unsetWorkspace YouTrack URL: inherited / unsetLink issues in YouTrack: trueLink GitHub issues on pull requests: inheritBranch preset: inheritAllowed branch patterns: inherited / unsetProtected branches: inherited / unsetDevelop branch: inherited / unsetIntegration method (pr or merge): mergeFeature prefix: inherited / unsetBugfix prefix: inherited / unsetRelease prefix: inherited / unsetHotfix prefix: inherited / unsetCommit policy preset: inheritCustom commit pattern: inherited / unsetDefault profile name: releaseChangelog step before a PR: offDocs refresh before a PR: off  Hosting provider account  Default target branch  Workspace YouTrack URL  Link issues in YouTrack  Link GitHub issues on pull requests  Branch preset  Allowed branch patterns  Protected branches  Develop branch  Integration method (pr or merge)  Feature prefix  Bugfix prefix  Release prefix  Hotfix prefix  Commit policy preset  Custom commit pattern  Default profile name  Changelog step before a PR  Docs refresh before a PR  Manage profiles  Manage release tracks❯ Save workspace settings

      ### workspaces: saved
      workit — workflow rails for agentic codingStep 5 — Workspaces✓ matches work — ? — <tmp>/project/**  Edit work (<tmp>/project/**)  Remove work  Add workspace  Use current project (<tmp>/project)❯ Done  Advanced global commit policy  Advanced settings for workEnter to continue · b Back · Esc Cancel

      ### globalCommitPolicy
      workit — workflow rails for agentic codingAdvanced global commit policyDefault convention used when a workspace has no commit override.❯ Conventional commits  Gitmoji  Ticket prefix  Freeform  Custom pattern  Auto-detect  Edit custom pattern…  DoneEnter to select · b Back

      ### globalCommitPolicy: gitmoji
      workit — workflow rails for agentic codingAdvanced global commit policyDefault convention used when a workspace has no commit override.  Conventional commits❯ Gitmoji  Ticket prefix  Freeform  Custom pattern  Auto-detect  Edit custom pattern…  DoneEnter to select · b Back

      ### globalCommitPattern
      workit — workflow rails for agentic codingAdvanced global commit policy · Custom patternRegular expression matched against the commit subject line.Enter to save · Esc Back

      ### globalCommitPolicy: after pattern
      workit — workflow rails for agentic codingAdvanced global commit policyDefault convention used when a workspace has no commit override.Custom pattern: ^feat  Conventional commits❯ Gitmoji  Ticket prefix  Freeform  Custom pattern  Auto-detect  Edit custom pattern…  DoneEnter to select · b Back

      ### workspaces: back from commit policy
      workit — workflow rails for agentic codingStep 5 — Workspaces✓ matches work — ? — <tmp>/project/**  Edit work (<tmp>/project/**)  Remove work  Add workspace  Use current project (<tmp>/project)❯ Done  Advanced global commit policy  Advanced settings for workEnter to continue · b Back · Esc Cancel

      ### project: refused
      workit — workflow rails for agentic codingStep 6 — Project setupSkipped: <tmp>/project is not a git repository, so no project files were added there; cd <repo> (or gitinit here) and run workit init againY/ny to keep this note in the summary · n to skip it · either adds no project files · b Back · Esc Cancel

      ### summary
      workit — workflow rails for agentic codingReviewPlatforms: opencode, cursorLocale: es-CLBranch policy: custom — allowed: feature/*, bugfix/*, hotfix/*, release/* · protected: main, develop, master, prod,productionSample checkout: <tmp>/project · workspace workEffective branch policy: gitflow · target develop · source profile:releaseEffective commit policy: conventional · source profile:releaseYouTrack base URL: https://example.youtrack.cloudVCS provider: githubProject hygiene: skipped — <tmp>/project is not a git repository, so no project files were added there;cd <repo> (or git init here) and run workit init againWill apply:+ write <tmp>/config/config.json+ update <tmp>/config/workspaces.json (1 workspace)+ write <tmp>/config/youtrack.json+ create <tmp>/config/youtrack.token+ write <tmp>/config/vcs.json+ register opencode: <tmp>/home/.config/opencode/opencode.json+ copy adapter cursor: <tmp>/home/.cursor/plugins/local/workit+ register cursor: <tmp>/home/.cursor/settings.json+ register cursor: <tmp>/home/.cursor/mcp.jsonY/ny to apply · b Back · Esc Cancel

      ### summary: apply
      workit — workflow rails for agentic codingExiting…

      ### onExit
      [
        {
          "complete": true,
          "values": {
            "platforms": [
              "opencode",
              "cursor"
            ],
            "locale": "es-CL",
            "branchPreset": "custom",
            "branchAllowed": "feature/*, bugfix/*, hotfix/*, release/*",
            "branchProtected": "main, develop, master, prod, production",
            "commitPolicy": {
              "preset": "gitmoji",
              "pattern": "^feat"
            },
            "baseUrl": "https://example.youtrack.cloud",
            "basePath": "<tmp>/project",
            "issueTracker": "youtrack",
            "vcsProvider": "github",
            "workspaces": [
              {
                "name": "work",
                "glob": "<tmp>/project/**",
                "youtrack": {
                  "link_issues": true
                },
                "profiles": {
                  "release": {
                    "commitPolicy": {
                      "preset": "conventional"
                    },
                    "branchPolicy": {
                      "preset": "gitflow",
                      "allowed": [
                        "release/*"
                      ]
                    }
                  }
                },
                "defaultProfile": "release",
                "releaseTracks": {
                  "stable": {
                    "strategy": "github-flow",
                    "productionBranch": "maintrunk",
                    "integrationBranch": "develop",
                    "naming": {
                      "feature": "feature/{name}",
                      "release": "release/{version}",
                      "hotfix": "hotfix/{name}"
                    },
                    "baseBranch": "develop",
                    "mergeBackBranches": [
                      "develop"
                    ],
                    "pullRequestTarget": "develop",
                    "tagNamespace": "",
                    "versionSource": {
                      "kind": "git-tag"
                    },
                    "requiredChecks": []
                  }
                }
              }
            ],
            "applyProject": true
          }
        }
      ]"
    `);
  });
}, 120_000);

test("golden: the branch-policy screens in a git checkout render the same frames and exit values", async () => {
  await inSandbox(async (box) => {
    const git = (...args: string[]) =>
      spawnSync("git", args, {
        cwd: box.project,
        encoding: "utf8",
        env: { ...process.env },
      });
    git("init", "-q", "-b", "main");
    git(
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    git("branch", "develop");
    process.env.WORKFLOW_WORKSPACE_ROOT = box.project;
    const exits: Array<{ complete: boolean; values?: SetupValues }> = [];
    const tty = await renderInk(
      <Wizard
        onExit={(complete, values) => exits.push({ complete, values })}
        detection={detection}
      />,
    );
    const rec = recorder(box, tty);
    await rec.step("workspaces", ENTER, ENTER, ENTER, ENTER, ENTER, ENTER);
    await rec.step("branchPolicy", ENTER);
    await rec.step("branchPolicy: integration", DOWN, ENTER);
    await rec.step("branchPolicy: after integration", UP, ENTER);
    await rec.step("branchPolicyDevelop", DOWN, DOWN, ENTER);
    await rec.step("branchPolicy: after develop", "-next", ENTER);
    await rec.step("branchPolicy: back to workspaces", "b");
    await rec.step("branchPolicy: again", ENTER);
    await rec.step("project", ENTER);
    await rec.step("summary", "n");
    await rec.step("cancel", ESC);
    tty.unmount();
    rec.frames.push(`### onExit\n${rec.normalize(JSON.stringify(exits, null, 2))}`);
    expect(rec.frames.join("\n\n")).toMatchInlineSnapshot(`
      "### workspaces
      workit — workflow rails for agentic codingStep 5 — WorkspacesNo workspaces configured yet.  Add workspace  Use current project (<tmp>/project)❯ Done  Advanced global commit policyEnter to continue · b Back · Esc Cancel

      ### branchPolicy
      workit — workflow rails for agentic codingStep 5 — Branch policyDetected preset: gitflowDevelop branch: developIntegration: mergePrefixes: feature/*, bugfix/*, release/*, hotfix/*Protected: main, develop❯ Accept defaults  Edit integration  Edit develop  SkipEnter to continue · b Back · Esc Cancel

      ### branchPolicy: integration
      workit — workflow rails for agentic codingStep 5 — Branch policy · Integration  Pull request (pr)❯ Merge commitEnter to select · b Back · Esc Cancel

      ### branchPolicy: after integration
      workit — workflow rails for agentic codingStep 5 — Branch policyDetected preset: gitflowDevelop branch: developIntegration: prPrefixes: feature/*, bugfix/*, release/*, hotfix/*Protected: main, develop❯ Accept defaults  Edit integration  Edit develop  SkipEnter to continue · b Back · Esc Cancel

      ### branchPolicyDevelop
      workit — workflow rails for agentic codingStep 5 — Branch policy · Develop branchIntegration/develop branch name (leave empty to unset):developEnter to save · Esc Back

      ### branchPolicy: after develop
      workit — workflow rails for agentic codingStep 5 — Branch policyDetected preset: gitflowDevelop branch: develop-nextIntegration: prPrefixes: feature/*, bugfix/*, release/*, hotfix/*Protected: main, develop❯ Accept defaults  Edit integration  Edit develop  SkipEnter to continue · b Back · Esc Cancel

      ### branchPolicy: back to workspaces
      workit — workflow rails for agentic codingStep 5 — WorkspacesNo workspaces configured yet.  Add workspace  Use current project (<tmp>/project)❯ Done  Advanced global commit policyEnter to continue · b Back · Esc Cancel

      ### branchPolicy: again
      workit — workflow rails for agentic codingStep 5 — Branch policyDetected preset: gitflowDevelop branch: develop-nextIntegration: prPrefixes: feature/*, bugfix/*, release/*, hotfix/*Protected: main, develop❯ Accept defaults  Edit integration  Edit develop  SkipEnter to continue · b Back · Esc Cancel

      ### project
      workit — workflow rails for agentic codingStep 6 — Project setupApply gitignore + hygiene in <tmp>/project? (Existing files are never overwritten.)y/Ny to add project files · n to skip · b Back · Esc Cancel

      ### summary
      workit — workflow rails for agentic codingReviewPlatforms: opencode, cursorLocale: enBranch policy: gitflow — allowed: feature/*, bugfix/*, hotfix/*, release/* · protected: main, develop, master, prod,productionSample checkout: <tmp>/project · no matching workspaceEffective branch policy: gitflow · target develop · source user-defaultEffective commit policy: conventional · source user-defaultYouTrack base URL: — (skip)VCS provider: skipProject hygiene: noWill apply:+ write <tmp>/config/config.json+ register opencode: <tmp>/home/.config/opencode/opencode.json+ copy adapter cursor: <tmp>/home/.cursor/plugins/local/workit+ register cursor: <tmp>/home/.cursor/settings.json+ register cursor: <tmp>/home/.cursor/mcp.jsonY/ny to apply · b Back · Esc Cancel

      ### cancel
      workit — workflow rails for agentic codingExiting…

      ### onExit
      [
        {
          "complete": false,
          "values": {
            "platforms": [
              "opencode",
              "cursor"
            ],
            "locale": "en",
            "branchPreset": "gitflow",
            "branchAllowed": "feature/*, bugfix/*, hotfix/*, release/*",
            "branchProtected": "main, develop, master, prod, production",
            "commitPolicy": {
              "preset": "conventional"
            },
            "baseUrl": "",
            "basePath": "<tmp>/project",
            "issueTracker": "youtrack",
            "vcsProvider": "skip",
            "workspaces": [],
            "applyProject": false,
            "branchPolicyDetected": {
              "preset": "gitflow",
              "developBranch": "develop",
              "integration": "merge",
              "protected": [
                "main",
                "develop"
              ],
              "allowed": [
                "feature/*",
                "bugfix/*",
                "hotfix/*",
                "release/*"
              ],
              "prefixes": {
                "feature": "feature/*",
                "bugfix": "bugfix/*",
                "release": "release/*",
                "hotfix": "hotfix/*"
              }
            },
            "branchPolicy": {
              "preset": "gitflow",
              "developBranch": "develop-next",
              "integration": "pr",
              "protected": [
                "main",
                "develop"
              ],
              "allowed": [
                "feature/*",
                "bugfix/*",
                "hotfix/*",
                "release/*"
              ],
              "prefixes": {
                "feature": "feature/*",
                "bugfix": "bugfix/*",
                "release": "release/*",
                "hotfix": "hotfix/*"
              }
            }
          }
        }
      ]"
    `);
  });
}, 60_000);

test("Given a profile was just edited, When Done returns to the profile list and Enter is pressed at once, Then the list's default row (Back) is taken instead of crashing", async () => {
  await inSandbox(async (box) => {
    process.env.WORKFLOW_WORKSPACE_ROOT = box.project;
    const tty = await renderInk(<Wizard onExit={() => {}} detection={detection} />);
    await tty.keys(ENTER, ENTER, ENTER, ENTER, ENTER, ENTER);
    await tty.keys(UP, UP, ENTER, "work", ENTER, "/work/**", ENTER, ENTER);
    await tty.keys(DOWN, DOWN, ENTER);
    await tty.keys(UP, UP, ENTER, UP, ENTER, "release", ENTER);
    expect(tty.lastFrame()).toContain("❯ Done editing");
    await tty.keys(ENTER);
    expect(tty.lastFrame()).toContain("❯ Back to advanced settings");
    await tty.keys(ENTER);
    expect(tty.lastFrame()).toContain("Advanced workspace settings · work");
    expect(tty.lastFrame()).toContain("❯ Save workspace settings");
    tty.unmount();
  });
}, 60_000);
