import { Box, Text, useInput } from "ink";
import { ConfirmInput, TextInput } from "@inkjs/ui";
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  useCallback,
  type Dispatch,
  type JSX,
} from "react";
import {
  mergePreset,
  PRESETS,
  readConfig,
  type BranchPreset,
  type ToolkitConfig,
} from "@brainervirus/workit-core/src/core/config.ts";
import {
  buildSetupPreview,
  parseList,
  workspaceEditorValue,
  profileEditorValue,
  trackEditorValue,
  type SetupMutation,
  type WorkspaceEditorField,
  type ProfileEditorField,
  type TrackEditorField,
} from "./logic";
import {
  matchWorkspace,
  resolveWorkspaceFromEntries,
  resolveWorkspacePolicy,
} from "@brainervirus/workit-core/src/core/workspaces.ts";
import { detectBranchPolicy } from "@brainervirus/workit-core/src/core/branch-policy.ts";
import {
  createInitialDraft,
  reducer,
  resolveBasePath,
  type SetupValues,
  type WizardAction,
  type WizardDraft,
  type WizardScreen,
} from "./wizard-state";
import {
  emptyDetection,
  preselectedPlatforms,
  type HostDetection,
  type HostId,
} from "@brainervirus/workit-core/src/core/detect-hosts.ts";
import { LOCALE_LANGUAGE_MAP, SearchSelect } from "./search-select";

const PLATFORM_LABELS: { label: string; value: HostId }[] = [
  { label: "OpenCode", value: "opencode" },
  { label: "Cursor", value: "cursor" },
  { label: "Codex", value: "codex" },
  { label: "Pi", value: "pi" },
];

/** Wizard platform options with auto-detect tags (pure: takes the detection). */
export function platformOptions(
  detection: Record<HostId, HostDetection>,
): { label: string; value: string }[] {
  return PLATFORM_LABELS.map(({ label, value }) => {
    const found = detection[value];
    const tag = found.configured
      ? " · already configured"
      : found.detected
        ? " · detected"
        : " · unavailable";
    return { label: `${label}${tag}`, value };
  });
}

export function externalHostGuidance(detection: Record<HostId, HostDetection>): string[] {
  void detection;
  return [];
}

const BRANCH_PRESETS: { label: string; value: BranchPreset }[] = [
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
  timezoneOther: "e.g. America/Santiago",
  branchAllowed: "e.g. feature/*, bugfix/*",
  branchProtected: "e.g. main, develop",
  workspaceName: "e.g. work",
  workspaceGlob: "e.g. /work/**",
  branchPolicyDevelop: "e.g. develop",
} as const;

const VCS_PROVIDERS = [
  { label: "GitLab", value: "gitlab" },
  { label: "GitHub", value: "github" },
  { label: "Skip — configure later", value: "skip" },
];

// Module-level so the locale screen's SearchSelect useMemo actually memoizes
// instead of re-filtering a freshly built array every render (Task 3 advisory).
const LOCALE_PICKER_OPTIONS: { label: string; value: string }[] = [
  ...LOCALE_LANGUAGE_MAP.map((entry) => ({ label: entry.label, value: entry.locale })),
  { label: "Other…", value: "other" },
];

const ISSUE_TRACKERS: { label: string; value: SetupValues["issueTracker"] }[] = [
  { label: "YouTrack", value: "youtrack" },
  { label: "GitHub Issues", value: "github" },
  { label: "GitLab Issues", value: "gitlab" },
  { label: "None", value: "none" },
];

