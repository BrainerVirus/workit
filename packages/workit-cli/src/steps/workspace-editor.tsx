import { inkColor, StableTextInput } from "./ink-style";
import { Box, Text } from "ink";
import { useState, type Dispatch, type JSX } from "react";
import type { WorkspaceConfig } from "@brainervirus/workit-core/src/core/workspaces.ts";
import {
  workspaceEditorValue,
  profileEditorValue,
  trackEditorValue,
  type ProfileEditorField,
  type TrackEditorField,
} from "../logic";
import type { WizardAction, WizardDraft } from "../wizard-state";
import { SelectList } from "./select-list";
import {
  enumFieldOptions,
  PROFILE_FIELDS,
  TRACK_FIELDS,
  WORKSPACE_ADVANCED_FIELDS,
} from "./options";

type Kind = "profile" | "track";
type StepKey = "changelog" | "docs";

/** The steps before a PR opens: one fixed choice each, default off (no key written). */
const STEPS: Record<StepKey, { label: string; choices: { label: string; value: string }[] }> = {
  changelog: {
    label: "Changelog step before a PR",
    choices: [
      { label: "Off (default)", value: "off" },
      { label: "Update an existing CHANGELOG.md", value: "update" },
      { label: "Create CHANGELOG.md when missing", value: "create" },
    ],
  },
  docs: {
    label: "Docs refresh before a PR",
    choices: [
      { label: "Off (default)", value: "off" },
      { label: "When user-facing behavior changed", value: "when-user-facing" },
    ],
  },
};

const stepValue = (workspace: WorkspaceConfig, key: StepKey): string =>
  STEPS[key].choices.some((choice) => choice.value === workspace[key])
    ? String(workspace[key])
    : "off";

// Each view is its own component, so a list control never carries its
// highlighted row into the next view: every list opens on its declared value.
type View =
  | { mode: "main" }
  | { mode: "step"; key: StepKey }
  | { mode: "menu"; kind: Kind }
  | { mode: "name"; kind: Kind }
  | { mode: "edit"; kind: Kind; name: string }
  | { mode: "value"; kind: Kind; name: string; field: string };

type Collection = {
  fields: { label: string; value: string }[];
  exists: (workspace: WorkspaceConfig, name: string) => boolean;
  /** The field's editor value, or undefined when the entry does not exist. */
  valueOf: (workspace: WorkspaceConfig, name: string, field: string) => string | undefined;
  createTitle: string;
  nameLabel: string;
  emptyError: string;
  duplicateError: (name: string) => string;
  editTitle: string;
  valueTitle: string;
  valueFooter: string;
  create: (name: string) => WizardAction;
  set: (name: string, field: string, value: string) => WizardAction;
};

const COLLECTIONS: Record<Kind, Collection> = {
  profile: {
    fields: PROFILE_FIELDS,
    exists: (workspace, name) => Boolean(workspace.profiles?.[name]),
    valueOf: (workspace, name, field) => {
      const profile = workspace.profiles?.[name];
      return profile ? profileEditorValue(profile, field as ProfileEditorField) : undefined;
    },
    createTitle: "Create profile",
    nameLabel: "Profile name:",
    emptyError: "Enter a profile name.",
    duplicateError: (name) =>
      `Profile ${name} already exists. Choose a different name or edit it from the list.`,
    editTitle: "Edit profile",
    valueTitle: "Profile",
    valueFooter: "Enter to save · Esc Back",
    create: (name) => ({ type: "workspaceProfileCreate", name }),
    set: (name, field, value) => ({
      type: "workspaceProfileSet",
      name,
      field: field as ProfileEditorField,
      value,
    }),
  },
  track: {
    fields: TRACK_FIELDS,
    exists: (workspace, name) => Boolean(workspace.releaseTracks?.[name]),
    valueOf: (workspace, name, field) => {
      const track = workspace.releaseTracks?.[name];
      return track ? trackEditorValue(track, field as TrackEditorField) : undefined;
    },
    createTitle: "Create release track",
    nameLabel: "Track name:",
    emptyError: "Enter a release-track name.",
    duplicateError: (name) =>
      `Release track ${name} already exists. Choose a different name or edit it from the list.`,
    editTitle: "Edit release track",
    valueTitle: "Release track",
    valueFooter: "Lists use comma-separated values · Enter to save · Esc Back",
    create: (name) => ({ type: "workspaceTrackCreate", name }),
    set: (name, field, value) => ({
      type: "workspaceTrackSet",
      name,
      field: field as TrackEditorField,
      value,
    }),
  },
};

