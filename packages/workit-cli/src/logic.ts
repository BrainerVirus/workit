import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import {
  LOCALE_RE,
  configDir,
  mergeConfigValues,
  type BranchPreset,
  type ToolkitConfig,
} from "@brainervirus/workit-core/src/core/config.ts";
import {
  loadWorkspacesFrom,
  readWorkspacesResult,
  validateWorkspacesDocument,
  workspacesPath,
  type WorkspaceConfig,
  type WorkspaceProfile,
  type ReleaseTrack,
} from "@brainervirus/workit-core/src/core/workspaces.ts";
import { ensureProjectGitignore } from "@brainervirus/workit-core/src/core/gitignore.ts";
import { ensureHygieneFiles, hygieneFiles } from "@brainervirus/workit-core/src/core/hygiene.ts";
import type { VcsProvider } from "./admin/setup";
import { applyWorkspaceBranchPolicy } from "@brainervirus/workit-core/src/core/workspace-branch-policy.ts";
import type { WorkspaceBranchPolicy } from "@brainervirus/workit-core/src/core/workspaces.ts";

export function validateLocale(locale: string): string | null {
  if (!LOCALE_RE.test(locale)) {
    return `invalid locale "${locale}" — expected BCP-47 like en or es-CL`;
  }
  return null;
}

export function validateBaseUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return `invalid URL "${url}"`;
  }
  if (parsed.protocol !== "https:") return "base URL must use https";
  return null;
}

export type ConfigInput = {
  locale?: string;
  preset?: BranchPreset;
  allowed?: string[];
  protectedNames?: string[];
};

export function collectConfigValues(input: ConfigInput, current: ToolkitConfig): ToolkitConfig {
  return mergeConfigValues(input, current);
}

/**
 * Apply one friendly-form field to a workspace while retaining unrelated
 * legacy/custom keys. Form field IDs are deliberately closed and never accept
 * arbitrary property paths from terminal input.
 */
export type WorkspaceEditorField =
  | "vcs.defaultTargetBranch"
  | "vcs.account"
  | "youtrack.baseUrl"
  | "youtrack.link_issues"
  | "issues.link_on_pr"
  | "branchPolicy.developBranch"
  | "branchPolicy.preset"
  | "branchPolicy.allowed"
  | "branchPolicy.protected"
  | "branchPolicy.prefixes.feature"
  | "branchPolicy.prefixes.bugfix"
  | "branchPolicy.prefixes.release"
  | "branchPolicy.prefixes.hotfix"
  | "branchPolicy.integration"
  | "commitPolicy.preset"
  | "commitPolicy.pattern"
  | "defaultProfile";

export function workspaceEditorValue(
  workspace: WorkspaceConfig,
  field: WorkspaceEditorField,
): string {
  const [section, key, leaf] = field.split(".");
  if (section === "defaultProfile") return workspace.defaultProfile ?? "";
  if (section === "vcs") {
    if (key === "account") return workspace.vcs?.account ?? "";
    return workspace.vcs?.defaultTargetBranch ?? "";
  }
  if (section === "youtrack")
    return key === "baseUrl"
      ? (workspace.youtrack?.baseUrl ?? "")
      : workspace.youtrack?.link_issues === undefined
        ? "inherit"
        : String(workspace.youtrack.link_issues);
  if (section === "issues")
    return workspace.issues?.link_on_pr === undefined
      ? "inherit"
      : String(workspace.issues.link_on_pr);
  if (section === "branchPolicy") {
    const value = workspace.branchPolicy;
    if (key === "preset") return value?.preset ?? "inherit";
    if (key === "allowed") return value?.allowed?.join(", ") ?? "";
    if (key === "protected") return value?.protected?.join(", ") ?? "";
    if (key === "developBranch") return value?.developBranch ?? "";
    if (key === "integration") return value?.integration ?? "merge";
    if (key === "prefixes")
      return value?.prefixes?.[leaf as "feature" | "bugfix" | "release" | "hotfix"] ?? "";
  }
  if (section === "commitPolicy") {
    if (key === "preset") return workspace.commitPolicy?.preset ?? "inherit";
    if (key === "pattern") return workspace.commitPolicy?.pattern ?? "";
  }
  return "";
}

