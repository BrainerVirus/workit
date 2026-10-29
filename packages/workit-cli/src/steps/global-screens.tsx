import { inkColor, StableTextInput } from "./ink-style";
import { Box, Text } from "ink";
import type { JSX } from "react";
import { emptyDetection } from "../admin/detect-hosts";
import { SearchSelect } from "../search-select";
import { HostPicker } from "./host-picker";
import { SelectList } from "./select-list";
import type { ScreenProps } from "./screen-props";
import {
  BRANCH_PRESETS,
  BRANCH_PRESET_DESCRIPTIONS,
  effectivePolicy,
  ISSUE_TRACKERS,
  LOCALE_PICKER_OPTIONS,
  SCREEN_PLACEHOLDERS,
  VCS_PROVIDERS,
} from "./options";

export function PlatformsScreen({
  draft,
  dispatch,
  detection = emptyDetection(),
}: ScreenProps): JSX.Element {
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
      {draft.errors.platforms && <Text color={inkColor("fail")}>{draft.errors.platforms}</Text>}
      <Text dimColor>Enter to continue · Esc Cancel</Text>
    </Box>
  );
}

export function LocaleScreen({ draft, dispatch, onSearchQueryChange }: ScreenProps): JSX.Element {
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Step 2 — Global config · Locale</Text>
      <Text dimColor>Locale (BCP-47):</Text>
      <Text>
        Current: <Text color={inkColor("ok")}>{draft.values.locale}</Text>
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
      {draft.errors.locale && <Text color={inkColor("fail")}>{draft.errors.locale}</Text>}
      <Text dimColor>Type to filter · Enter to continue · b Back · Esc Cancel</Text>
    </Box>
  );
}

export function LocaleOtherScreen({ draft, dispatch }: ScreenProps): JSX.Element {
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Step 2 — Global config · Locale (custom)</Text>
      <Text dimColor>Type a BCP-47 locale (e.g. en or es-CL):</Text>
      <StableTextInput
        placeholder={SCREEN_PLACEHOLDERS.localeOther}
        onChange={(value) => dispatch({ type: "set", field: "locale", value })}
        onSubmit={() => dispatch({ type: "next" })}
      />
      {draft.errors.locale && <Text color={inkColor("fail")}>{draft.errors.locale}</Text>}
      <Text dimColor>Enter to continue · Esc Back</Text>
    </Box>
  );
}

export function BranchPresetScreen({ draft, dispatch }: ScreenProps): JSX.Element {
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
          Allowed: <Text color={inkColor("ok")}>{policy.allowed.join(", ") || "—"}</Text>
        </Text>
        <Text>
          Protected: <Text color={inkColor("ok")}>{policy.protected.join(", ") || "—"}</Text>
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

export function BranchAllowedScreen({ draft, dispatch }: ScreenProps): JSX.Element {
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Step 2 — Global config · Allowed branch patterns</Text>
      <Text dimColor>Allowed branch patterns (comma-separated):</Text>
      <StableTextInput
        placeholder={SCREEN_PLACEHOLDERS.branchAllowed}
        defaultValue={draft.values.branchAllowed}
        onChange={(value) => dispatch({ type: "set", field: "branchAllowed", value })}
        onSubmit={() => dispatch({ type: "next" })}
      />
      {draft.errors.branchAllowed && (
        <Text color={inkColor("fail")}>{draft.errors.branchAllowed}</Text>
      )}
      <Text dimColor>Enter to continue · Esc Back</Text>
    </Box>
  );
}

export function BranchProtectedScreen({ draft, dispatch }: ScreenProps): JSX.Element {
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Step 2 — Global config · Protected branch names</Text>
      <Text dimColor>Protected branch names (comma-separated):</Text>
      <StableTextInput
        placeholder={SCREEN_PLACEHOLDERS.branchProtected}
        defaultValue={draft.values.branchProtected}
        onChange={(value) => dispatch({ type: "set", field: "branchProtected", value })}
        onSubmit={() => dispatch({ type: "next" })}
      />
      {draft.errors.branchProtected && (
        <Text color={inkColor("fail")}>{draft.errors.branchProtected}</Text>
      )}
      <Text dimColor>Enter to continue · Esc Back</Text>
    </Box>
  );
}

export function IssueTrackerScreen({ draft, dispatch }: ScreenProps): JSX.Element {
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
}

export function YoutrackScreen({ draft, dispatch }: ScreenProps): JSX.Element {
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Step 3 — YouTrack</Text>
      <Text dimColor>Base URL (https):</Text>
      <StableTextInput
        placeholder={SCREEN_PLACEHOLDERS.youtrack}
        defaultValue={draft.values.baseUrl}
        onChange={(value) => dispatch({ type: "set", field: "baseUrl", value })}
        onSubmit={() => dispatch({ type: "next" })}
      />
      {draft.errors.baseUrl && <Text color={inkColor("fail")}>{draft.errors.baseUrl}</Text>}
      <Text dimColor>Enter to continue · Esc Back</Text>
    </Box>
  );
}

export function VcsScreen({ draft, dispatch }: ScreenProps): JSX.Element {
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
}
