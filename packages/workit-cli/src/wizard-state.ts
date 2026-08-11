import {
  mergePreset,
  readConfig,
  type BranchPreset,
  type ToolkitConfig,
} from "@brainervirus/workit-core/src/core/config.ts";
import type { WorkspaceConfig } from "@brainervirus/workit-core/src/core/workspaces.ts";
import {
  loadWorkspaces,
  parseList,
  validateBaseUrl,
  validateLocale,
  validateTimezone,
  type VcsProvider,
} from "./logic";

// Sequential in-memory wizard state machine (WZ-01-WZ-03, WZ-07, WZ-11). All
// draft transitions live here as pure reducer transitions; the screens render
// exactly one Ink control for the active screen and dispatch. Filesystem
// application is deliberately absent: nothing is written before Apply, and
// Apply itself only produces a draft for later application (Tasks 13-14).

export type WizardScreen =
  | "platforms"
  | "locale"
  | "localeOther"
  | "timezone"
  | "timezoneOther"
  | "branchPreset"
  | "branchAllowed"
  | "branchProtected"
  | "youtrack"
  | "vcs"
  | "workspaces"
  | "workspaceName"
  | "workspaceGlob"
  | "workspaceProvider"
  | "project"
  | "summary"
  | "exit";

export type SetupValues = {
  platforms: string[];
  locale: string;
  timezone: string;
  branchPreset: BranchPreset;
  branchAllowed: string;
  branchProtected: string;
  baseUrl: string;
  vcsProvider: VcsProvider | "skip";
  workspaces: WorkspaceConfig[];
  applyProject: boolean;
};

export type WizardDraft = {
  screen: WizardScreen;
  values: SetupValues;
  errors: Record<string, string>;
  cancelled: boolean;
  /** Workspace entry being added/edited; null when the add/edit flow is idle. */
  workspaceDraft: WorkspaceConfig | null;
  /** Index of the entry being edited; null when adding a new entry. */
  workspaceIndex: number | null;
};

export type WizardAction =
  | { type: "set"; field: "platforms"; value: string[] }
  | { type: "set"; field: "branchPreset"; value: string }
  | { type: "set"; field: "vcsProvider"; value: string }
  | { type: "set"; field: "applyProject"; value: boolean }
  | {
      type: "set";
      field: "locale" | "timezone" | "branchAllowed" | "branchProtected" | "baseUrl";
      value: string;
    }
  | { type: "pickOther" }
  | { type: "workspaceAdd" }
  | { type: "workspaceAddCurrent"; path: string }
  | { type: "workspaceEdit"; index: number }
  | { type: "workspaceRemove"; index: number }
  | { type: "workspaceDraftName"; value: string }
  | { type: "workspaceDraftGlob"; value: string }
  | { type: "workspaceDraftProvider"; value: string }
  | { type: "workspaceSave" }
  | { type: "next" }
  | { type: "back" }
  | { type: "cancel" }
  | { type: "apply" };

const NEXT: Record<WizardScreen, WizardScreen | null> = {
  platforms: "locale",
  locale: "timezone",
  localeOther: "timezone",
  timezone: "branchPreset",
  timezoneOther: "branchPreset",
  branchPreset: "branchAllowed",
  branchAllowed: "branchProtected",
  branchProtected: "youtrack",
  youtrack: "vcs",
  vcs: "workspaces",
  workspaces: "project",
  workspaceName: "workspaceGlob",
  workspaceGlob: "workspaceProvider",
  workspaceProvider: null,
  project: "summary",
  summary: null,
  exit: null,
};

const PREV: Record<WizardScreen, WizardScreen | null> = {
  platforms: null,
  locale: "platforms",
  localeOther: "locale",
  timezone: "locale",
  timezoneOther: "timezone",
  branchPreset: "timezone",
  branchAllowed: "branchPreset",
  branchProtected: "branchAllowed",
  youtrack: "branchProtected",
  vcs: "youtrack",
  workspaces: "vcs",
  workspaceName: "workspaces",
  workspaceGlob: "workspaceName",
  workspaceProvider: "workspaceGlob",
  project: "workspaces",
  summary: "project",
  exit: null,
};

const skipsCustomBranch = (screen: WizardScreen, preset: BranchPreset): boolean =>
  (screen === "branchAllowed" || screen === "branchProtected") && preset !== "custom";

function nextScreen(screen: WizardScreen, preset: BranchPreset): WizardScreen {
  let next = NEXT[screen];
  while (next && skipsCustomBranch(next, preset)) next = NEXT[next];
  return next ?? screen;
}