export function setWorkspaceEditorValue(
  workspace: WorkspaceConfig,
  field: WorkspaceEditorField,
  value: string,
  defaults: {
    branchPreset?: BranchPreset;
    commitPreset?: ToolkitConfig["commitPolicy"]["preset"];
  } = {},
): WorkspaceConfig {
  const [section, key, leaf] = field.split(".");
  const list = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (section === "defaultProfile")
    return { ...workspace, defaultProfile: value.trim() || undefined };
  if (section === "vcs")
    return workspace.vcs
      ? {
          ...workspace,
          vcs: { ...workspace.vcs, [key]: value.trim() || undefined },
        }
      : workspace;
  if (section === "youtrack") {
    const current = workspace.youtrack ?? {};
    if (key === "baseUrl")
      return {
        ...workspace,
        youtrack: { ...current, baseUrl: value.trim() || undefined },
      };
    if (!value || value === "inherit") {
      const { link_issues: _discard, ...rest } = current;
      return {
        ...workspace,
        youtrack: Object.keys(rest).length ? rest : undefined,
      };
    }
    return {
      ...workspace,
      youtrack: { ...current, link_issues: value === "true" },
    };
  }
  if (section === "issues") {
    const current = workspace.issues ?? { provider: "github" as const };
    if (!value || value === "inherit") {
      const { link_on_pr: _discard, ...rest } = current;
      return {
        ...workspace,
        issues: Object.keys(rest).length ? rest : undefined,
      };
    }
    return {
      ...workspace,
      issues: { ...current, provider: "github", link_on_pr: value === "true" },
    };
  }
  if (section === "branchPolicy") {
    if (key === "preset" && (!value.trim() || value === "inherit")) {
      const { branchPolicy: _discard, ...rest } = workspace;
      return rest;
    }
    const current = workspace.branchPolicy ?? {
      preset: defaults.branchPreset ?? "gitflow",
    };
    const branchPolicy =
      key === "preset"
        ? { ...current, preset: (value || "gitflow") as typeof current.preset }
        : key === "allowed"
          ? { ...current, allowed: list }
          : key === "protected"
            ? { ...current, protected: list }
            : key === "developBranch"
              ? { ...current, developBranch: value.trim() || undefined }
              : key === "integration"
                ? {
                    ...current,
                    integration: value === "pr" ? ("pr" as const) : ("merge" as const),
                  }
                : key === "prefixes"
                  ? {
                      ...current,
                      prefixes: {
                        feature: "feature/",
                        bugfix: "bugfix/",
                        release: "release/",
                        hotfix: "hotfix/",
                        ...current.prefixes,
                        [leaf]: value.trim(),
                      },
                    }
                  : current;
    return { ...workspace, branchPolicy };
  }
  if (section === "commitPolicy") {
    if (key === "preset" && (!value.trim() || value === "inherit")) {
      const { commitPolicy: _discard, ...rest } = workspace;
      return rest;
    }
    const current = workspace.commitPolicy ?? {
      preset: defaults.commitPreset ?? "conventional",
    };
    return {
      ...workspace,
      commitPolicy:
        key === "pattern"
          ? { ...current, pattern: value || undefined }
          : { ...current, preset: value as typeof current.preset },
    };
  }
  return workspace;
}

export type ProfileEditorField =
  | "branchPolicy.preset"
  | "branchPolicy.developBranch"
  | "branchPolicy.allowed"
  | "branchPolicy.protected"
  | "branchPolicy.integration"
  | "branchPolicy.prefixes.feature"
  | "branchPolicy.prefixes.bugfix"
  | "branchPolicy.prefixes.release"
  | "branchPolicy.prefixes.hotfix"
  | "commitPolicy.preset"
  | "commitPolicy.pattern";
export type TrackEditorField =
  | "strategy"
  | "productionBranch"
  | "integrationBranch"
  | "naming.feature"
  | "naming.release"
  | "naming.hotfix"
  | "baseBranch"
  | "mergeBackBranches"
  | "pullRequestTarget"
  | "tagNamespace"
  | "versionSource.kind"
  | "versionSource.path"
  | "versionSource.field"
  | "requiredChecks";

const splitList = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
const emptyTrack = (): ReleaseTrack => ({
  strategy: "gitflow",
  productionBranch: "main",
  integrationBranch: "develop",
  naming: {
    feature: "feature/{name}",
    release: "release/{version}",
    hotfix: "hotfix/{name}",
  },
  baseBranch: "develop",
  mergeBackBranches: ["develop"],
  pullRequestTarget: "develop",
  tagNamespace: "",
  versionSource: { kind: "git-tag" },
  requiredChecks: [],
});

