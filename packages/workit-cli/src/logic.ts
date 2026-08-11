import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  workspacesPath,
  type WorkspaceConfig,
} from "@brainervirus/workit-core/src/core/workspaces.ts";
import { ensureProjectGitignore } from "@brainervirus/workit-core/src/core/gitignore.ts";
import { ensureHygieneFiles, hygieneFiles } from "@brainervirus/workit-core/src/core/hygiene.ts";
import { writeFileExclusive } from "@brainervirus/workit-core/src/core/safe-write.ts";
import { TOKEN_PLACEHOLDER, type VcsProvider } from "@brainervirus/workit-core/src/core/setup.ts";

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

export type ConfigInput = {
  locale?: string;
  timezone?: string;
  preset?: BranchPreset;
  allowed?: string[];
  protectedNames?: string[];
};

export function collectConfigValues(input: ConfigInput, current: ToolkitConfig): ToolkitConfig {
  return mergeConfigValues(input, current);
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
  // wx (exclusive create) closes the TOCTOU window: a token created between any
  // existence check and write now races the write itself, and EEXIST means the
  // other writer won — preserve their bytes instead of clobbering them. Shared
  // with initApplyData via core/safe-write.ts (Task 14 Step 7 / CA-13).
  if (writeFileExclusive(path, TOKEN_PLACEHOLDER + "\n", 0o600) === "created") {
    outcome.created.push(path);
  } else {
    outcome.preserved.push(path);
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
  return loadWorkspacesFrom(configDir());
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
// Setup preview + apply moved to the shared core (Task 14):
// @brainervirus/workit-core/src/core/setup.ts owns buildSetupPreview /
// applySetupPreview / SetupResult so the same authoritative flow runs in the
// bundled CLI, the host adapters, and the extracted-package tests. The CLI
// re-exports them for backward compatibility.
// ---------------------------------------------------------------------------
export {
  TOKEN_PLACEHOLDER,
  parseList,
  buildSetupPreview,
  activeSetupOverrides,
  applySetupPreview,
  setupCompletionGuidance,
  type SetupPreviewInput,
  type SetupMutation,
  type SetupOverride,
  type SetupPreview,
  type Platform,
  type SetupResult,
  type SetupResultEntry,
  type SetupResultStatus,
  type ApplySetupOptions,
} from "@brainervirus/workit-core/src/core/setup.ts";
export type { VcsProvider };
