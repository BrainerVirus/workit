import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PRESETS, LOCALE_RE, type BranchPreset, type ToolkitConfig } from "../core/config";
import { ensureProjectGitignore } from "../core/gitignore";
import { ensureHygieneFiles, hygieneFiles } from "../core/hygiene";

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
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export type ConfigInput = {
  locale?: string;
  timezone?: string;
  preset?: BranchPreset;
  allowed?: string[];
  protectedNames?: string[];
};

export function collectConfigValues(input: ConfigInput, current: ToolkitConfig): ToolkitConfig {
  const preset = input.preset ?? current.branchPolicy.preset;
  const presetDefs = PRESETS[preset];
  return {
    locale: input.locale ?? current.locale,
    localeOptions: current.localeOptions,
    timezone: input.timezone ?? current.timezone,
    branchPolicy: {
      preset,
      allowed: preset === "custom" ? (input.allowed ?? current.branchPolicy.allowed) : [...presetDefs.allowed],
      protected: preset === "custom" ? (input.protectedNames ?? current.branchPolicy.protected) : [...presetDefs.protected],
    },
  };
}

export type ProjectSetupResult = {
  gitignore: { ok: true; path: string; added: string[] } | { ok: false; error: string };
  hygiene: { ok: true; created: string[] } | { ok: false; error: string };
  openSource: boolean;
  created: string[];
};

export function runProjectSetup(root: string, opts: { includeOpenSource?: boolean } = {}): ProjectSetupResult {
  const openSource = opts.includeOpenSource ?? hygieneFiles(root).openSource;
  const gitignore = ensureProjectGitignore(root, true);
  const hygiene = ensureHygieneFiles(root, { confirmed: true, includeOpenSource: openSource });
  const created = [
    ...(gitignore.ok ? gitignore.added : []),
    ...(hygiene.ok ? hygiene.created : []),
  ];
  return { gitignore, hygiene, openSource, created };
}

export const DEFAULT_BASE_URL = "https://enghouseamg.youtrack.cloud";

export type YouTrackScaffold = {
  youtrackJson: string;
  tokenPath: string;
  tokenCreateUrl: string;
};

// ponytail: mirrors scripts/init/apply.sh write_youtrack_json + write_token_placeholder +
// scripts/youtrack/token-create-url.sh in TS — initApply shells out to bash (CA-01 forbids bash)
// ponytail: mirrors apply.sh; WORKFLOW_YT_*/WORKFLOW_VCS_* env overrides intentionally ignored
// (wizard takes values from prompts instead of env; parity pinned by test/scaffold-parity.test.ts)
export function scaffoldYouTrack(dir: string, baseUrl: string, opts: { locale?: string; timezone?: string } = {}): YouTrackScaffold {
  mkdirSync(dir, { recursive: true });
  const youtrackJson = path.join(dir, "youtrack.json");
  const tokenPath = path.join(dir, "youtrack.token");
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
      name: "workflow-toolkit",
      description: "OpenCode flowkit — /wf-issue-update and /wf-meetings",
      scopes: ["YouTrack"],
      profileTab: "account-security",
    },
  };
  writeFileSync(youtrackJson, JSON.stringify(config, null, 2) + "\n", "utf8");
  writeFileSync(tokenPath, TOKEN_PLACEHOLDER + "\n", { encoding: "utf8", mode: 0o600 });
  const base = baseUrl.replace(/\/+$/, "");
  return {
    youtrackJson,
    tokenPath,
    tokenCreateUrl: `${base}/users/me?tab=account-security`,
  };
}

export type VcsProvider = "gitlab" | "github";

export type VcsScaffold = {
  vcsJson: string;
  tokenPaths: string[];
  activeTokenPath: string;
  tokenCreateUrl: string;
  provider: VcsProvider;
};

const TOKEN_DEFAULTS = {
  name: "workflow-toolkit",
  description: "OpenCode flowkit — /wf-pr and glab/gh",
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
  const config = {
    provider,
    defaultTargetBranch: "develop",
    gitlab: { host: "gitlab.com", apiUrl: "https://gitlab.com/api/v4", tokenFile: gitlabToken },
    github: { host: "github.com", tokenFile: githubToken },
    pr: { squashOnMerge: true, removeSourceBranch: true, pushBranch: true, confirmSkip: true },
    tokenDefaults: TOKEN_DEFAULTS,
  };
  writeFileSync(vcsJson, JSON.stringify(config, null, 2) + "\n", "utf8");
  for (const p of [gitlabToken, githubToken]) {
    writeFileSync(p, TOKEN_PLACEHOLDER + "\n", { encoding: "utf8", mode: 0o600 });
  }

  const gitlabUrl = `https://gitlab.com/-/user_settings/personal_access_tokens?${new URLSearchParams({
    name: TOKEN_DEFAULTS.name,
    description: TOKEN_DEFAULTS.description,
    scopes: "api",
  })}`;
  const githubUrl = `https://github.com/settings/personal-access-tokens/new?${new URLSearchParams({
    name: TOKEN_DEFAULTS.name,
    description: TOKEN_DEFAULTS.description,
    pull_requests: "write",
    contents: "write",
    metadata: "read",
  })}`;

  return {
    vcsJson,
    tokenPaths: [gitlabToken, githubToken],
    activeTokenPath: provider === "gitlab" ? gitlabToken : githubToken,
    tokenCreateUrl: provider === "gitlab" ? gitlabUrl : githubUrl,
    provider,
  };
}