export function profileEditorValue(
  profile: WorkspaceProfile | undefined,
  field: ProfileEditorField,
): string {
  const [section, key, leaf] = field.split(".");
  if (section === "branchPolicy") {
    const value = profile?.branchPolicy;
    if (key === "prefixes")
      return value?.prefixes?.[leaf as "feature" | "bugfix" | "release" | "hotfix"] ?? "";
    if (key === "allowed" || key === "protected") return value?.[key]?.join(", ") ?? "";
    return String(value?.[key as "preset" | "developBranch" | "integration"] ?? "");
  }
  return String(profile?.commitPolicy?.[key as "preset" | "pattern"] ?? "");
}

export function setProfileEditorValue(
  profile: WorkspaceProfile,
  field: ProfileEditorField,
  value: string,
  defaults: {
    branchPreset?: BranchPreset;
    commitPreset?: ToolkitConfig["commitPolicy"]["preset"];
  } = {},
): WorkspaceProfile {
  const [section, key, leaf] = field.split(".");
  if (section === "branchPolicy") {
    if (key === "preset" && (!value.trim() || value === "inherit")) {
      const { branchPolicy: _discard, ...rest } = profile;
      return rest;
    }
    const current = profile.branchPolicy ?? {
      preset: defaults.branchPreset ?? "gitflow",
    };
    let branchPolicy: NonNullable<WorkspaceProfile["branchPolicy"]>;
    if (key === "preset")
      branchPolicy = {
        ...current,
        preset: (value || "gitflow") as typeof current.preset,
      };
    else if (key === "allowed" || key === "protected")
      branchPolicy = { ...current, [key]: splitList(value) };
    else if (key === "prefixes")
      branchPolicy = {
        ...current,
        prefixes: {
          feature: "feature/",
          bugfix: "bugfix/",
          release: "release/",
          hotfix: "hotfix/",
          ...current.prefixes,
          [leaf]: value,
        },
      };
    else if (key === "developBranch")
      branchPolicy = { ...current, developBranch: value || undefined };
    else
      branchPolicy = {
        ...current,
        integration: value === "pr" ? "pr" : "merge",
      };
    return { ...profile, branchPolicy };
  }
  const current = profile.commitPolicy ?? {
    preset: defaults.commitPreset ?? "conventional",
  };
  if (key === "preset" && (!value.trim() || value === "inherit")) {
    const { commitPolicy: _discard, ...rest } = profile;
    return rest;
  }
  return {
    ...profile,
    commitPolicy:
      key === "pattern"
        ? { ...current, pattern: value || undefined }
        : {
            ...current,
            preset: (value || "conventional") as typeof current.preset,
          },
  };
}

export function trackEditorValue(track: ReleaseTrack, field: TrackEditorField): string {
  // Only production/integration are required (runtime defaults the rest).
  const source = track.versionSource ?? { kind: "git-tag" as const };
  if (field.startsWith("naming."))
    return track.naming?.[field.slice(7) as "feature" | "release" | "hotfix"] ?? "";
  if (field === "mergeBackBranches" || field === "requiredChecks")
    return (track[field] ?? []).join(", ");
  if (field.startsWith("versionSource.")) {
    const key = field.slice(14);
    if (key === "kind") return source.kind;
    if (key === "path") return source.kind === "package-json" ? source.path : "";
    return source.kind === "package-json" ? source.field : "";
  }
  return String(track[field as keyof ReleaseTrack] ?? "");
}

export function setTrackEditorValue(
  track: ReleaseTrack,
  field: TrackEditorField,
  value: string,
): ReleaseTrack {
  if (field.startsWith("naming."))
    return { ...track, naming: { ...track.naming, [field.slice(7)]: value } };
  if (field === "mergeBackBranches" || field === "requiredChecks")
    return { ...track, [field]: splitList(value) };
  if (field.startsWith("versionSource.")) {
    const current = track.versionSource ?? { kind: "git-tag" as const };
    const key = field.slice(14) as "kind" | "path" | "field";
    const kind = key === "kind" ? value : current.kind;
    const versionSource =
      kind === "package-json"
        ? {
            kind,
            path: key === "path" ? value : current.kind === kind ? current.path : "package.json",
            field: key === "field" ? value : current.kind === kind ? current.field : "version",
          }
        : kind === "manual"
          ? { kind }
          : { kind: "git-tag" as const };
    return { ...track, versionSource } as ReleaseTrack;
  }
  return { ...track, [field]: value };
}

export const createReleaseTrack = emptyTrack;

