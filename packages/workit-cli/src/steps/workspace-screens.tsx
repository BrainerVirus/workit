import { Box, Text } from "ink";
import { TextInput } from "@inkjs/ui";
import type { JSX } from "react";
import { matchWorkspace } from "@brainervirus/workit-core/src/core/workspaces.ts";
import { workspaceEditorValue } from "../logic";
import { resolveBasePath } from "../wizard-state";
import { SelectList } from "./select-list";
import type { ScreenProps } from "./screen-props";
import {
  enumFieldOptions,
  SCREEN_PLACEHOLDERS,
  VCS_PROVIDERS,
  WORKSPACE_ADVANCED_FIELDS,
} from "./options";

// Deterministic match-preview samples derived from the current project path:
// the project itself, its parent, and a synthetic child repo. Every accepted
// pattern gets a visible ✓/✗ verdict per sample via the shared core matcher.
function workspacePreviewTargets(cwd: string): string[] {
  const norm = cwd.replace(/[\\/]+$/, "");
  const idx = norm.lastIndexOf("/");
  const parent = idx > 0 ? norm.slice(0, idx) : norm;
  return [norm, parent, `${norm}/child-repo`];
}

export function WorkspacesScreen({ draft, dispatch }: ScreenProps): JSX.Element {
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

export function WorkspaceNameScreen({ draft, dispatch }: ScreenProps): JSX.Element {
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
}

export function WorkspaceGlobScreen({ draft, dispatch }: ScreenProps): JSX.Element {
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

export function WorkspaceProviderScreen({ draft, dispatch }: ScreenProps): JSX.Element {
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
}

export function WorkspaceAdvancedValueScreen({ draft, dispatch }: ScreenProps): JSX.Element {
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
          onSelect={(value) => field && dispatch({ type: "workspaceAdvancedSet", field, value })}
        />
      ) : choices ? (
        <SelectList
          options={choices}
          value={current || choices[0].value}
          onSelect={(value) => field && dispatch({ type: "workspaceAdvancedSet", field, value })}
        />
      ) : (
        <TextInput
          defaultValue={current}
          onSubmit={(value) => field && dispatch({ type: "workspaceAdvancedSet", field, value })}
        />
      )}
      {field?.endsWith("integration") && <Text dimColor>Enter pr or merge.</Text>}
      <Text dimColor>Enter to save · Esc Back</Text>
    </Box>
  );
}

export function GlobalCommitPolicyScreen({ draft, dispatch }: ScreenProps): JSX.Element {
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

export function GlobalCommitPatternScreen({ draft, dispatch }: ScreenProps): JSX.Element {
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
}
