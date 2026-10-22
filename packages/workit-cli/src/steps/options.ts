import {
  PRESETS,
  mergePreset,
  type BranchPreset,
  type ToolkitConfig,
} from "@brainervirus/workit-core/src/core/config.ts";
import {
  parseList,
  type WorkspaceEditorField,
  type ProfileEditorField,
  type TrackEditorField,
} from "../logic";
import type { SetupValues } from "../wizard-state";
import type { HostId } from "../admin/detect-hosts";
import { LOCALE_LANGUAGE_MAP } from "../search-select";

export const PLATFORM_LABELS: { label: string; value: HostId }[] = [
  { label: "OpenCode", value: "opencode" },
  { label: "Cursor", value: "cursor" },
  { label: "Codex", value: "codex" },
  { label: "Pi", value: "pi" },
  { label: "Claude Code", value: "claude-code" },
];

export const BRANCH_PRESETS: { label: string; value: BranchPreset }[] = [
  { label: "GitFlow", value: "gitflow" },
  { label: "GitHub Flow", value: "github-flow" },
  { label: "Trunk-based", value: "trunk-based" },
  { label: "Custom", value: "custom" },
];

// CA-08: static per-preset guidance shown under the highlighted row — derived
// from PRESETS (the same source mergePreset applies on selection) plus the
// conventional workflow facts. Display-only.
export const BRANCH_PRESET_DESCRIPTIONS: Record<BranchPreset, string> = {
  gitflow:
    `${PRESETS.gitflow.allowed.join(", ")} allowed · ` +
    `${PRESETS.gitflow.protected.join(", ")} protected · work merges into develop via PRs or merge commits`,
  "github-flow": `Anything goes (${PRESETS["github-flow"].allowed[0]}) · only ${PRESETS["github-flow"].protected.join(", ")} is protected · branches off main, back to main`,
  "trunk-based": `Short-lived branches off trunk · ${PRESETS["trunk-based"].protected.join(", ")} is the only protected branch`,
  custom: "Define your own allowed and protected patterns in the next prompts",
};

// CA-09: every TextInput carries an example placeholder. Display-only —
// @inkjs/ui renders it until the user types and never passes it to
// onChange/onSubmit, so submitted values are unaffected.
export const SCREEN_PLACEHOLDERS = {
  youtrack: "e.g. https://example.youtrack.cloud",
  localeOther: "e.g. en-US or es-CL",
  branchAllowed: "e.g. feature/*, bugfix/*",
  branchProtected: "e.g. main, develop",
  workspaceName: "e.g. work",
  workspaceGlob: "e.g. /work/**",
  branchPolicyDevelop: "e.g. develop",
} as const;

export const VCS_PROVIDERS = [
  { label: "GitLab", value: "gitlab" },
  { label: "GitHub", value: "github" },
  { label: "Skip — configure later", value: "skip" },
];

// Module-level so the locale screen's SearchSelect useMemo actually memoizes
// instead of re-filtering a freshly built array every render (Task 3 advisory).
export const LOCALE_PICKER_OPTIONS: { label: string; value: string }[] = [
  ...LOCALE_LANGUAGE_MAP.map((entry) => ({ label: entry.label, value: entry.locale })),
  { label: "Other…", value: "other" },
];

export const ISSUE_TRACKERS: { label: string; value: SetupValues["issueTracker"] }[] = [
  { label: "YouTrack", value: "youtrack" },
  { label: "GitHub Issues", value: "github" },
  { label: "GitLab Issues", value: "gitlab" },
  { label: "None", value: "none" },
];

export const WORKSPACE_ADVANCED_FIELDS: { label: string; value: WorkspaceEditorField }[] = [
  { label: "Hosting provider account", value: "vcs.account" },
  { label: "Default target branch", value: "vcs.defaultTargetBranch" },
  { label: "Workspace YouTrack URL", value: "youtrack.baseUrl" },
  { label: "Link issues in YouTrack", value: "youtrack.link_issues" },
  { label: "Link GitHub issues on pull requests", value: "issues.link_on_pr" },
  { label: "Branch preset", value: "branchPolicy.preset" },
  { label: "Allowed branch patterns", value: "branchPolicy.allowed" },
  { label: "Protected branches", value: "branchPolicy.protected" },
  { label: "Develop branch", value: "branchPolicy.developBranch" },
  { label: "Integration method (pr or merge)", value: "branchPolicy.integration" },
  { label: "Feature prefix", value: "branchPolicy.prefixes.feature" },
  { label: "Bugfix prefix", value: "branchPolicy.prefixes.bugfix" },
  { label: "Release prefix", value: "branchPolicy.prefixes.release" },
  { label: "Hotfix prefix", value: "branchPolicy.prefixes.hotfix" },
  { label: "Commit policy preset", value: "commitPolicy.preset" },
  { label: "Custom commit pattern", value: "commitPolicy.pattern" },
  { label: "Default profile name", value: "defaultProfile" },
];