export type ProjectSetupResult = {
  gitignore: { ok: true; path: string; added: string[] } | { ok: false; error: string };
  hygiene: { ok: true; created: string[] } | { ok: false; error: string };
  openSource: boolean;
  created: string[];
};

export function runProjectSetup(
  root: string,
  opts: { includeOpenSource?: boolean } = {},
): ProjectSetupResult {
  const openSource = opts.includeOpenSource ?? hygieneFiles(root).openSource;
  const gitignore = ensureProjectGitignore(root, true);
  const hygiene = ensureHygieneFiles(root, {
    confirmed: true,
    includeOpenSource: openSource,
  });
  const created = [
    ...(gitignore.ok ? gitignore.added : []),
    ...(hygiene.ok ? hygiene.created : []),
  ];
  return { gitignore, hygiene, openSource, created };
}

// Shared scaffold outcome envelope (WZ-05/WZ-06): an existing credential file
// is never read or written, and malformed config files block every write.
type ScaffoldStatus = "missing" | "preserved" | "malformed";

type ScaffoldOutcome = {
  ok: boolean;
  status: ScaffoldStatus;
  /** Blocking diagnostic, set when status === "malformed". */
  error?: string;
  /** Malformed file that blocked the scaffold, set when status === "malformed". */
  file?: string;
  /** Files written by this scaffold. */
  created: string[];
  /** Credential files left byte-for-byte untouched (a legacy youtrack.token). */
  preserved: string[];
};

export type YouTrackScaffold = ScaffoldOutcome & { youtrackJson: string };

type LoadedConfig = { ok: true; value: unknown } | { ok: false } | null;

function loadConfig(p: string): LoadedConfig {
  if (!existsSync(p)) return null;
  try {
    return { ok: true, value: JSON.parse(readFileSync(p, "utf8")) };
  } catch {
    return { ok: false };
  }
}

function malformedBlock(
  file: string,
  message: string,
): {
  ok: false;
  status: "malformed";
  error: string;
  file: string;
  created: never[];
  preserved: never[];
} {
  return {
    ok: false,
    status: "malformed",
    error: message,
    file,
    created: [],
    preserved: [],
  };
}

function finalStatus(outcome: ScaffoldOutcome): ScaffoldStatus {
  return outcome.preserved.length > 0 ? "preserved" : "missing";
}

// WZ-10: a host is only "complete" when it was scaffolded successfully — an
// unconfigured (null) or blocked (ok: false) host keeps setup incomplete.
export function isSetupComplete(results: {
  youtrack?: { ok: boolean } | null;
  vcs?: { ok: boolean } | null;
}): boolean {
  return (results.youtrack?.ok ?? false) && (results.vcs?.ok ?? false);
}

// ponytail: mirrors scripts/init/apply.sh write_youtrack_json in TS — initApply shells out to
// bash (CA-01 forbids bash); WORKIT_YT_*/WORKIT_VCS_* env overrides intentionally ignored
// (wizard takes values from prompts instead of env; parity pinned by test/scaffold-parity.test.ts).
// No token: YouTrack goes through ytrack. A leftover youtrack.token is reported preserved,
// never read or written.
export function scaffoldYouTrack(
  dir: string,
  baseUrl: string,
  opts: { locale?: string } = {},
): YouTrackScaffold {
  mkdirSync(dir, { recursive: true });
  const youtrackJson = path.join(dir, "youtrack.json");
  const loaded = loadConfig(youtrackJson);
  if (
    loaded &&
    (!loaded.ok ||
      typeof loaded.value !== "object" ||
      loaded.value === null ||
      Array.isArray(loaded.value))
  ) {
    return {
      ...malformedBlock(
        youtrackJson,
        `youtrack.json is malformed — refusing to overwrite it: ${youtrackJson}`,
      ),
      youtrackJson,
    };
  }
  const config = { baseUrl, locale: opts.locale ?? "en" };
  writeFileSync(youtrackJson, JSON.stringify(config, null, 2) + "\n", "utf8");
  const outcome: ScaffoldOutcome = {
    ok: true,
    status: "missing",
    created: [],
    preserved: [],
  };
  outcome.created.push(youtrackJson);
  const legacyToken = path.join(dir, "youtrack.token");
  if (existsSync(legacyToken)) outcome.preserved.push(legacyToken);
  return { ...outcome, status: finalStatus(outcome), youtrackJson };
}

export type VcsScaffold = ScaffoldOutcome & {
  vcsJson: string;
  provider: VcsProvider;
};

