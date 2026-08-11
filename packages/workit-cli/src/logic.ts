import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import {
  LOCALE_RE,
  mergePreset,
  readConfigFromDir,
  resolveConfigDir,
  type BranchPreset,
  type ToolkitConfig,
} from "@brainervirus/workit-core/src/core/config.ts";
import { readSetupState, type SetupState } from "@brainervirus/workit-core/src/core/setup-state.ts";
import {
  workspacesPath,
  type WorkspaceConfig,
} from "@brainervirus/workit-core/src/core/workspaces.ts";
import { GITIGNORE_ENTRIES } from "@brainervirus/workit-core/src/core/gitignore.ts";
import { planHygieneFiles } from "@brainervirus/workit-core/src/core/hygiene.ts";
import { ensureProjectGitignore } from "@brainervirus/workit-core/src/core/gitignore.ts";
import { ensureHygieneFiles, hygieneFiles } from "@brainervirus/workit-core/src/core/hygiene.ts";

export const TOKEN_PLACEHOLDER = "YOUR_TOKEN_HERE";

export function validateLocale(locale: string): string | null {
  if (!LOCALE_RE.test(locale)) {
    return `invalid locale "${locale}" — expected BCP-47 like en or es-CL`;
  }
  return null;
}

const KNOWN_TIMEZONES: string[] | null =
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : null;

export function validateTimezone(timezone: string): string | null {
  const tz = timezone.trim();
  if (!tz) return "timezone is required";
  if (KNOWN_TIMEZONES && !KNOWN_TIMEZONES.includes(tz)) {
    return `unknown timezone "${tz}" — check the IANA name (e.g. America/Santiago)`;
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

export function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export type ConfigInput = {
  locale?: string;
  timezone?: string;
  preset?: BranchPreset;
  allowed?: string[];
  protectedNames?: string[];
};

export function collectConfigValues(input: ConfigInput, current: ToolkitConfig): ToolkitConfig {
  return {
    locale: input.locale ?? current.locale,
    localeOptions: current.localeOptions,
    timezone: input.timezone ?? current.timezone,
    branchPolicy: mergePreset(input.preset ?? current.branchPolicy.preset, input, current),
  };
}

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
  const hygiene = ensureHygieneFiles(root, { confirmed: true, includeOpenSource: openSource });
  const created = [
    ...(gitignore.ok ? gitignore.added : []),
    ...(hygiene.ok ? hygiene.created : []),
  ];
  return { gitignore, hygiene, openSource, created };
}

// Shared scaffold outcome envelope (WZ-05/WZ-06): credentials are preserved
// byte-for-byte unless absent, and malformed config files block every write.
export type ScaffoldStatus = "missing" | "preserved" | "malformed";

export type ScaffoldOutcome = {
  ok: boolean;
  status: ScaffoldStatus;
  /** Blocking diagnostic, set when status === "malformed". */
  error?: string;
  /** Malformed file that blocked the scaffold, set when status === "malformed". */
  file?: string;
  /** Files written by this scaffold (config + placeholders created). */
  created: string[];
  /** Credential files left byte-for-byte untouched. */
  preserved: string[];
};

export type YouTrackScaffold = ScaffoldOutcome & {
  youtrackJson: string;
  tokenPath: string;
  tokenCreateUrl: string;
};

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
  return { ok: false, status: "malformed", error: message, file, created: [], preserved: [] };
}