const MAIN_OPTIONS = [
  ...WORKSPACE_ADVANCED_FIELDS,
  { label: STEPS.changelog.label, value: "step:changelog" as const },
  { label: STEPS.docs.label, value: "step:docs" as const },
  { label: "Manage profiles", value: "profiles" as const },
  { label: "Manage release tracks", value: "tracks" as const },
  { label: "Save workspace settings", value: "save" as const },
];

export function WorkspaceCollectionEditor({
  draft,
  dispatch,
}: {
  draft: WizardDraft;
  dispatch: Dispatch<WizardAction>;
}): JSX.Element {
  const [view, setView] = useState<View>({ mode: "main" });
  const workspace = draft.workspaceDraft;
  if (!workspace) return <Text color={inkColor("fail")}>Workspace draft is unavailable.</Text>;
  switch (view.mode) {
    case "main":
      return <MainMenu workspace={workspace} dispatch={dispatch} setView={setView} />;
    case "step":
      return (
        <StepValue
          stepKey={view.key}
          current={stepValue(workspace, view.key)}
          onSave={(value) => {
            dispatch({ type: "workspaceStepSet", key: view.key, value });
            setView({ mode: "main" });
          }}
        />
      );
    case "menu":
      return view.kind === "profile" ? (
        <ProfilesMenu workspace={workspace} dispatch={dispatch} setView={setView} />
      ) : (
        <TracksMenu workspace={workspace} dispatch={dispatch} setView={setView} />
      );
    case "name":
      return (
        <NameInput
          collection={COLLECTIONS[view.kind]}
          workspace={workspace}
          onCreate={(name) => {
            dispatch(COLLECTIONS[view.kind].create(name));
            setView({ mode: "edit", kind: view.kind, name });
          }}
        />
      );
    case "edit":
      return (
        <EntryFields
          collection={COLLECTIONS[view.kind]}
          workspace={workspace}
          name={view.name}
          onDone={() => setView({ mode: "menu", kind: view.kind })}
          onPick={(field) => setView({ ...view, mode: "value", field })}
        />
      );
    case "value":
      return (
        <EntryFieldValue
          collection={COLLECTIONS[view.kind]}
          workspace={workspace}
          name={view.name}
          field={view.field}
          onSave={(value) => {
            dispatch(COLLECTIONS[view.kind].set(view.name, view.field, value));
            setView({ mode: "edit", kind: view.kind, name: view.name });
          }}
        />
      );
  }
}

type MenuProps = {
  workspace: WorkspaceConfig;
  dispatch: Dispatch<WizardAction>;
  setView: (view: View) => void;
};

function MainMenu({ workspace, dispatch, setView }: MenuProps): JSX.Element {
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
      {(Object.keys(STEPS) as StepKey[]).map((key) => (
        <Text key={key} dimColor>
          {STEPS[key].label}: {stepValue(workspace, key)}
        </Text>
      ))}
      <SelectList
        options={MAIN_OPTIONS}
        value="save"
        onSelect={(value) => {
          if (value === "save") dispatch({ type: "workspaceSave" });
          else if (value === "profiles") setView({ mode: "menu", kind: "profile" });
          else if (value === "tracks") setView({ mode: "menu", kind: "track" });
          else if (value === "step:changelog") setView({ mode: "step", key: "changelog" });
          else if (value === "step:docs") setView({ mode: "step", key: "docs" });
          else dispatch({ type: "workspaceAdvancedSelect", field: value });
        }}
      />
    </Box>
  );
}