export function scaffoldVcs(dir: string, provider: VcsProvider): VcsScaffold {
  mkdirSync(dir, { recursive: true });
  const vcsJson = path.join(dir, "vcs.json");

  const loaded = loadConfig(vcsJson);
  if (
    loaded &&
    (!loaded.ok ||
      typeof loaded.value !== "object" ||
      loaded.value === null ||
      Array.isArray(loaded.value))
  ) {
    return {
      ...malformedBlock(vcsJson, `vcs.json is malformed — refusing to overwrite it: ${vcsJson}`),
      vcsJson,
      provider,
    };
  }
  const config = {
    provider,
    defaultTargetBranch: "develop",
    gitlab: { host: "gitlab.com", apiUrl: "https://gitlab.com/api/v4" },
    github: { host: "github.com" },
    pr: {
      squashOnMerge: true,
      removeSourceBranch: true,
      pushBranch: true,
      confirmSkip: true,
    },
  };
  writeFileSync(vcsJson, JSON.stringify(config, null, 2) + "\n", "utf8");
  const outcome: ScaffoldOutcome = {
    ok: true,
    status: "missing",
    created: [],
    preserved: [],
  };
  outcome.created.push(vcsJson);

  return {
    ...outcome,
    status: finalStatus(outcome),
    vcsJson,
    provider,
  };
}

export function shouldWriteWorkspaces(
  loaded: WorkspaceConfig[],
  current: WorkspaceConfig[],
): boolean {
  return !isDeepStrictEqual(loaded, current);
}

export function loadWorkspaces(): WorkspaceConfig[] {
  return loadWorkspacesFrom(configDir());
}

export type WriteWorkspacesResult = {
  ok: boolean;
  error?: string;
  path: string;
};

export function writeWorkspaces(
  entries: WorkspaceConfig[],
  options: { expectedRevision?: string } = {},
): WriteWorkspacesResult {
  const file = workspacesPath();
  const current = readWorkspacesResult(path.dirname(file));
  if (current.status === "malformed" || current.status === "invalid")
    return { ok: false, error: current.error, path: file };
  const expectedRevision = options.expectedRevision ?? current.revision!;
  if (current.revision !== expectedRevision)
    return {
      ok: false,
      error: `workspace config changed; reload before writing ${file}`,
      path: file,
    };
  const document = { ...current.document, workspaces: entries };
  const validation = validateWorkspacesDocument(document, file);
  if (validation.status !== "valid") return { ok: false, error: validation.error, path: file };
  const content = JSON.stringify(document, null, 2) + "\n";
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, "utf8");
    if (readWorkspacesResult(path.dirname(file)).revision !== expectedRevision) {
      try {
        rmSync(tmp, { force: true });
      } catch {}
      return {
        ok: false,
        error: `workspace config changed while writing ${file}`,
        path: file,
      };
    }
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    return {
      ok: false,
      error: `failed to write ${file}: ${(err as Error).message}`,
      path: file,
    };
  }
  return { ok: true, path: file };
}

// ---------------------------------------------------------------------------
// Setup preview + apply live in ./admin/setup.ts (CLI-only since 3.0, so host
// hooks and plugins never bundle them); re-exported for the wizard modules.
// ---------------------------------------------------------------------------
export {
  parseList,
  buildSetupPreview,
  type SetupPreviewInput,
  type SetupMutation,
} from "./admin/setup";
export type { VcsProvider };

// CA-06: the wizard's branch-policy apply routes through the same shared
// proposal→write helper as the host init action (init.ts branch_policy), so
// both produce byte-identical workspaces.json writes on the same fixture.
// The env override construction lives HERE (not in the host entrypoint) so the
// wizard and the host side cannot drift; ambient WORKIT_BP_* overrides are
// stripped so both sides are hermetic.
export function applyWizardBranchPolicy(
  branchPolicy: WorkspaceBranchPolicy | undefined,
  workspace_root: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, any> {
  const clean: NodeJS.ProcessEnv = { ...env };
  delete clean.WORKIT_BP_INTEGRATION;
  delete clean.WORKIT_BP_DEVELOP;
  delete clean.WORKIT_BP_NAME;
  clean.WORKIT_WORKSPACE_ROOT = workspace_root;
  if (branchPolicy?.integration) clean.WORKIT_BP_INTEGRATION = branchPolicy.integration;
  if (branchPolicy?.developBranch) clean.WORKIT_BP_DEVELOP = branchPolicy.developBranch;
  return applyWorkspaceBranchPolicy({ workspace_root, env: clean });
}
