import {
  readConfig,
  type BranchPreset,
  type ToolkitConfig,
} from "@brainervirus/workit-core/src/core/config.ts";
import type { WorkspaceConfig } from "@brainervirus/workit-core/src/core/workspaces.ts";
import {
  DEFAULT_BASE_URL,
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
  vcsProvider: VcsProvider;
  workspaces: WorkspaceConfig[];
  applyProject: boolean;
};

export type WizardDraft = {
  screen: WizardScreen;
  values: SetupValues;
  errors: Record<string, string>;
  cancelled: boolean;
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

function validateScreen(
  screen: WizardScreen,
  values: SetupValues,
): { field: string; message: string } | null {
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
      const error = validateBaseUrl(values.baseUrl);
      return error ? { field: "baseUrl", message: error } : null;
    }
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
            : validateBaseUrl(value);
  const errors = { ...draft.errors };
  if (message) errors[field] = message;
  else delete errors[field];
  return { ...draft, values: { ...draft.values, [field]: value }, errors };
}

export function createInitialDraft(config: ToolkitConfig = readConfig()): WizardDraft {
  return {
    screen: "platforms",
    values: {
      platforms: [],
      locale: config.locale,
      timezone: config.timezone,
      branchPreset: config.branchPolicy.preset,
      branchAllowed: config.branchPolicy.allowed.join(", "),
      branchProtected: config.branchPolicy.protected.join(", "),
      baseUrl: DEFAULT_BASE_URL,
      vcsProvider: "gitlab",
      workspaces: [],
      applyProject: false,
    },
    errors: {},
    cancelled: false,
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
            values: { ...draft.values, vcsProvider: action.value as VcsProvider },
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
      const invalid = validateScreen(draft.screen, draft.values);
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
  }
}
