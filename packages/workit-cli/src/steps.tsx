import { inkColor } from "./steps/ink-style";
import { Box, Text, useInput } from "ink";
import { useEffect, useReducer, useRef, type JSX } from "react";
import { createInitialDraft, reducer, type SetupValues, type WizardScreen } from "./wizard-state";
import {
  emptyDetection,
  preselectedPlatforms,
  type HostDetection,
  type HostId,
} from "./admin/detect-hosts";
import { PLATFORM_LABELS } from "./steps/options";
import type { ScreenProps } from "./steps/screen-props";
import {
  BranchAllowedScreen,
  BranchPresetScreen,
  BranchProtectedScreen,
  IssueTrackerScreen,
  LocaleOtherScreen,
  LocaleScreen,
  PlatformsScreen,
  VcsScreen,
  YoutrackScreen,
} from "./steps/global-screens";
import {
  GlobalCommitPatternScreen,
  GlobalCommitPolicyScreen,
  WorkspaceAdvancedValueScreen,
  WorkspaceGlobScreen,
  WorkspaceNameScreen,
  WorkspaceProviderScreen,
  WorkspacesScreen,
} from "./steps/workspace-screens";
import {
  BasePathScreen,
  BranchPolicyDevelopScreen,
  BranchPolicyScreen,
  ExitScreen,
  ProjectScreen,
  SummaryScreen,
} from "./steps/finish-screens";
import { WorkspaceCollectionEditor } from "./steps/workspace-editor";

export { BRANCH_PRESET_DESCRIPTIONS, SCREEN_PLACEHOLDERS } from "./steps/options";
export { SelectList } from "./steps/select-list";

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

// Text screens cannot offer the 'b' back key (it is a printable character the
// TextInput consumes), so there Esc walks back to the parent select screen and
// cancel happens from select/confirm screens. Draft state survives either way.
const TEXT_SCREENS: ReadonlySet<WizardScreen> = new Set([
  "localeOther",
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
const SEARCH_SCREENS: ReadonlySet<WizardScreen> = new Set(["locale"]);

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
      // (locale), 'b' belongs to the query; only a typed-then-cleared
      // search navigates back. Other screens keep plain 'b' back-navigation.
      const search = searchRef.current;
      const searchOwnsB = SEARCH_SCREENS.has(draft.screen) && !(search.typed && search.q === "");
      if (!searchOwnsB) dispatch({ type: "back" });
    }
  });

  useEffect(() => {
    if (draft.screen === "exit" && !exitedRef.current) {
      exitedRef.current = true;
      // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent -- a one-shot exit event, not state sync: runInit's onExit unmounts the Ink instance, which must wait until the "Exiting…" frame commits; the parent cannot derive the answers itself.
      onExit(!draft.cancelled, draft.values);
    }
  }, [draft.screen, draft.cancelled, draft.values, onExit]);

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color={inkColor("accent")}>
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

const SCREENS: Record<WizardScreen, (props: ScreenProps) => JSX.Element> = {
  platforms: PlatformsScreen,
  locale: LocaleScreen,
  localeOther: LocaleOtherScreen,
  branchPreset: BranchPresetScreen,
  branchAllowed: BranchAllowedScreen,
  branchProtected: BranchProtectedScreen,
  issueTracker: IssueTrackerScreen,
  youtrack: YoutrackScreen,
  vcs: VcsScreen,
  basePath: BasePathScreen,
  workspaces: WorkspacesScreen,
  workspaceName: WorkspaceNameScreen,
  workspaceGlob: WorkspaceGlobScreen,
  workspaceProvider: WorkspaceProviderScreen,
  workspaceAdvanced: WorkspaceCollectionEditor,
  workspaceAdvancedValue: WorkspaceAdvancedValueScreen,
  globalCommitPolicy: GlobalCommitPolicyScreen,
  globalCommitPattern: GlobalCommitPatternScreen,
  branchPolicy: BranchPolicyScreen,
  branchPolicyDevelop: BranchPolicyDevelopScreen,
  project: ProjectScreen,
  summary: SummaryScreen,
  exit: ExitScreen,
};

function Screen(props: ScreenProps): JSX.Element {
  const Body = SCREENS[props.draft.screen];
  return <Body {...props} />;
}
