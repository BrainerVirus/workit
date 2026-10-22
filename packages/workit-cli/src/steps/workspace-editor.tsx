import { Box, Text } from "ink";
import { TextInput } from "@inkjs/ui";
import { useState, type Dispatch, type JSX } from "react";
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

export function WorkspaceCollectionEditor({
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