function prevScreen(screen: WizardScreen, preset: BranchPreset): WizardScreen {
  let prev = PREV[screen];
  while (prev && skipsCustomBranch(prev, preset)) prev = PREV[prev];
  return prev ?? screen;
}

function validateScreen(draft: WizardDraft): { field: string; message: string } | null {
  const { screen, values } = draft;
  switch (screen) {
    case "platforms":
      return values.platforms.length > 0
        ? null
        : { field: "platforms", message: "Select at least one platform to continue." };
    case "localeOther": {
      const error = validateLocale(values.locale);
      return error ? { field: "locale", message: error } : null;
    }
    case "timezoneOther": {
      const error = validateTimezone(values.timezone);
      return error ? { field: "timezone", message: error } : null;
    }
    case "branchAllowed":
      return parseList(values.branchAllowed).length > 0
        ? null
        : { field: "branchAllowed", message: "at least one allowed branch pattern is required" };
    case "branchProtected":
      return parseList(values.branchProtected).length > 0
        ? null
        : { field: "branchProtected", message: "at least one protected branch name is required" };
    case "youtrack": {
      // WZ-04: YouTrack is optional — an empty base URL means "skip this
      // integration" and produces no youtrack mutations in the preview.
      if (values.baseUrl.trim() === "") return null;
      const error = validateBaseUrl(values.baseUrl);
      return error ? { field: "baseUrl", message: error } : null;
    }
    case "workspaceName":
      return (draft.workspaceDraft?.name ?? "").trim()
        ? null
        : { field: "workspaceName", message: "workspace name is required" };
    case "workspaceGlob":
      return (draft.workspaceDraft?.glob ?? "").trim()
        ? null
        : { field: "workspaceGlob", message: "workspace pattern is required" };
    default:
      return null;
  }
}

function setTextValue(
  draft: WizardDraft,
  field: "locale" | "timezone" | "branchAllowed" | "branchProtected" | "baseUrl",
  value: string,
): WizardDraft {
  const message =
    field === "locale"
      ? validateLocale(value)
      : field === "timezone"
        ? validateTimezone(value)
        : field === "branchAllowed"
          ? parseList(value).length > 0
            ? null
            : "at least one allowed branch pattern is required"
          : field === "branchProtected"
            ? parseList(value).length > 0
              ? null
              : "at least one protected branch name is required"
            : value.trim() === ""
              ? null
              : validateBaseUrl(value);
  const errors = { ...draft.errors };
  if (message) errors[field] = message;
  else delete errors[field];
  return { ...draft, values: { ...draft.values, [field]: value }, errors };
}

export function createInitialDraft(config: ToolkitConfig = readConfig()): WizardDraft {
  // RL-02/CA-23: the draft's allowed/protected values always derive from the
  // preset (one shared merge), never from divergent persisted values.
  const policy = mergePreset(config.branchPolicy.preset, {}, config);
  return {
    screen: "platforms",
    values: {
      platforms: [],
      locale: config.locale,
      timezone: config.timezone,
      branchPreset: config.branchPolicy.preset,
      branchAllowed: policy.allowed.join(", "),
      branchProtected: policy.protected.join(", "),
      // WZ-04/CA-14: no organization-specific default base URL — empty means
      // the YouTrack integration is not selected.
      baseUrl: "",
      vcsProvider: "gitlab",
      workspaces: loadWorkspaces(),
      applyProject: false,
    },
    errors: {},
    cancelled: false,
    workspaceDraft: null,
    workspaceIndex: null,
  };
}