const WORKSPACE_ADVANCED_FIELDS: { label: string; value: WorkspaceEditorField }[] = [
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

const PROFILE_FIELDS: { label: string; value: ProfileEditorField }[] = [
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
const TRACK_FIELDS: { label: string; value: TrackEditorField }[] = [
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
const enumFieldOptions = (field: string): { label: string; value: string }[] | null => {
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

// Timezone catalog: the runtime's full canonical IANA set when available,
// else a static fallback of common zones. Guard shape mirrors logic.ts
// KNOWN_TIMEZONES — validateTimezone enforces membership exactly when
// supportedValuesOf exists, so the picker then shows precisely that set;
// on the fallback path validation stays open and Other… covers the rest.
const TIMEZONE_FALLBACK = [
  "UTC",
  "America/New_York",
  "America/Santiago",
  "America/Bogota",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Europe/London",
  "Europe/Madrid",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
];
const TIMEZONES: string[] =
  typeof Intl.supportedValuesOf === "function"
    ? Intl.supportedValuesOf("timeZone")
    : TIMEZONE_FALLBACK;
// Detected host zone seeds the picker preselection — no typing needed.
const DETECTED_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function timezonePickerOptions(): { label: string; value: string }[] {
  // Detected host zone heads the list so its preselection is visible in the
  // first window without typing (the full IANA set alone would bury it).
  return TIMEZONE_PICKER_OPTIONS;
}
// Built once at module load (TIMEZONES and DETECTED_TIMEZONE are already
// module-eval constants): rebuilding the IANA catalog per render made the
// screen's useMemo ineffective (Task 3 advisory).
const TIMEZONE_PICKER_OPTIONS: { label: string; value: string }[] = [
  { label: DETECTED_TIMEZONE, value: DETECTED_TIMEZONE },
  ...TIMEZONES.filter((timezone) => timezone !== DETECTED_TIMEZONE).map((timezone) => ({
    label: timezone,
    value: timezone,
  })),
  { label: "Other…", value: "other" },
];
// Text screens cannot offer the 'b' back key (it is a printable character the
// TextInput consumes), so there Esc walks back to the parent select screen and
// cancel happens from select/confirm screens. Draft state survives either way.
const TEXT_SCREENS: ReadonlySet<WizardScreen> = new Set([
  "localeOther",
  "timezoneOther",
  "branchAllowed",
  "branchProtected",
  "youtrack",
  "basePath",
  "workspaceName",
  "workspaceGlob",
  "workspaceAdvancedValue",
  "globalCommitPattern",
  "branchPolicyDevelop",
]);

// Screens whose SearchSelect owns printable input: a cold 'b' starts a search
// instead of navigating back; only a typed-then-cleared query hands 'b' back
// to the wizard's back-navigation.
const SEARCH_SCREENS: ReadonlySet<WizardScreen> = new Set(["locale", "timezone"]);

// Deterministic match-preview samples derived from the current project path:
// the project itself, its parent, and a synthetic child repo. Every accepted
// pattern gets a visible ✓/✗ verdict per sample via the shared core matcher.
function workspacePreviewTargets(cwd: string): string[] {
  const norm = cwd.replace(/[\\/]+$/, "");
  const idx = norm.lastIndexOf("/");
  const parent = idx > 0 ? norm.slice(0, idx) : norm;
  return [norm, parent, `${norm}/child-repo`];
}

type ScreenProps = {
  draft: WizardDraft;
  dispatch: Dispatch<WizardAction>;
  // Optional so sub-screens that never read it (branch policy, base path)
  // keep their call sites unchanged; Screen defaults it when absent.
  detection?: Record<HostId, HostDetection>;
  onSearchQueryChange?: (query: string) => void;
};

// Single-purpose list control: up/down move the highlight (dispatching the
// value), Enter always submits the highlighted option. This is the WZ-11 fix —
// unlike @inkjs/ui Select there is exactly one Enter path and no competing
// onChange/onSubmit handlers, so Enter can never apply a stale value twice.
export function SelectList<T extends string>({
  options,
  value,
  onChange,
  onSelect,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange?: (value: T) => void;
  onSelect: (value: T) => void;
}): JSX.Element {
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      options.findIndex((option) => option.value === value),
    ),
  );
  // Burst-input mirror (Task 1 advisory): two arrow keys can arrive in one
  // stdin chunk, both handled before React re-renders — a closure-read index
  // would collapse them into one step. The ref is updated synchronously in the
  // handler; this effect only re-syncs after commits so render stays pure
  // (react-doctor no-ref-current-in-render). WZ-13 unchanged: no side effects
  // inside setState updaters; onChange stays a sibling of setIndex.
  const indexRef = useRef(index);
  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  useInput((_input, key) => {
    if (key.downArrow || key.upArrow) {
      const next = key.downArrow
        ? Math.min(indexRef.current + 1, options.length - 1)
        : Math.max(indexRef.current - 1, 0);
      // Boundary clamp: an arrow that cannot move neither re-renders nor
      // re-dispatches the already-current value.
      if (next === indexRef.current) return;
      indexRef.current = next;
      setIndex(next);
      onChange?.(options[next].value);
    } else if (key.return) {
      onSelect(options[indexRef.current].value);
    }
  });

  return (
    <Box flexDirection="column" gap={0}>
      {options.map((option, i) => (
        <Text key={option.value} color={i === index ? "cyan" : "dim"}>
          {i === index ? "❯ " : "  "}
          {option.label}
        </Text>
      ))}
    </Box>
  );
}

function HostPicker({
  detection,
  selected,
  onChange,
  onSubmit,
}: {
  detection: Record<HostId, HostDetection>;
  selected: string[];
  onChange: (selected: string[]) => void;
  onSubmit: (selected: string[]) => void;
}): JSX.Element {
  const available = PLATFORM_LABELS.filter(({ value }) => detection[value].detected).map(
    ({ value }) => value,
  );
  const options = [
    { label: "Select all available", value: "__all" },
    { label: "Clear all", value: "__none" },
    ...PLATFORM_LABELS.map(({ label, value }) => ({ label, value })),
  ];
  const [index, setIndex] = useState(0);
  const indexRef = useRef(index);
  const [chosen, setChosen] = useState(selected);
  const chosenRef = useRef(chosen);
  useEffect(() => {
    indexRef.current = index;
  }, [index]);
  useEffect(() => {
    chosenRef.current = chosen;
  }, [chosen]);
  const update = (next: string[]) => {
    chosenRef.current = next;
    setChosen(next);
    onChange(next);
  };
  useInput((input, key) => {
    if (key.upArrow || key.downArrow) {
      const next = Math.max(
        0,
        Math.min(options.length - 1, indexRef.current + (key.downArrow ? 1 : -1)),
      );
      indexRef.current = next;
      setIndex(next);
      return;
    }
    if (input === " ") {
      const option = options[indexRef.current];
      if (option.value === "__all") update([...available]);
      else if (option.value === "__none") update([]);
      else if (detection[option.value as HostId].detected) {
        const next = chosenRef.current.includes(option.value)
          ? chosenRef.current.filter((host) => host !== option.value)
          : [...chosenRef.current, option.value];
        update(next);
      }
    } else if (key.return) {
      const option = options[indexRef.current];
      if (option.value === "__all") update([...available]);
      else if (option.value === "__none") update([]);
      onSubmit(chosenRef.current);
    }
  });
  return (
    <Box flexDirection="column" gap={0}>
      {options.map((option, row) => {
        const host =
          option.value === "__all" || option.value === "__none" ? null : (option.value as HostId);
        const detected = host === null || detection[host].detected;
        const checked = host !== null && chosen.includes(host);
        const label =
          host === null
            ? option.label
            : `${checked ? "[✓]" : "[ ]"} ${option.label}${detection[host].configured ? " · already configured" : detection[host].detected ? " · detected" : " · unavailable"}`;
        return (
          <Text key={option.value} color={row === index ? "cyan" : undefined} dimColor={!detected}>
            {row === index ? "❯ " : "  "}
            {label}
          </Text>
        );
      })}
    </Box>
  );
}

function WorkspaceCollectionEditor({
  draft,
  dispatch,
}: {
  draft: WizardDraft;
  dispatch: Dispatch<WizardAction>;
}): JSX.Element {
  type Mode =
    | "main"
    | "profiles"
    | "profileName"
    | "profileEdit"
    | "profileValue"
    | "tracks"
    | "trackName"
    | "trackEdit"
    | "trackValue";
  const [mode, setMode] = useState<Mode>("main");
  const [name, setName] = useState("");
  const [field, setField] = useState<ProfileEditorField | TrackEditorField | null>(null);
  const [nameError, setNameError] = useState("");
  const workspace = draft.workspaceDraft;
  const profileNames = Object.keys(workspace?.profiles ?? {});
  const trackNames = Object.keys(workspace?.releaseTracks ?? {});
  if (!workspace) return <Text color="red">Workspace draft is unavailable.</Text>;

  if (mode === "profiles") {
    const options = [
      ...profileNames.flatMap((profile) => [
        { label: `Edit profile ${profile}`, value: `edit:${profile}` },
        { label: `Set ${profile} as default`, value: `default:${profile}` },
        { label: `Delete profile ${profile}`, value: `delete:${profile}` },
      ]),
      { label: "Create profile", value: "create" },
      { label: "Back to advanced settings", value: "back" },
    ];
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Profiles · default: {workspace.defaultProfile ?? "none"}</Text>
        <Text dimColor>Profiles can override branch rules and commit conventions.</Text>
        <SelectList
          options={options}
          value="back"
          onSelect={(value) => {
            const profileName = value.slice(value.indexOf(":") + 1);
            if (value === "create") {
              setNameError("");
              setName("");
              setMode("profileName");
            } else if (value.startsWith("edit:")) {
              setName(profileName);
              setMode("profileEdit");
            } else if (value.startsWith("default:"))
              dispatch({ type: "workspaceProfileDefault", name: profileName });
            else if (value.startsWith("delete:"))
              dispatch({ type: "workspaceProfileDelete", name: profileName });
            else setMode("main");
          }}
        />
      </Box>
    );
  }
  if (mode === "profileName")
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Create profile</Text>
        <Text dimColor>Profile name:</Text>
        <TextInput
          onSubmit={(value) => {
            const next = value.trim();
            if (!next) {
              setNameError("Enter a profile name.");
              return;
            }
            if (workspace.profiles?.[next]) {
              setNameError(
                `Profile ${next} already exists. Choose a different name or edit it from the list.`,
              );
              return;
            }
            dispatch({ type: "workspaceProfileCreate", name: next });
            setName(next);
            setMode("profileEdit");
          }}
        />
        {nameError && <Text color="red">{nameError}</Text>}
        <Text dimColor>Enter to create · Esc Back</Text>
      </Box>
    );
  if (mode === "profileEdit" || mode === "profileValue") {
    const selected = workspace.profiles?.[name];
    if (mode === "profileValue" && field) {
      const item = PROFILE_FIELDS.find((entry) => entry.value === field);
      const choices = enumFieldOptions(field);
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>
            Profile {name} · {item?.label}
          </Text>
          {choices ? (
            <SelectList
              options={choices}
              value={
                selected
                  ? profileEditorValue(selected, field as ProfileEditorField)
                  : choices[0].value
              }
              onSelect={(value) => {
                dispatch({
                  type: "workspaceProfileSet",
                  name,
                  field: field as ProfileEditorField,
                  value,
                });
                setMode("profileEdit");
              }}
            />
          ) : (
            <TextInput
              defaultValue={
                selected ? profileEditorValue(selected, field as ProfileEditorField) : ""
              }
              onSubmit={(value) => {
                dispatch({
                  type: "workspaceProfileSet",
                  name,
                  field: field as ProfileEditorField,
                  value,
                });
                setMode("profileEdit");
              }}
            />
          )}
          <Text dimColor>Enter to save · Esc Back</Text>
        </Box>
      );
    }
    const options = [
      ...PROFILE_FIELDS,
      { label: "Done editing", value: "done" as ProfileEditorField },
    ];
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Edit profile · {name}</Text>
        {PROFILE_FIELDS.map((item) => (
          <Text key={item.value} dimColor>
            {item.label}: {selected ? profileEditorValue(selected, item.value) || "unset" : ""}
          </Text>
        ))}
        <SelectList
          options={options}
          value="done"
          onSelect={(value) => {
            if (value === "done") setMode("profiles");
            else {
              setField(value);
              setMode("profileValue");
            }
          }}
        />
      </Box>
    );
  }
  if (mode === "tracks") {
    const options = [
      ...trackNames.flatMap((track) => [
        { label: `Edit release track ${track}`, value: `edit:${track}` },
        { label: `Delete release track ${track}`, value: `delete:${track}` },
      ]),
      { label: "Create release track", value: "create" },
      { label: "Back to advanced settings", value: "back" },
    ];
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Named release tracks</Text>
        <Text dimColor>Each track has its own branches, naming, version source, and checks.</Text>
        <SelectList
          options={options}
          value="back"
          onSelect={(value) => {
            const trackName = value.slice(value.indexOf(":") + 1);
            if (value === "create") {
              setNameError("");
              setName("");
              setMode("trackName");
            } else if (value.startsWith("edit:")) {
              setName(trackName);
              setMode("trackEdit");
            } else if (value.startsWith("delete:"))
              dispatch({ type: "workspaceTrackDelete", name: trackName });
            else setMode("main");
          }}
        />
      </Box>
    );
  }
  if (mode === "trackName")
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Create release track</Text>
        <Text dimColor>Track name:</Text>
        <TextInput
          onSubmit={(value) => {
            const next = value.trim();
            if (!next) {
              setNameError("Enter a release-track name.");
              return;
            }
            if (workspace.releaseTracks?.[next]) {
              setNameError(
                `Release track ${next} already exists. Choose a different name or edit it from the list.`,
              );
              return;
            }
            dispatch({ type: "workspaceTrackCreate", name: next });
            setName(next);
            setMode("trackEdit");
          }}
        />
        {nameError && <Text color="red">{nameError}</Text>}
        <Text dimColor>Enter to create · Esc Back</Text>
      </Box>
    );
  if (mode === "trackEdit" || mode === "trackValue") {
    const selected = workspace.releaseTracks?.[name];
    if (mode === "trackValue" && field) {
      const item = TRACK_FIELDS.find((entry) => entry.value === field);
      const choices = enumFieldOptions(field);
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>
            Release track {name} · {item?.label}
          </Text>
          {choices ? (
            <SelectList
              options={choices}
              value={
                selected ? trackEditorValue(selected, field as TrackEditorField) : choices[0].value
              }
              onSelect={(value) => {
                dispatch({
                  type: "workspaceTrackSet",
                  name,
                  field: field as TrackEditorField,
                  value,
                });
                setMode("trackEdit");
              }}
            />
          ) : (
            <TextInput
              defaultValue={selected ? trackEditorValue(selected, field as TrackEditorField) : ""}
              onSubmit={(value) => {
                dispatch({
                  type: "workspaceTrackSet",
                  name,
                  field: field as TrackEditorField,
                  value,
                });
                setMode("trackEdit");
              }}
            />
          )}
          <Text dimColor>Lists use comma-separated values · Enter to save · Esc Back</Text>
        </Box>
      );
    }
    const options = [...TRACK_FIELDS, { label: "Done editing", value: "done" as TrackEditorField }];
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Edit release track · {name}</Text>
        {TRACK_FIELDS.map((item) => (
          <Text key={item.value} dimColor>
            {item.label}: {selected ? trackEditorValue(selected, item.value) || "unset" : ""}
          </Text>
        ))}
        <SelectList
          options={options}
          value="done"
          onSelect={(value) => {
            if (value === "done") setMode("tracks");
            else {
              setField(value);
              setMode("trackValue");
            }
          }}
        />
      </Box>
    );
  }

  const options = [
    ...WORKSPACE_ADVANCED_FIELDS,
    { label: "Manage profiles", value: "profiles" as const },
    { label: "Manage release tracks", value: "tracks" as const },
    { label: "Save workspace settings", value: "save" as const },
  ];
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Advanced workspace settings · {workspace.name}</Text>
      <Text dimColor>
        Choose a setting to edit. Lists use comma-separated values; blank clears an override.
      </Text>
      {[...WORKSPACE_ADVANCED_FIELDS].map(({ label, value }) => (
        <Text key={value} dimColor>
          {label}: {workspaceEditorValue(workspace, value) || "inherited / unset"}
        </Text>
      ))}
      <SelectList
        options={options}
        value="save"
        onSelect={(value) => {
          if (value === "save") dispatch({ type: "workspaceSave" });
          else if (value === "profiles") setMode("profiles");
          else if (value === "tracks") setMode("tracks");
          else dispatch({ type: "workspaceAdvancedSelect", field: value });
        }}
      />
    </Box>
  );
}