function ensureToken(path: string, outcome: { created: string[]; preserved: string[] }): void {
  try {
    writeFileSync(path, TOKEN_PLACEHOLDER + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    outcome.created.push(path);
  } catch (err) {
    // wx (exclusive create) closes the TOCTOU window: a token created between any
    // existence check and write now races the write itself, and EEXIST means the
    // other writer won — preserve their bytes instead of clobbering them.
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      outcome.preserved.push(path);
      return;
    }
    throw err;
  }
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

// ponytail: mirrors scripts/init/apply.sh write_youtrack_json + write_token_placeholder +
// scripts/youtrack/token-create-url.sh in TS — initApply shells out to bash (CA-01 forbids bash)
// ponytail: mirrors apply.sh; WORKFLOW_YT_*/WORKFLOW_VCS_* env overrides intentionally ignored
// (wizard takes values from prompts instead of env; parity pinned by test/scaffold-parity.test.ts)
export function scaffoldYouTrack(
  dir: string,
  baseUrl: string,
  opts: { locale?: string; timezone?: string } = {},
): YouTrackScaffold {
  mkdirSync(dir, { recursive: true });
  const youtrackJson = path.join(dir, "youtrack.json");
  const tokenPath = path.join(dir, "youtrack.token");
  const base = baseUrl.replace(/\/+$/, "");
  const tokenCreateUrl = `${base}/users/me?tab=account-security`;
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
      tokenPath,
      tokenCreateUrl,
    };
  }
  const config = {
    baseUrl,
    tokenFile: tokenPath,
    timezone: opts.timezone ?? "America/Santiago",
    locale: opts.locale ?? "es-CL",
    defaultMention: "Alejandra.Flores",
    greetings: { morning: "buenos días", afternoon: "buenas tardes" },
    greetingCutoff: "12:00",
    meetingIssue: "IRPT-12",
    meetingIssues: {
      general: {
        issue: "IRPT-12",
        label: "General meetings (Reuniones internas Team IRP)",
        workItemText: "Reuniones",
      },
      web: {
        issue: "NSXFT-21",
        label: "Web meetings",
        workItemText: "Reuniones web",
        url: "https://enghouseamg.youtrack.cloud/projects/NSXFT/issues/NSXFT-21",
      },
    },
    commentHeader: "# Actualización",
    attachmentsHeaderImages: "## Adjunto capturas",
    attachmentsHeaderFiles: "## Archivos adjuntos",
    attachmentsHeaderMixed: "## Adjuntos",
    tokenDefaults: {
      name: "workit",
      description: "OpenCode workit — /wk-issue-update and /wk-meetings",
      scopes: ["YouTrack"],
      profileTab: "account-security",
    },
  };
  writeFileSync(youtrackJson, JSON.stringify(config, null, 2) + "\n", "utf8");
  const outcome: ScaffoldOutcome = { ok: true, status: "missing", created: [], preserved: [] };
  outcome.created.push(youtrackJson);
  ensureToken(tokenPath, outcome);
  return {
    ...outcome,
    status: finalStatus(outcome),
    youtrackJson,
    tokenPath,
    tokenCreateUrl,
  };
}

export type VcsProvider = "gitlab" | "github";

export type VcsScaffold = ScaffoldOutcome & {
  vcsJson: string;
  tokenPaths: string[];
  activeTokenPath: string;
  tokenCreateUrl: string;
  provider: VcsProvider;
};

const TOKEN_DEFAULTS = {
  name: "workit",
  description: "OpenCode workit — /wk-pr and glab/gh",
  gitlabScopes: ["api"],
  githubPermissions: { pull_requests: "write", contents: "write", metadata: "read" },
  githubClassicScopes: ["repo"],
};

// ponytail: mirrors scripts/init/apply.sh write_vcs_json + write_vcs_token_placeholder +
// scripts/vcs/token-create-urls.sh in TS — same no-bash rationale as scaffoldYouTrack
export function scaffoldVcs(dir: string, provider: VcsProvider): VcsScaffold {
  mkdirSync(dir, { recursive: true });
  const vcsJson = path.join(dir, "vcs.json");
  const gitlabToken = path.join(dir, "gitlab.token");
  const githubToken = path.join(dir, "github.token");

  const gitlabUrl = `https://gitlab.com/-/user_settings/personal_access_tokens?${new URLSearchParams(
    {
      name: TOKEN_DEFAULTS.name,
      description: TOKEN_DEFAULTS.description,
      scopes: "api",
    },
  )}`;
  const githubUrl = `https://github.com/settings/personal-access-tokens/new?${new URLSearchParams({
    name: TOKEN_DEFAULTS.name,
    description: TOKEN_DEFAULTS.description,
    pull_requests: "write",
    contents: "write",
    metadata: "read",
  })}`;
  const tokenCreateUrl = provider === "gitlab" ? gitlabUrl : githubUrl;
  const activeTokenPath = provider === "gitlab" ? gitlabToken : githubToken;

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
      tokenPaths: [gitlabToken, githubToken],
      activeTokenPath,
      tokenCreateUrl,
      provider,
    };
  }
  const config = {
    provider,
    defaultTargetBranch: "develop",
    gitlab: { host: "gitlab.com", apiUrl: "https://gitlab.com/api/v4", tokenFile: gitlabToken },
    github: { host: "github.com", tokenFile: githubToken },
    pr: { squashOnMerge: true, removeSourceBranch: true, pushBranch: true, confirmSkip: true },
    tokenDefaults: TOKEN_DEFAULTS,
  };
  writeFileSync(vcsJson, JSON.stringify(config, null, 2) + "\n", "utf8");
  const outcome: ScaffoldOutcome = { ok: true, status: "missing", created: [], preserved: [] };
  outcome.created.push(vcsJson);
  for (const p of [gitlabToken, githubToken]) {
    ensureToken(p, outcome);
  }

  return {
    ...outcome,
    status: finalStatus(outcome),
    vcsJson,
    tokenPaths: [gitlabToken, githubToken],
    activeTokenPath,
    tokenCreateUrl,
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
  let raw: string;
  try {
    raw = readFileSync(workspacesPath(), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const list = (parsed as { workspaces?: unknown }).workspaces;
  return Array.isArray(list) ? (list as WorkspaceConfig[]) : [];
}

export type WriteWorkspacesResult = { ok: boolean; error?: string; path: string };

const VALID_PROVIDERS: VcsProvider[] = ["gitlab", "github"];

export function writeWorkspaces(entries: WorkspaceConfig[]): WriteWorkspacesResult {
  const file = workspacesPath();
  for (const [i, entry] of entries.entries()) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: `workspace #${i + 1} is null`, path: file };
    }
    if (typeof entry.name !== "string" || !entry.name.trim()) {
      return { ok: false, error: `workspace #${i + 1} missing a name`, path: file };
    }
    if (typeof entry.glob !== "string" || !entry.glob.trim()) {
      return { ok: false, error: `workspace "${entry.name}" missing a glob`, path: file };
    }
    const provider = entry.vcs?.provider;
    if (provider && !VALID_PROVIDERS.includes(provider)) {
      return {
        ok: false,
        error: `workspace "${entry.name}" has unknown provider "${provider}"`,
        path: file,
      };
    }
    if (entry.youtrack && provider !== "gitlab") {
      return {
        ok: false,
        error: `workspace "${entry.name}" links YouTrack issues but provider is "${provider ?? "unset"}" — youtrack linking requires the gitlab provider`,
        path: file,
      };
    }
    if (entry.issues && provider !== "github") {
      return {
        ok: false,
        error: `workspace "${entry.name}" links GitHub issues but provider is "${provider ?? "unset"}" — github issues require the github provider`,
        path: file,
      };
    }
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ workspaces: entries }, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
  } catch (err) {
    return { ok: false, error: `failed to write ${file}: ${(err as Error).message}`, path: file };
  }
  return { ok: true, path: file };
}