export function reducer(draft: WizardDraft, action: WizardAction): WizardDraft {
  switch (action.type) {
    case "set":
      switch (action.field) {
        case "platforms":
          return { ...draft, values: { ...draft.values, platforms: action.value } };
        case "branchPreset":
          return {
            ...draft,
            values: { ...draft.values, branchPreset: action.value as BranchPreset },
          };
        case "vcsProvider":
          return {
            ...draft,
            values: { ...draft.values, vcsProvider: action.value as VcsProvider | "skip" },
          };
        case "applyProject":
          return { ...draft, values: { ...draft.values, applyProject: action.value } };
        default:
          return setTextValue(draft, action.field, action.value);
      }
    case "pickOther":
      if (draft.screen === "locale") return { ...draft, screen: "localeOther" };
      if (draft.screen === "timezone") return { ...draft, screen: "timezoneOther" };
      return draft;
    case "next": {
      const invalid = validateScreen(draft);
      if (invalid)
        return { ...draft, errors: { ...draft.errors, [invalid.field]: invalid.message } };
      return { ...draft, screen: nextScreen(draft.screen, draft.values.branchPreset) };
    }
    case "back":
      return { ...draft, screen: prevScreen(draft.screen, draft.values.branchPreset) };
    case "cancel":
      return { ...draft, screen: "exit", cancelled: true };
    case "apply":
      return draft.screen === "summary" ? { ...draft, screen: "exit", cancelled: false } : draft;
    case "workspaceAdd":
      return {
        ...draft,
        screen: "workspaceName",
        workspaceIndex: null,
        workspaceDraft: {
          name: "",
          glob: "",
          vcs: { provider: defaultWorkspaceProvider(draft.values.vcsProvider) },
        },
        errors: {},
      };
    case "workspaceAddCurrent": {
      // WZ-12 current-project setup: derive a pattern covering the working
      // directory and a name from its last path segment.
      const p = action.path.replace(/[\\/]+$/, "");
      const name = p.slice(p.lastIndexOf("/") + 1) || p;
      return {
        ...draft,
        screen: "workspaces",
        workspaceDraft: null,
        workspaceIndex: null,
        values: {
          ...draft.values,
          workspaces: [
            ...draft.values.workspaces,
            {
              name,
              glob: `${p}/**`,
              vcs: { provider: defaultWorkspaceProvider(draft.values.vcsProvider) },
            },
          ],
        },
      };
    }
    case "workspaceEdit": {
      const entry = draft.values.workspaces[action.index];
      if (!entry) return draft;
      return {
        ...draft,
        screen: "workspaceName",
        workspaceIndex: action.index,
        workspaceDraft: entry.vcs ? { ...entry, vcs: { ...entry.vcs } } : { ...entry },
        errors: {},
      };
    }
    case "workspaceRemove":
      return {
        ...draft,
        screen: "workspaces",
        workspaceDraft: null,
        workspaceIndex: null,
        values: {
          ...draft.values,
          workspaces: draft.values.workspaces.filter((_, i) => i !== action.index),
        },
      };
    case "workspaceDraftName":
      return workspaceDraftText(draft, "name", action.value);
    case "workspaceDraftGlob":
      return workspaceDraftText(draft, "glob", action.value);
    case "workspaceDraftProvider": {
      const base = draft.workspaceDraft ?? { name: "", glob: "" };
      const vcs = draft.workspaceDraft?.vcs;
      return {
        ...draft,
        workspaceDraft: {
          ...base,
          vcs: {
            ...(vcs ?? { provider: "gitlab" as VcsProvider }),
            provider: action.value as VcsProvider,
          },
        },
      };
    }
    case "workspaceSave": {
      const wd = draft.workspaceDraft;
      if (!wd || !wd.name.trim() || !wd.glob.trim()) return draft;
      const entry: WorkspaceConfig = wd.vcs
        ? { ...wd, vcs: { ...wd.vcs } }
        : { ...wd, vcs: undefined };
      const workspaces =
        draft.workspaceIndex === null
          ? [...draft.values.workspaces, entry]
          : draft.values.workspaces.map((w, i) => (i === draft.workspaceIndex ? entry : w));
      return {
        ...draft,
        screen: "workspaces",
        workspaceDraft: null,
        workspaceIndex: null,
        values: { ...draft.values, workspaces },
        errors: {},
      };
    }
  }
}

/** A workspace's provider defaults from the wizard's VCS selection (gitlab when skipped). */
function defaultWorkspaceProvider(vcs: SetupValues["vcsProvider"]): VcsProvider {
  return vcs === "gitlab" || vcs === "github" ? vcs : "gitlab";
}

/** Live-update the in-progress workspace name/glob with per-field validation. */
function workspaceDraftText(
  draft: WizardDraft,
  field: "name" | "glob",
  value: string,
): WizardDraft {
  const errorKey = field === "name" ? "workspaceName" : "workspaceGlob";
  const message =
    field === "name"
      ? value.trim()
        ? null
        : "workspace name is required"
      : value.trim()
        ? null
        : "workspace pattern is required";
  const errors = { ...draft.errors };
  if (message) errors[errorKey] = message;
  else delete errors[errorKey];
  return {
    ...draft,
    errors,
    workspaceDraft: {
      ...(draft.workspaceDraft ?? { name: "", glob: "" }),
      [field]: value,
    },
  };
}