function effectivePolicy(values: SetupValues): ToolkitConfig["branchPolicy"] {
  // RL-02: one shared preset merge — non-custom presets always reset their
  // derived allowed/protected fields, custom uses the validated draft input.
  return mergePreset(values.branchPreset, {
    allowed: parseList(values.branchAllowed),
    protectedNames: parseList(values.branchProtected),
  });
}

// CA-06: proposal screen shown between workspaces and project when the
// resolution root is a git repo. On mount it runs the shared detector and
// dispatches the proposal into the draft; the develop-branch edit is a real
// top-level text screen ("branchPolicyDevelop") so 'b' types into the input
// instead of navigating back (I2); the integration edit stays a component-local
// select (selects already have correct b/Esc semantics on this screen).
// Accepting stores the proposal into values.branchPolicy so runInit applies it
// through the same shared helper the host init action uses (byte-identical
// write).
type BranchPolicyEditMode = "menu" | "integration";

const BRANCH_POLICY_ACTIONS: { label: string; value: string }[] = [
  { label: "Accept defaults", value: "accept" },
  { label: "Edit integration", value: "integration" },
  { label: "Edit develop", value: "develop" },
  { label: "Skip", value: "skip" },
];

const INTEGRATION_OPTIONS: { label: string; value: "pr" | "merge" }[] = [
  { label: "Pull request (pr)", value: "pr" },
  { label: "Merge commit", value: "merge" },
];

