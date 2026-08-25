import { Box, Text, useInput } from "ink";
import { ConfirmInput, MultiSelect, TextInput } from "@inkjs/ui";
import { useEffect, useReducer, useRef, useState, type Dispatch, type JSX } from "react";
import {
  mergePreset,
  type BranchPreset,
  type ToolkitConfig,
} from "@brainervirus/workit-core/src/core/config.ts";
import { buildSetupPreview, parseList, type SetupMutation } from "./logic";
import { matchWorkspace } from "@brainervirus/workit-core/src/core/workspaces.ts";
import { detectBranchPolicy } from "@brainervirus/workit-core/src/core/branch-policy.ts";
import {
  createInitialDraft,
  reducer,
  type SetupValues,
  type WizardAction,
  type WizardDraft,
  type WizardScreen,
} from "./wizard-state";
import { LOCALE_LANGUAGE_MAP, SearchSelect } from "./search-select";

const PLATFORMS = [
  { label: "OpenCode", value: "opencode" },
  { label: "Cursor", value: "cursor" },
];

const BRANCH_PRESETS: { label: string; value: BranchPreset }[] = [
  { label: "GitFlow", value: "gitflow" },
  { label: "GitHub Flow", value: "github-flow" },
  { label: "Trunk-based", value: "trunk-based" },
  { label: "Custom", value: "custom" },
];

const VCS_PROVIDERS = [
  { label: "GitLab", value: "gitlab" },
  { label: "GitHub", value: "github" },
  { label: "Skip — configure later", value: "skip" },
];

const ISSUE_TRACKERS: { label: string; value: SetupValues["issueTracker"] }[] = [
  { label: "YouTrack", value: "youtrack" },
  { label: "GitHub Issues", value: "github" },
  { label: "None", value: "none" },
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
  const rest = TIMEZONES.filter((timezone) => timezone !== DETECTED_TIMEZONE);
  return [
    { label: DETECTED_TIMEZONE, value: DETECTED_TIMEZONE },
    ...rest.map((timezone) => ({ label: timezone, value: timezone })),
    { label: "Other…", value: "other" },
  ];
}
// Text screens cannot offer the 'b' back key (it is a printable character the
// TextInput consumes), so there Esc walks back to the parent select screen and
// cancel happens from select/confirm screens. Draft state survives either way.
const TEXT_SCREENS: ReadonlySet<WizardScreen> = new Set([
  "localeOther",
  "timezoneOther",
  "branchAllowed",
  "branchProtected",
  "youtrack",
  "workspaceName",
  "workspaceGlob",
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

  useInput((_input, key) => {
    // WZ-13: compute the next index outside any setState updater — updater
    // functions are render-phase code React StrictMode double-invokes, so
    // dispatching from inside them fires onChange twice.
    if (key.downArrow) {
      const next = Math.min(index + 1, options.length - 1);
      setIndex(next);
      onChange?.(options[next].value);
    } else if (key.upArrow) {
      const next = Math.max(index - 1, 0);
      setIndex(next);
      onChange?.(options[next].value);
    } else if (key.return) {
      onSelect(options[index].value);
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
      value: detectBranchPolicy(process.env.WORKFLOW_WORKSPACE_ROOT ?? process.cwd()),
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
}: {
  onExit: (complete: boolean, values?: SetupValues) => void;
}): JSX.Element {
  const [draft, dispatch] = useReducer(reducer, undefined, createInitialDraft);
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
  }, [draft.screen, draft.cancelled, onExit]);

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
    case "set-token-path":
      return `+ change ${m.key} in ${m.path} → ${m.value}`;
  }
}

function Screen({ draft, dispatch, onSearchQueryChange }: ScreenProps): JSX.Element {
  switch (draft.screen) {
    case "platforms":
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 1 — Platforms</Text>
          <Text dimColor>Select the tools to configure (space to toggle):</Text>
          <MultiSelect
            options={PLATFORMS}
            defaultValue={draft.values.platforms}
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
            options={[
              ...LOCALE_LANGUAGE_MAP.map((entry) => ({ label: entry.label, value: entry.locale })),
              { label: "Other…", value: "other" },
            ]}
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
            value={DETECTED_TIMEZONE}
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
    case "workspaces": {
      const cwd = process.cwd();
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
        { label: `Use current project (${cwd})`, value: "current" },
        { label: "Done", value: "done" },
      ];
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 5 — Workspaces</Text>
          {draft.values.workspaces.length === 0 ? (
            <Text dimColor>No workspaces configured yet.</Text>
          ) : (
            <Box flexDirection="column" gap={0}>
              {draft.values.workspaces.map((w) => {
                const matches = matchWorkspace(w.glob, cwd);
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
              else if (value === "add") dispatch({ type: "workspaceAdd" });
              else if (value === "current") dispatch({ type: "workspaceAddCurrent", path: cwd });
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
            defaultValue={glob}
            onChange={(value) => dispatch({ type: "workspaceDraftGlob", value })}
            onSubmit={() => dispatch({ type: "next" })}
          />
          {glob.trim() !== "" && (
            <Box flexDirection="column" gap={0}>
              <Text bold>Match preview (shared matcher):</Text>
              {workspacePreviewTargets(process.cwd()).map((target) => {
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
            options={VCS_PROVIDERS.filter((option) => option.value !== "skip")}
            value={draft.workspaceDraft?.vcs?.provider ?? "gitlab"}
            onChange={(value) => dispatch({ type: "workspaceDraftProvider", value })}
            onSelect={(value) => {
              dispatch({ type: "workspaceDraftProvider", value });
              dispatch({ type: "workspaceSave" });
            }}
          />
          <Text dimColor>Enter to save · b Back · Esc Cancel</Text>
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
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Step 6 — Project setup</Text>
          <Text dimColor>
            Will apply gitignore + hygiene in {process.cwd()} (existing files are never
            overwritten):
          </Text>
          <ConfirmInput
            defaultChoice="confirm"
            submitOnEnter={false}
            onConfirm={() => {
              dispatch({ type: "set", field: "applyProject", value: true });
              dispatch({ type: "next" });
            }}
            onCancel={() => {}}
          />
          <Text dimColor>y to continue · n to stay · b Back · Esc Cancel</Text>
        </Box>
      );
    case "summary": {
      const policy = effectivePolicy(draft.values);
      // WZ-08: the summary renders the authoritative preview (read-only) — the
      // exact mutations Apply would perform. Malformed setup state (WZ-06)
      // blocks Apply: no confirm control is mounted until it is fixed.
      const preview = buildSetupPreview(draft.values);
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
          {preview.ok ? (
            <Box flexDirection="column" gap={0}>
              <Text bold>Will apply:</Text>
              {preview.mutations.map((m) => (
                <Text key={`${m.type}:${m.path}`}>{describeMutation(m)}</Text>
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
          {preview.ok && (
            <ConfirmInput
              defaultChoice="confirm"
              submitOnEnter={false}
              onConfirm={() => dispatch({ type: "apply" })}
              onCancel={() => {}}
            />
          )}
          <Text dimColor>
            {preview.ok ? "y to apply · b Back · Esc Cancel" : "b Back · Esc Cancel"}
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