export const PROFILE_FIELDS: { label: string; value: ProfileEditorField }[] = [
  { label: "Branch preset", value: "branchPolicy.preset" },
  { label: "Allowed patterns", value: "branchPolicy.allowed" },
  { label: "Protected branches", value: "branchPolicy.protected" },
  { label: "Develop branch", value: "branchPolicy.developBranch" },
  { label: "Integration (pr or merge)", value: "branchPolicy.integration" },
  { label: "Feature prefix", value: "branchPolicy.prefixes.feature" },
  { label: "Bugfix prefix", value: "branchPolicy.prefixes.bugfix" },
  { label: "Release prefix", value: "branchPolicy.prefixes.release" },
  { label: "Hotfix prefix", value: "branchPolicy.prefixes.hotfix" },
  { label: "Commit preset", value: "commitPolicy.preset" },
  { label: "Commit pattern", value: "commitPolicy.pattern" },
];
export const TRACK_FIELDS: { label: string; value: TrackEditorField }[] = [
  { label: "Strategy", value: "strategy" },
  { label: "Production branch", value: "productionBranch" },
  { label: "Integration branch", value: "integrationBranch" },
  { label: "Feature branch naming", value: "naming.feature" },
  { label: "Release branch naming", value: "naming.release" },
  { label: "Hotfix branch naming", value: "naming.hotfix" },
  { label: "Base branch", value: "baseBranch" },
  { label: "Merge-back branches", value: "mergeBackBranches" },
  { label: "Pull request target", value: "pullRequestTarget" },
  { label: "Tag namespace", value: "tagNamespace" },
  { label: "Version source (manual, git-tag, package-json)", value: "versionSource.kind" },
  { label: "Package.json path", value: "versionSource.path" },
  { label: "Package version field", value: "versionSource.field" },
  { label: "Required checks", value: "requiredChecks" },
];
export const enumFieldOptions = (field: string): { label: string; value: string }[] | null => {
  if (field === "commitPolicy.preset")
    return [{ label: "Inherit global", value: "inherit" }, ...commitPresetOptions];
  if (field === "branchPolicy.preset")
    return [
      { label: "Inherit global", value: "inherit" },
      { label: "GitFlow", value: "gitflow" },
      { label: "GitHub Flow", value: "github-flow" },
      { label: "Trunk-based", value: "trunk-based" },
      { label: "Custom", value: "custom" },
    ];
  if (field === "strategy")
    return [
      { label: "GitFlow", value: "gitflow" },
      { label: "GitHub Flow", value: "github-flow" },
      { label: "Trunk-based", value: "trunk-based" },
      { label: "Custom", value: "custom" },
    ];
  if (field.endsWith(".integration"))
    return [
      { label: "Pull requests", value: "pr" },
      { label: "Merge commits", value: "merge" },
    ];
  if (field === "versionSource.kind")
    return [
      { label: "Package.json", value: "package-json" },
      { label: "Git tag", value: "git-tag" },
      { label: "Manual", value: "manual" },
    ];
  if (field === "youtrack.link_issues" || field === "issues.link_on_pr")
    return [
      { label: "Inherit global behavior", value: "inherit" },
      { label: "Enabled", value: "true" },
      { label: "Disabled", value: "false" },
    ];
  return null;
};
const commitPresetOptions = [
  { label: "Conventional commits", value: "conventional" },
  { label: "Gitmoji", value: "gitmoji" },
  { label: "Ticket prefix", value: "ticket-prefix" },
  { label: "Freeform", value: "freeform" },
  { label: "Custom pattern", value: "custom" },
  { label: "Auto-detect", value: "auto" },
];

export function effectivePolicy(values: SetupValues): ToolkitConfig["branchPolicy"] {
  // RL-02: one shared preset merge — non-custom presets always reset their
  // derived allowed/protected fields, custom uses the validated draft input.
  return mergePreset(values.branchPreset, {
    allowed: parseList(values.branchAllowed),
    protectedNames: parseList(values.branchProtected),
  });
}