function BranchPolicyScreen({ draft, dispatch }: ScreenProps): JSX.Element {
  const detected = draft.values.branchPolicyDetected;
  // I1: render the composed (edited) policy when present, the proposal otherwise
  // so edits show live on return from the integration/develop editors.
  const policy = draft.values.branchPolicy ?? detected;
  const [mode, setMode] = useState<BranchPolicyEditMode>("menu");

  useEffect(() => {
    if (detected) return;
    dispatch({
      type: "set",
      field: "branchPolicyDetected",
      value: detectBranchPolicy(resolveBasePath(draft.values)),
    });
  }, [detected, dispatch]);

  if (mode === "integration") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Step 5 — Branch policy · Integration</Text>
        <SelectList
          options={INTEGRATION_OPTIONS}
          value={policy?.integration ?? "merge"}
          onSelect={(value) => {
            dispatch({ type: "set", field: "branchPolicyIntegration", value });
            setMode("menu");
          }}
        />
        <Text dimColor>Enter to select · b Back · Esc Cancel</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Step 5 — Branch policy</Text>
      {policy ? (
        <Box flexDirection="column" gap={0}>
          <Text>
            Detected preset: <Text color="green">{policy.preset}</Text>
          </Text>
          <Text>
            Develop branch: <Text color="green">{policy.developBranch ?? "—"}</Text>
          </Text>
          <Text>
            Integration: <Text color="green">{policy.integration}</Text>
          </Text>
          <Text>
            Prefixes:{" "}
            <Text color="green">{Object.values(policy.prefixes ?? {}).join(", ") || "—"}</Text>
          </Text>
          <Text>
            Protected: <Text color="green">{policy.protected?.join(", ") || "—"}</Text>
          </Text>
        </Box>
      ) : (
        <Text dimColor>Detecting branch policy…</Text>
      )}
      <SelectList
        options={BRANCH_POLICY_ACTIONS}
        value="accept"
        onSelect={(value) => {
          // I1: Accept keeps whatever the user already edited; without edits it
          // stores the detected proposal.
          if (value === "accept" && policy) {
            if (detected) dispatch({ type: "set", field: "branchPolicy", value: detected });
            dispatch({ type: "next" });
          } else if (value === "integration") setMode("integration");
          else if (value === "develop") dispatch({ type: "branchPolicyEditDevelop" });
          else dispatch({ type: "next" });
        }}
      />
      <Text dimColor>Enter to continue · b Back · Esc Cancel</Text>
    </Box>
  );
}

export function Wizard({
  onExit,
  // Hermetic-by-default: runInit passes the live detectHosts(); tests render
  // without it and get no preselection, so ambient machine state can never
  // leak into a test run.
  detection = emptyDetection(),
}: {
  onExit: (complete: boolean, values?: SetupValues) => void;
  detection?: Record<HostId, HostDetection>;
}): JSX.Element {
  const [draft, dispatch] = useReducer(reducer, detection, (found) => {
    const initial = createInitialDraft();
    const platforms = preselectedPlatforms(found);
    return platforms.length > 0
      ? { ...initial, values: { ...initial.values, platforms } }
      : initial;
  });
  const exitedRef = useRef(false);
  // Consumed-key policy for the locale SearchSelect: it reports every query
  // change synchronously, and this screen-level handler observes the value
  // BEFORE the keystroke reaches the picker (parent subscriptions run first),
  // so `q` is the pre-keystroke query. `typed` latches once a query became
  // non-empty: "typed and cleared" hands 'b' back to navigation.
  const searchRef = useRef({ q: "", typed: false });

  useEffect(() => {
    searchRef.current = { q: "", typed: false };
  }, [draft.screen]);

  useInput((input, key) => {
    // Ctrl+C always cancels — independent of Ink's exitOnCtrlC setting, so
    // disabling it can never turn ctrl+c into a back-navigation on text screens.
    if (key.ctrl && input.toLowerCase() === "c") {
      dispatch({ type: "cancel" });
    } else if (key.escape) {
      if (TEXT_SCREENS.has(draft.screen)) dispatch({ type: "back" });
      else dispatch({ type: "cancel" });
    } else if (input.toLowerCase() === "b" && !TEXT_SCREENS.has(draft.screen)) {
      // While a search is live or being started on a SearchSelect screen
      // (locale, timezone), 'b' belongs to the query; only a typed-then-cleared
      // search navigates back. Other screens keep plain 'b' back-navigation.
      const search = searchRef.current;
      const searchOwnsB = SEARCH_SCREENS.has(draft.screen) && !(search.typed && search.q === "");
      if (!searchOwnsB) dispatch({ type: "back" });
    }
  });

  useEffect(() => {
    if (draft.screen === "exit" && !exitedRef.current) {
      exitedRef.current = true;
      onExit(!draft.cancelled, draft.values);
    }
  }, [draft.screen, draft.cancelled, draft.values, onExit]);

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">
        workit — workflow rails for agentic coding
      </Text>
      {/* Screen changes mount the same element types (TextInput/SelectList) at the
          same tree position, so React would reuse the previous screen's control
          instance and leak its field state (e.g. "feature/*" into branchProtected).
          Remounting per screen resets each control from the draft values. */}
      <Screen
        key={draft.screen}
        draft={draft}
        dispatch={dispatch}
        detection={detection}
        onSearchQueryChange={(query) => {
          const search = searchRef.current;
          search.q = query;
          if (query !== "") search.typed = true;
        }}
      />
    </Box>
  );
}