function StepValue({
  stepKey,
  current,
  onSave,
}: {
  stepKey: StepKey;
  current: string;
  onSave: (value: string) => void;
}): JSX.Element {
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{STEPS[stepKey].label}</Text>
      <SelectList options={STEPS[stepKey].choices} value={current} onSelect={onSave} />
      <Text dimColor>Enter to save · Esc Back</Text>
    </Box>
  );
}

function ProfilesMenu({ workspace, dispatch, setView }: MenuProps): JSX.Element {
  const options = [
    ...Object.keys(workspace.profiles ?? {}).flatMap((profile) => [
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
          const name = value.slice(value.indexOf(":") + 1);
          if (value === "create") setView({ mode: "name", kind: "profile" });
          else if (value.startsWith("edit:")) setView({ mode: "edit", kind: "profile", name });
          else if (value.startsWith("default:"))
            dispatch({ type: "workspaceProfileDefault", name });
          else if (value.startsWith("delete:")) dispatch({ type: "workspaceProfileDelete", name });
          else setView({ mode: "main" });
        }}
      />
    </Box>
  );
}

function TracksMenu({ workspace, dispatch, setView }: MenuProps): JSX.Element {
  const options = [
    ...Object.keys(workspace.releaseTracks ?? {}).flatMap((track) => [
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
          const name = value.slice(value.indexOf(":") + 1);
          if (value === "create") setView({ mode: "name", kind: "track" });
          else if (value.startsWith("edit:")) setView({ mode: "edit", kind: "track", name });
          else if (value.startsWith("delete:")) dispatch({ type: "workspaceTrackDelete", name });
          else setView({ mode: "main" });
        }}
      />
    </Box>
  );
}

function NameInput({
  collection,
  workspace,
  onCreate,
}: {
  collection: Collection;
  workspace: WorkspaceConfig;
  onCreate: (name: string) => void;
}): JSX.Element {
  const [error, setError] = useState("");
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{collection.createTitle}</Text>
      <Text dimColor>{collection.nameLabel}</Text>
      <StableTextInput
        onSubmit={(value) => {
          const next = value.trim();
          if (!next) setError(collection.emptyError);
          else if (collection.exists(workspace, next)) setError(collection.duplicateError(next));
          else onCreate(next);
        }}
      />
      {error && <Text color={inkColor("fail")}>{error}</Text>}
      <Text dimColor>Enter to create · Esc Back</Text>
    </Box>
  );
}

function EntryFields({
  collection,
  workspace,
  name,
  onDone,
  onPick,
}: {
  collection: Collection;
  workspace: WorkspaceConfig;
  name: string;
  onDone: () => void;
  onPick: (field: string) => void;
}): JSX.Element {
  const options = [...collection.fields, { label: "Done editing", value: "done" }];
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>
        {collection.editTitle} · {name}
      </Text>
      {collection.fields.map((item) => {
        const value = collection.valueOf(workspace, name, item.value);
        return (
          <Text key={item.value} dimColor>
            {item.label}: {value === undefined ? "" : value || "unset"}
          </Text>
        );
      })}
      <SelectList
        options={options}
        value="done"
        onSelect={(value) => (value === "done" ? onDone() : onPick(value))}
      />
    </Box>
  );
}

function EntryFieldValue({
  collection,
  workspace,
  name,
  field,
  onSave,
}: {
  collection: Collection;
  workspace: WorkspaceConfig;
  name: string;
  field: string;
  onSave: (value: string) => void;
}): JSX.Element {
  const item = collection.fields.find((entry) => entry.value === field);
  const choices = enumFieldOptions(field);
  const current = collection.valueOf(workspace, name, field);
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>
        {collection.valueTitle} {name} · {item?.label}
      </Text>
      {choices ? (
        <SelectList options={choices} value={current ?? choices[0].value} onSelect={onSave} />
      ) : (
        <StableTextInput defaultValue={current ?? ""} onSubmit={onSave} />
      )}
      <Text dimColor>{collection.valueFooter}</Text>
    </Box>
  );
}