// ---------------------------------------------------------------------------
// Setup preview (WZ-04-WZ-06, WZ-08, RL-06; CA-12, CA-14, CA-22, CA-23).
// buildSetupPreview is a pure reader: it classifies the current setup state and
// returns the exact mutations Apply would perform WITHOUT applying them, so the
// preview is authoritative and nothing touches the filesystem before Apply.
// Integrations are neutral and optional: youtrack is skipped when baseUrl is
// empty, vcs when the provider is "skip", and neither ships private defaults.
// ---------------------------------------------------------------------------

export type SetupPreviewInput = {
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

export type SetupMutation =
  | { type: "create-file"; path: string; content: string; mode?: number }
  | { type: "merge-json"; path: string; value: unknown }
  | { type: "update-workspaces"; path: string; entries: WorkspaceConfig[] }
  | { type: "append-gitignore"; path: string; entries: string[] };

export type SetupOverride = {
  envKey: string;
  affects: string;
  value: string;
  note: string;
};

export type SetupPreview = {
  ok: boolean;
  /** Path-specific blocking diagnostics, set when any setup file is malformed. */
  blocked: string[];
  mutations: SetupMutation[];
  /** Environment overrides active for the shell init/apply path (RL-06). */
  overrides: SetupOverride[];
  /** Credential files left byte-for-byte untouched. */
  preserved: string[];
  state: SetupState;
};

const YT_OVERRIDES: { envKey: string; affects: string }[] = [
  { envKey: "WORKFLOW_YT_BASE_URL", affects: "youtrack.json baseUrl" },
  { envKey: "WORKFLOW_YT_TOKEN_FILE", affects: "youtrack.json tokenFile" },
  { envKey: "WORKFLOW_YT_TIMEZONE", affects: "youtrack.json timezone" },
  { envKey: "WORKFLOW_YT_MENTION", affects: "youtrack.json defaultMention" },
  { envKey: "WORKFLOW_YT_MEETING_ISSUE", affects: "youtrack.json meetingIssue" },
  { envKey: "WORKFLOW_YT_WEB_MEETING_ISSUE", affects: "youtrack.json web meeting issue" },
];

const VCS_OVERRIDES: { envKey: string; affects: string }[] = [
  { envKey: "WORKFLOW_VCS_PROVIDER", affects: "vcs.json provider" },
  { envKey: "WORKFLOW_VCS_TARGET_BRANCH", affects: "vcs.json defaultTargetBranch" },
  { envKey: "WORKFLOW_GITLAB_HOST", affects: "vcs.json gitlab.host" },
  { envKey: "WORKFLOW_GITLAB_API_URL", affects: "vcs.json gitlab.apiUrl" },
  { envKey: "WORKFLOW_GITHUB_HOST", affects: "vcs.json github.host" },
];

const SETUP_OVERRIDES = [...YT_OVERRIDES, ...VCS_OVERRIDES];

export const activeSetupOverrides = (env: NodeJS.ProcessEnv = process.env): SetupOverride[] => {
  const overrides: SetupOverride[] = [];
  for (const { envKey, affects } of SETUP_OVERRIDES) {
    const value = env[envKey];
    if (value === undefined || value === "") continue;
    overrides.push({
      envKey,
      affects,
      value,
      note: "set in the environment; the interactive wizard does not apply it, but the shell init/apply path would use it",
    });
  }
  return overrides;
};

// Neutral youtrack.json draft: no organization names, issue IDs, greetings, or
// language defaults (WZ-04/CA-14). merge-json preserves unrelated keys on Apply.
function youtrackDraft(values: SetupPreviewInput, dir: string): Record<string, unknown> {
  return {
    baseUrl: values.baseUrl.replace(/\/+$/, ""),
    tokenFile: path.join(dir, "youtrack.token"),
    timezone: values.timezone,
    locale: values.locale,
    tokenDefaults: {
      name: "workit",
      description: "OpenCode workit — /wk-issue-update and /wk-meetings",
      scopes: ["YouTrack"],
      profileTab: "account-security",
    },
  };
}

function vcsDraft(provider: VcsProvider, dir: string): Record<string, unknown> {
  return {
    provider,
    gitlab: {
      host: "gitlab.com",
      apiUrl: "https://gitlab.com/api/v4",
      tokenFile: path.join(dir, "gitlab.token"),
    },
    github: { host: "github.com", tokenFile: path.join(dir, "github.token") },
    pr: { squashOnMerge: true, removeSourceBranch: true, pushBranch: true, confirmSkip: true },
    tokenDefaults: {
      name: "workit",
      description: "OpenCode workit — /wk-pr and glab/gh",
      gitlabScopes: ["api"],
      githubPermissions: { pull_requests: "write", contents: "write", metadata: "read" },
      githubClassicScopes: ["repo"],
    },
  };
}

export function buildSetupPreview(
  values: SetupPreviewInput,
  opts: { dir?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): SetupPreview {
  const env = opts.env ?? process.env;
  const state = readSetupState(opts.dir ?? resolveConfigDir());
  const blocked: string[] = [];
  const mutations: SetupMutation[] = [];
  const preserved: string[] = [];
  const overrides = activeSetupOverrides(env);

  for (const entry of [state.config, state.youtrack, state.vcs, state.workspaces]) {
    if (entry.status === "malformed") blocked.push(entry.error ?? entry.file);
  }

  if (blocked.length === 0) {
    const current = readConfigFromDir(state.configDir);
    mutations.push({
      type: "merge-json",
      path: path.join(state.configDir, "config.json"),
      value: {
        locale: values.locale,
        localeOptions: current.localeOptions,
        timezone: values.timezone,
        branchPolicy: mergePreset(
          values.branchPreset,
          {
            allowed: values.branchPreset === "custom" ? parseList(values.branchAllowed) : undefined,
            protectedNames:
              values.branchPreset === "custom" ? parseList(values.branchProtected) : undefined,
          },
          current,
        ),
      },
    });

    if (values.workspaces.length > 0) {
      mutations.push({
        type: "update-workspaces",
        path: path.join(state.configDir, "workspaces.json"),
        entries: values.workspaces,
      });
    }

    if (values.baseUrl.trim()) {
      mutations.push({
        type: "merge-json",
        path: path.join(state.configDir, "youtrack.json"),
        value: youtrackDraft(values, state.configDir),
      });
      const tokenPath = path.join(state.configDir, "youtrack.token");
      if (existsSync(tokenPath)) preserved.push(tokenPath);
      else
        mutations.push({
          type: "create-file",
          path: tokenPath,
          content: TOKEN_PLACEHOLDER + "\n",
          mode: 0o600,
        });
    }

    if (values.vcsProvider !== "skip") {
      mutations.push({
        type: "merge-json",
        path: path.join(state.configDir, "vcs.json"),
        value: vcsDraft(values.vcsProvider, state.configDir),
      });
      const tokenPath = path.join(state.configDir, `${values.vcsProvider}.token`);
      if (existsSync(tokenPath)) preserved.push(tokenPath);
      else
        mutations.push({
          type: "create-file",
          path: tokenPath,
          content: TOKEN_PLACEHOLDER + "\n",
          mode: 0o600,
        });
    }

    if (values.applyProject) {
      const root = path.resolve(opts.cwd ?? process.cwd());
      const gitignorePath = path.join(root, ".gitignore");
      const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
      const existingLines = new Set(
        existing
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      );
      const entries = GITIGNORE_ENTRIES.filter(
        (e) => e.trim() !== "" && !existingLines.has(e.trim()),
      );
      mutations.push({ type: "append-gitignore", path: gitignorePath, entries });
      for (const planned of planHygieneFiles(root)) {
        mutations.push({ type: "create-file", path: planned.path, content: planned.content });
      }
    }
  }

  return { ok: blocked.length === 0, blocked, mutations, overrides, preserved, state };
}