function describeMutation(m: SetupMutation): string {
  switch (m.type) {
    case "create-file":
      return `+ create ${m.path}`;
    case "merge-json":
      return `+ write ${m.path}`;
    case "update-workspaces":
      return `+ update ${m.path} (${m.entries.length} workspace${m.entries.length === 1 ? "" : "s"})`;
    case "append-gitignore":
      return `+ append ${m.path} (${m.entries.length} entr${m.entries.length === 1 ? "y" : "ies"})`;
    case "register-platform":
      return `+ register ${m.platform}: ${m.path}`;
    case "install-adapter":
      return `+ copy adapter ${m.platform}: ${m.path}`;
    case "install-host":
      return `+ install ${m.platform}: ${m.commands.map((command) => command.command).join(", ")}`;
    case "set-token-path":
      return `+ change ${m.key} in ${m.path} → ${m.value}`;
  }
}

// D-06: shown only when WORKFLOW_WORKSPACE_ROOT is unset — the prompt IS the
// resolution root for every workspace preview and hygiene target. Extracted
// component with stable callbacks: @inkjs/ui re-fires its onChange effect
// whenever the handler identity changes, and fresh inline arrows per render
// multiply dispatch rounds per keystroke (long error strings commit a frame
// per change) — enough to trip React's update-depth guard on backspace runs.
function BasePathScreen({ draft, dispatch }: ScreenProps): JSX.Element {
  const onChange = useCallback(
    (value: string) => dispatch({ type: "set", field: "basePath", value }),
    [dispatch],
  );
  // Commit the submitted value before validating: @inkjs/ui fires onChange
  // from an effect, so a keystroke can land after Enter — the same ordering
  // hazard branchPolicyDevelop guards against.
  const onSubmit = useCallback(
    (value: string) => {
      dispatch({ type: "set", field: "basePath", value });
      dispatch({ type: "next" });
    },
    [dispatch],
  );
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Step 5 — Workspace root</Text>
      <Text dimColor>Absolute path where your projects live (e.g. /work):</Text>
      <TextInput defaultValue={draft.values.basePath} onChange={onChange} onSubmit={onSubmit} />
      {draft.errors.basePath && <Text color="red">{draft.errors.basePath}</Text>}
      <Text dimColor>Enter to continue · Esc Back</Text>
    </Box>
  );
}

function Screen({
  draft,
  dispatch,
  detection = emptyDetection(),
  onSearchQueryChange,
}: ScreenProps): JSX.Element {
  switch (draft.screen) {
    case "platforms":
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 1 — Platforms</Text>
          <Text>Choose the detected tools where Workit should be configured.</Text>
          <Text dimColor>Use Space to toggle, or choose Select all available / Clear all.</Text>
          <HostPicker
            detection={detection}
            selected={draft.values.platforms}
            onChange={(values) => dispatch({ type: "set", field: "platforms", value: values })}
            onSubmit={(values) => {
              dispatch({ type: "set", field: "platforms", value: values });
              dispatch({ type: "next" });
            }}
          />
          {draft.errors.platforms && <Text color="red">{draft.errors.platforms}</Text>}
          <Text dimColor>Enter to continue · Esc Cancel</Text>
        </Box>
      );
    case "locale":
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 2 — Global config · Locale</Text>
          <Text dimColor>Locale (BCP-47):</Text>
          <Text>
            Current: <Text color="green">{draft.values.locale}</Text>
          </Text>
          {/* Searchable language picker: typing filters, Enter commits the
              highlighted row's BCP-47 tag. Other… keeps the existing validated
              custom-input flow (CA-03); error display, back/cancel semantics
              and the localeOther text screen are untouched. */}
          <SearchSelect
            options={LOCALE_PICKER_OPTIONS}
            value={draft.values.locale}
            placeholder="Type to search languages…"
            onQueryChange={onSearchQueryChange}
            onSelect={(value) => {
              if (value === "other") dispatch({ type: "pickOther" });
              else {
                dispatch({ type: "set", field: "locale", value });
                dispatch({ type: "next" });
              }
            }}
          />
          {draft.errors.locale && <Text color="red">{draft.errors.locale}</Text>}
          <Text dimColor>Type to filter · Enter to continue · b Back · Esc Cancel</Text>
        </Box>
      );
    case "localeOther":
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 2 — Global config · Locale (custom)</Text>
          <Text dimColor>Type a BCP-47 locale (e.g. en or es-CL):</Text>
          <TextInput
            placeholder={SCREEN_PLACEHOLDERS.localeOther}
            onChange={(value) => dispatch({ type: "set", field: "locale", value })}
            onSubmit={() => dispatch({ type: "next" })}
          />
          {draft.errors.locale && <Text color="red">{draft.errors.locale}</Text>}
          <Text dimColor>Enter to continue · Esc Back</Text>
        </Box>
      );
    case "timezone":
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 2 — Global config · Timezone</Text>
          <Text dimColor>Timezone (IANA name):</Text>
          <Text>
            Current: <Text color="green">{draft.values.timezone}</Text>
          </Text>
          {/* Searchable timezone picker mirroring the locale screen: the
              detected host zone is preselected, typing filters the IANA
              catalog, Enter commits the highlighted row. Other… keeps the
              existing validated custom-input flow (CA-04). */}
          <SearchSelect
            options={timezonePickerOptions()}
            value={draft.values.timezone || DETECTED_TIMEZONE}
            placeholder="Type to search timezones…"
            onQueryChange={onSearchQueryChange}
            onSelect={(value) => {
              if (value === "other") dispatch({ type: "pickOther" });
              else {
                dispatch({ type: "set", field: "timezone", value });
                dispatch({ type: "next" });
              }
            }}
          />
          {draft.errors.timezone && <Text color="red">{draft.errors.timezone}</Text>}
          <Text dimColor>Type to filter · Enter to continue · b Back · Esc Cancel</Text>
        </Box>
      );
    case "timezoneOther":
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 2 — Global config · Timezone (custom)</Text>
          <Text dimColor>Type an IANA timezone (e.g. America/Santiago):</Text>
          <TextInput
            placeholder={SCREEN_PLACEHOLDERS.timezoneOther}
            onChange={(value) => dispatch({ type: "set", field: "timezone", value })}
            onSubmit={() => dispatch({ type: "next" })}
          />
          {draft.errors.timezone && <Text color="red">{draft.errors.timezone}</Text>}
          <Text dimColor>Enter to continue · Esc Back</Text>
        </Box>
      );
    case "branchPreset": {
      const policy = effectivePolicy(draft.values);
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 2 — Global config · Branch policy</Text>
          <Text dimColor>Branch policy preset:</Text>
          <SelectList
            options={BRANCH_PRESETS}
            value={draft.values.branchPreset}
            onChange={(value) => dispatch({ type: "set", field: "branchPreset", value })}
            onSelect={() => dispatch({ type: "next" })}
          />
          <Text dimColor>{BRANCH_PRESET_DESCRIPTIONS[draft.values.branchPreset]}</Text>
          <Box flexDirection="column" gap={0}>
            <Text>
              Allowed: <Text color="green">{policy.allowed.join(", ") || "—"}</Text>
            </Text>
            <Text>
              Protected: <Text color="green">{policy.protected.join(", ") || "—"}</Text>
            </Text>
          </Box>
          <Text dimColor>
            {policy.preset === "custom"
              ? "Enter to continue — define the patterns next · b Back · Esc Cancel"
              : "Enter to continue · b Back · Esc Cancel"}
          </Text>
        </Box>
      );
    }
    case "branchAllowed":
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 2 — Global config · Allowed branch patterns</Text>
          <Text dimColor>Allowed branch patterns (comma-separated):</Text>
          <TextInput
            placeholder={SCREEN_PLACEHOLDERS.branchAllowed}
            defaultValue={draft.values.branchAllowed}
            onChange={(value) => dispatch({ type: "set", field: "branchAllowed", value })}
            onSubmit={() => dispatch({ type: "next" })}
          />
          {draft.errors.branchAllowed && <Text color="red">{draft.errors.branchAllowed}</Text>}
          <Text dimColor>Enter to continue · Esc Back</Text>
        </Box>
      );
    case "branchProtected":
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 2 — Global config · Protected branch names</Text>
          <Text dimColor>Protected branch names (comma-separated):</Text>
          <TextInput
            placeholder={SCREEN_PLACEHOLDERS.branchProtected}
            defaultValue={draft.values.branchProtected}
            onChange={(value) => dispatch({ type: "set", field: "branchProtected", value })}
            onSubmit={() => dispatch({ type: "next" })}
          />
          {draft.errors.branchProtected && <Text color="red">{draft.errors.branchProtected}</Text>}
          <Text dimColor>Enter to continue · Esc Back</Text>
        </Box>
      );
    case "issueTracker":
      // Task 5: plain three-option select (no search gate needed) sitting where
      // Step 3 lives today; YouTrack keeps the base-url screen, the others skip
      // it in both directions via the shared reducer gating.
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 3 — Issue tracker</Text>
          <Text dimColor>Where do issues live?</Text>
          <SelectList
            options={ISSUE_TRACKERS}
            value={draft.values.issueTracker}
            onChange={(value) => dispatch({ type: "set", field: "issueTracker", value })}
            onSelect={() => dispatch({ type: "next" })}
          />
          <Text dimColor>Enter to continue · b Back · Esc Cancel</Text>
        </Box>
      );
    case "youtrack":
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 3 — YouTrack</Text>
          <Text dimColor>Base URL (https):</Text>
          <TextInput
            placeholder={SCREEN_PLACEHOLDERS.youtrack}
            defaultValue={draft.values.baseUrl}
            onChange={(value) => dispatch({ type: "set", field: "baseUrl", value })}
            onSubmit={() => dispatch({ type: "next" })}
          />
          {draft.errors.baseUrl && <Text color="red">{draft.errors.baseUrl}</Text>}
          <Text dimColor>Enter to continue · Esc Back</Text>
        </Box>
      );
    case "vcs":
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 4 — Version control</Text>
          <Text dimColor>Provider:</Text>
          <SelectList
            options={VCS_PROVIDERS}
            value={draft.values.vcsProvider}
            onChange={(value) => dispatch({ type: "set", field: "vcsProvider", value })}
            onSelect={() => dispatch({ type: "next" })}
          />
          <Text dimColor>Enter to continue · b Back · Esc Cancel</Text>
        </Box>
      );
    case "basePath":
      return <BasePathScreen draft={draft} dispatch={dispatch} />;
    case "workspaces": {
      const base = resolveBasePath(draft.values);
      const options = [
        ...draft.values.workspaces.map((w, i) => ({
          label: `Edit ${w.name} (${w.glob})`,
          value: `edit:${i}`,
        })),
        ...draft.values.workspaces.map((w, i) => ({
          label: `Remove ${w.name}`,
          value: `remove:${i}`,
        })),
        { label: "Add workspace", value: "add" },
        { label: `Use current project (${base})`, value: "current" },
        { label: "Done", value: "done" },
        { label: "Advanced global commit policy", value: "global-commit" },
        ...draft.values.workspaces.map((w, i) => ({
          label: `Advanced settings for ${w.name}`,
          value: `advanced:${i}`,
        })),
      ];
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 5 — Workspaces</Text>
          {draft.values.workspaces.length === 0 ? (
            <Text dimColor>No workspaces configured yet.</Text>
          ) : (
            <Box flexDirection="column" gap={0}>
              {draft.values.workspaces.map((w) => {
                const matches = matchWorkspace(w.glob, base);
                return (
                  <Text key={`${w.name}|${w.glob}|${w.vcs?.provider ?? ""}`}>
                    {matches ? "✓ matches" : "✗ no match"} {w.name} — {w.vcs?.provider ?? "?"} —{" "}
                    {w.glob}
                  </Text>
                );
              })}
            </Box>
          )}
          <SelectList
            key={draft.values.workspaces.map((w) => `${w.name}:${w.glob}`).join("|")}
            options={options}
            value="done"
            onSelect={(value) => {
              if (value.startsWith("edit:"))
                dispatch({ type: "workspaceEdit", index: Number(value.slice(5)) });
              else if (value.startsWith("remove:"))
                dispatch({ type: "workspaceRemove", index: Number(value.slice(7)) });
              else if (value.startsWith("advanced:"))
                dispatch({ type: "workspaceAdvancedOpen", index: Number(value.slice(9)) });
              else if (value === "global-commit") dispatch({ type: "globalCommitOpen" });
              else if (value === "add") dispatch({ type: "workspaceAdd" });
              else if (value === "current") dispatch({ type: "workspaceAddCurrent", path: base });
              else dispatch({ type: "next" });
            }}
          />
          <Text dimColor>Enter to continue · b Back · Esc Cancel</Text>
        </Box>
      );
    }
    case "workspaceName":
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 5 — Workspaces · Name</Text>
          <Text dimColor>
            {draft.workspaceIndex === null
              ? "New workspace name:"
              : `Edit workspace name (${draft.values.workspaces[draft.workspaceIndex]?.name ?? ""}):`}
          </Text>
          <TextInput
            placeholder={SCREEN_PLACEHOLDERS.workspaceName}
            defaultValue={draft.workspaceDraft?.name ?? ""}
            onChange={(value) => dispatch({ type: "workspaceDraftName", value })}
            onSubmit={() => dispatch({ type: "next" })}
          />
          {draft.errors.workspaceName && <Text color="red">{draft.errors.workspaceName}</Text>}
          <Text dimColor>Enter to continue · Esc Back</Text>
        </Box>
      );
    case "workspaceGlob": {
      const glob = draft.workspaceDraft?.glob ?? "";
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 5 — Workspaces · Pattern</Text>
          <Text dimColor>Workspace pattern (glob, e.g. /work/**):</Text>
          <TextInput
            placeholder={SCREEN_PLACEHOLDERS.workspaceGlob}
            defaultValue={glob}
            onChange={(value) => dispatch({ type: "workspaceDraftGlob", value })}
            onSubmit={() => dispatch({ type: "next" })}
          />
          {glob.trim() !== "" && (
            <Box flexDirection="column" gap={0}>
              <Text bold>Match preview (shared matcher):</Text>
              {workspacePreviewTargets(resolveBasePath(draft.values)).map((target) => {
                const matches = matchWorkspace(glob, target);
                return (
                  <Text key={target} color={matches ? "green" : "red"}>
                    {matches ? "✓ matches" : "✗ no match"} {target}
                  </Text>
                );
              })}
            </Box>
          )}
          {draft.errors.workspaceGlob && <Text color="red">{draft.errors.workspaceGlob}</Text>}
          <Text dimColor>Enter to continue · Esc Back</Text>
        </Box>
      );
    }
    case "workspaceProvider":
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 5 — Workspaces · Provider</Text>
          <Text dimColor>Version control provider for this workspace:</Text>
          <SelectList
            options={VCS_PROVIDERS}
            value={draft.workspaceDraft?.vcs?.provider ?? "skip"}
            onChange={(value) => dispatch({ type: "workspaceDraftProvider", value })}
            onSelect={(value) => {
              dispatch({ type: "workspaceDraftProvider", value });
              dispatch({ type: "workspaceSave" });
            }}
          />
          <Text dimColor>Enter to save · b Back · Esc Cancel</Text>
        </Box>
      );
    case "workspaceAdvanced": {
      return <WorkspaceCollectionEditor draft={draft} dispatch={dispatch} />;
    }
    case "workspaceAdvancedValue": {
      const field = draft.workspaceEditorField;
      const current =
        draft.workspaceDraft && field ? workspaceEditorValue(draft.workspaceDraft, field) : "";
      const label =
        WORKSPACE_ADVANCED_FIELDS.find((entry) => entry.value === field)?.label ?? "Setting";
      const choices = field ? enumFieldOptions(field) : null;
      const profileChoices =
        field === "defaultProfile"
          ? [
              { label: "Inherit / no default profile", value: "" },
              ...Object.keys(draft.workspaceDraft?.profiles ?? {}).map((name) => ({
                label: name,
                value: name,
              })),
            ]
          : null;
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Advanced workspace settings · {label}</Text>
          <Text dimColor>
            Leave empty to clear this override. Use comma-separated values for lists.
          </Text>
          {profileChoices ? (
            <SelectList
              options={profileChoices}
              value={current}
              onSelect={(value) =>
                field && dispatch({ type: "workspaceAdvancedSet", field, value })
              }
            />
          ) : choices ? (
            <SelectList
              options={choices}
              value={current || choices[0].value}
              onSelect={(value) =>
                field && dispatch({ type: "workspaceAdvancedSet", field, value })
              }
            />
          ) : (
            <TextInput
              defaultValue={current}
              onSubmit={(value) =>
                field && dispatch({ type: "workspaceAdvancedSet", field, value })
              }
            />
          )}
          {field?.endsWith("integration") && <Text dimColor>Enter pr or merge.</Text>}
          <Text dimColor>Enter to save · Esc Back</Text>
        </Box>
      );
    }
    case "globalCommitPolicy": {
      const options = [
        { label: "Conventional commits", value: "conventional" },
        { label: "Gitmoji", value: "gitmoji" },
        { label: "Ticket prefix", value: "ticket-prefix" },
        { label: "Freeform", value: "freeform" },
        { label: "Custom pattern", value: "custom" },
        { label: "Auto-detect", value: "auto" },
        { label: "Edit custom pattern…", value: "pattern" },
        { label: "Done", value: "done" },
      ];
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Advanced global commit policy</Text>
          <Text dimColor>Default convention used when a workspace has no commit override.</Text>
          {draft.values.commitPolicy.pattern && (
            <Text dimColor>Custom pattern: {draft.values.commitPolicy.pattern}</Text>
          )}
          <SelectList
            options={options}
            value={draft.values.commitPolicy.preset}
            onSelect={(value) => {
              if (value === "pattern") dispatch({ type: "globalCommitEditPattern" });
              else if (value === "done") dispatch({ type: "back" });
              else dispatch({ type: "globalCommitPreset", value });
            }}
          />
          <Text dimColor>Enter to select · b Back</Text>
        </Box>
      );
    }
    case "globalCommitPattern":
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Advanced global commit policy · Custom pattern</Text>
          <Text dimColor>Regular expression matched against the commit subject line.</Text>
          <TextInput
            defaultValue={draft.values.commitPolicy.pattern ?? ""}
            onChange={(value) => dispatch({ type: "globalCommitPattern", value })}
            onSubmit={() => dispatch({ type: "globalCommitPatternDone" })}
          />
          <Text dimColor>Enter to save · Esc Back</Text>
        </Box>
      );
    case "branchPolicy":
      return <BranchPolicyScreen draft={draft} dispatch={dispatch} />;
    case "branchPolicyDevelop":
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 5 — Branch policy · Develop branch</Text>
          <Text dimColor>Integration/develop branch name (leave empty to unset):</Text>
          <TextInput
            placeholder={SCREEN_PLACEHOLDERS.branchPolicyDevelop}
            defaultValue={
              draft.values.branchPolicy?.developBranch ??
              draft.values.branchPolicyDetected?.developBranch ??
              ""
            }
            onSubmit={(value) => {
              dispatch({ type: "set", field: "branchPolicyDevelop", value });
              dispatch({ type: "next" });
            }}
          />
          <Text dimColor>Enter to save · Esc Back</Text>
        </Box>
      );
    case "project":
      // CA-07: print the exact directory Apply will touch — the resolved base
      // path, never an implicit process.cwd().
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 6 — Project setup</Text>
          <Text dimColor>
            Apply gitignore + hygiene in {resolveBasePath(draft.values)}? (Existing files are never
            overwritten.)
          </Text>
          <ConfirmInput
            defaultChoice="cancel"
            submitOnEnter={false}
            onConfirm={() => {
              dispatch({ type: "set", field: "applyProject", value: true });
              dispatch({ type: "next" });
            }}
            onCancel={() => {
              dispatch({ type: "set", field: "applyProject", value: false });
              dispatch({ type: "next" });
            }}
          />
          <Text dimColor>y to add project files · n to skip · b Back · Esc Cancel</Text>
        </Box>
      );
    case "summary": {
      const policy = effectivePolicy(draft.values);
      // WZ-08: the summary renders the authoritative preview (read-only) — the
      // exact mutations Apply would perform. Malformed setup state (WZ-06)
      // blocks Apply: no confirm control is mounted until it is fixed.
      // CA-07: the preview's hygiene target is the same displayed base path
      // runInit will pass to Apply.
      const preview = buildSetupPreview(draft.values, { cwd: resolveBasePath(draft.values) });
      const policyPreview = (() => {
        try {
          const current = readConfig();
          const config = {
            ...current,
            branchPolicy: mergePreset(
              draft.values.branchPreset,
              {
                allowed: parseList(draft.values.branchAllowed),
                protectedNames: parseList(draft.values.branchProtected),
              },
              current,
            ),
            commitPolicy: draft.values.commitPolicy,
          };
          const checkout = resolveBasePath(draft.values);
          const workspace = resolveWorkspaceFromEntries(checkout, draft.values.workspaces);
          const resolved = resolveWorkspacePolicy(config, workspace);
          if (resolved.status === "invalid") return { error: resolved.error };
          return {
            error: null,
            workspace: workspace?.name ?? null,
            branchSource: resolved.provenance.branchPolicy,
            commitSource: resolved.provenance.commitPolicy,
            target: resolved.branchPolicy.defaultTargetBranch,
            branchPreset: resolved.branchPolicy.preset,
            commitPreset: resolved.commitPolicy.preset,
          };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      })();
      const canApply = preview.ok && policyPreview.error === null;
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold color="cyan">
            Review
          </Text>
          <Text>
            Platforms: <Text color="green">{draft.values.platforms.join(", ") || "—"}</Text>
          </Text>
          <Text>
            Locale: <Text color="green">{draft.values.locale}</Text>
          </Text>
          <Text>
            Timezone: <Text color="green">{draft.values.timezone}</Text>
          </Text>
          <Text>
            Branch policy: <Text color="green">{policy.preset}</Text> — allowed:{" "}
            {policy.allowed.join(", ")} · protected: {policy.protected.join(", ")}
          </Text>
          {policyPreview.error === null ? (
            <Box flexDirection="column" gap={0}>
              <Text>
                Sample checkout: <Text color="green">{resolveBasePath(draft.values)}</Text>
                {policyPreview.workspace
                  ? ` · workspace ${policyPreview.workspace}`
                  : " · no matching workspace"}
              </Text>
              <Text>
                Effective branch policy: <Text color="green">{policyPreview.branchPreset}</Text> ·
                target {policyPreview.target} · source {policyPreview.branchSource}
              </Text>
              <Text>
                Effective commit policy: <Text color="green">{policyPreview.commitPreset}</Text> ·
                source {policyPreview.commitSource}
              </Text>
            </Box>
          ) : (
            <Text color="red">Policy preview failed: {policyPreview.error}</Text>
          )}
          <Text>
            YouTrack base URL:{" "}
            <Text color="green">
              {draft.values.issueTracker === "youtrack"
                ? draft.values.baseUrl.trim()
                  ? draft.values.baseUrl
                  : "— (skip)"
                : "—"}
            </Text>
          </Text>
          <Text>
            VCS provider: <Text color="green">{draft.values.vcsProvider}</Text>
          </Text>
          <Text>
            Project hygiene: <Text color="green">{draft.values.applyProject ? "yes" : "no"}</Text>
          </Text>
          {preview.overrides.length > 0 && (
            <Box flexDirection="column" gap={0}>
              <Text bold>Environment overrides (not applied by the wizard):</Text>
              {preview.overrides.map((o) => (
                <Text key={o.envKey} color="yellow">
                  {o.envKey} → {o.affects}: {o.value}
                </Text>
              ))}
            </Box>
          )}
          {canApply ? (
            <Box flexDirection="column" gap={0}>
              <Text bold>Will apply:</Text>
              {preview.mutations.map((m, index) => (
                <Text key={`${m.type}:${index}`}>{describeMutation(m)}</Text>
              ))}
              {preview.preserved.map((p) => (
                <Text key={p} color="green">
                  preserve {p} (existing token)
                </Text>
              ))}
            </Box>
          ) : (
            <Box flexDirection="column" gap={0}>
              <Text bold color="red">
                Apply blocked — malformed configuration:
              </Text>
              {preview.blocked.map((b) => (
                <Text key={b} color="red">
                  {b}
                </Text>
              ))}
              <Text dimColor>
                Fix or remove the blocked file above, then return here. Esc Cancel.
              </Text>
            </Box>
          )}
          {canApply && (
            <ConfirmInput
              defaultChoice="confirm"
              submitOnEnter={false}
              onConfirm={() => dispatch({ type: "apply" })}
              onCancel={() => {}}
            />
          )}
          <Text dimColor>
            {canApply ? "y to apply · b Back · Esc Cancel" : "b Back · Esc Cancel"}
          </Text>
        </Box>
      );
    }
    case "exit":
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>Exiting…</Text>
        </Box>
      );
  }
}
