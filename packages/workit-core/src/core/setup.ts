import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { mergePreset, readConfigFromDir, resolveConfigDir, type BranchPreset } from "./config";
import { readSetupState, type SetupState } from "./setup-state";
import { loadWorkspacesFrom, validateWorkspaceGlob, type WorkspaceConfig } from "./workspaces";
import { GITIGNORE_ENTRIES } from "./gitignore";
import { planHygieneFiles } from "./hygiene";
import { packageRoot } from "./package-root";
import {
  cursorMcpServerEntry,
  mergeCursorMcp,
  mergeCursorSettings,
  mergeOpenCodeConfig,
} from "./registration";
import { runDoctor, type DoctorReport } from "./doctor";
import { writeFileExclusive } from "./safe-write";

// Setup preview + apply (WZ-04-WZ-09, WZ-13-WZ-15; CA-12, CA-14, CA-22, CA-23).
// buildSetupPreview is a pure reader: it classifies the current setup state and
// returns the exact mutations Apply would perform WITHOUT applying them, so the
// preview is authoritative and nothing touches the filesystem before Apply.
// applySetupPreview applies ONLY the reviewed mutations using package-native
// registration/assets, reports every platform/file independently, preserves
// unrelated user config byte-for-byte, and verifies the result with the shared
// offline doctor. Integrations are neutral and optional: youtrack is skipped
// when baseUrl is empty, vcs when the provider is "skip".

export const TOKEN_PLACEHOLDER = "YOUR_TOKEN_HERE";

export type VcsProvider = "gitlab" | "github";

export function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export type SetupPreviewInput = {
  platforms?: string[];
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
  /** Selected platform adapters to register on Apply (WZ-09). */
  platforms: string[];
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

    // WZ-12 parity: the draft is authoritative but a no-op workspaces section
    // (unchanged vs disk, including the initial seed) must not claim a rewrite.
    // Removing every workspace differs from disk and therefore still writes [].
    const diskWorkspaces = loadWorkspacesFrom(state.configDir);
    if (!isDeepStrictEqual(values.workspaces, diskWorkspaces)) {
      // RL-08: unsupported matcher grammar is rejected before any write —
      // same gate the direct writeWorkspaces path and the wizard enforce.
      for (const entry of values.workspaces) {
        if (!entry || typeof entry.glob !== "string") continue;
        const v = validateWorkspaceGlob(entry.glob);
        if (!v.ok) {
          blocked.push(v.error);
          break;
        }
      }
      if (blocked.length === 0) {
        mutations.push({
          type: "update-workspaces",
          path: path.join(state.configDir, "workspaces.json"),
          entries: values.workspaces,
        });
      }
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

  return {
    ok: blocked.length === 0,
    blocked,
    mutations,
    overrides,
    preserved,
    platforms: values.platforms ?? [],
    state,
  };
}

// ---------------------------------------------------------------------------
// Apply (Task 14: WZ-09, WZ-10, WZ-13-WZ-15; CA-08, CA-13, CA-14, CA-31).
// ---------------------------------------------------------------------------

export type Platform = "opencode" | "cursor";

export type SetupResultStatus = "Installed" | "Configured" | "Skipped" | "Failed";

export type SetupResultEntry = {
  platform: Platform | "core";
  file: string;
  status: SetupResultStatus;
  detail?: string;
};

export type SetupResult = {
  ok: boolean;
  exitCode: number;
  entries: SetupResultEntry[];
  /** Credential files left byte-for-byte untouched. */
  preserved: string[];
  /** Path-specific blocking diagnostics when the preview was malformed. */
  blocked: string[];
  /** Post-apply doctor reports, one per verified platform host. */
  doctor: DoctorReport[];
};

export type ApplySetupOptions = {
  home?: string;
  configDir?: string;
  dev?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  opencodeConfig?: string;
  cursorSettings?: string;
  cursorMcp?: string;
  cursorPluginDir?: string;
  stateDir?: string;
};

type ResolvedApply = {
  home: string;
  configDir: string;
  dev: string | null;
  cwd: string;
  env: NodeJS.ProcessEnv;
  opencodeConfig: string;
  cursorSettings: string;
  cursorMcp: string;
  cursorPluginDir: string;
};

function resolveApply(preview: SetupPreview, options: ApplySetupOptions): ResolvedApply {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? os.homedir();
  return {
    home,
    configDir: options.configDir ?? preview.state.configDir,
    dev: options.dev ?? env.WORKFLOW_TOOLKIT_DEV ?? null,
    cwd: options.cwd ?? process.cwd(),
    env,
    opencodeConfig:
      options.opencodeConfig ?? path.join(home, ".config", "opencode", "opencode.json"),
    cursorSettings: options.cursorSettings ?? path.join(home, ".cursor", "settings.json"),
    cursorMcp: options.cursorMcp ?? path.join(home, ".cursor", "mcp.json"),
    cursorPluginDir:
      options.cursorPluginDir ?? path.join(home, ".cursor", "plugins", "local", "workflow-toolkit"),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

type Existing =
  | { kind: "missing" }
  | { kind: "malformed"; error: string }
  | { kind: "record"; value: Record<string, unknown>; raw: string };

// Platform config (opencode.json/settings.json/mcp.json) is NOT covered by the
// WZ-06 preview scan (which gates only the workit config dir), so a malformed
// file here must not be silently replaced with a fresh config (CA-14). Callers
// turn { kind: "malformed" } into a Failed entry and leave the file untouched.
const readExisting = (p: string): Existing => {
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return { kind: "missing" };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "malformed", error: `${p} is not valid JSON` };
  }
  if (isRecord(value)) return { kind: "record", value, raw };
  return { kind: "malformed", error: `${p} is not a JSON object` };
};

// Deep-merge preserves every unrelated key/value; arrays and scalars are
// replaced wholesale by the patch (the review is authoritative on its fields).
function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const prev = out[key];
    out[key] = isRecord(prev) && isRecord(value) ? deepMerge(prev, value) : value;
  }
  return out;
}

const readFileSafe = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

function applyMutation(m: SetupMutation): SetupResultEntry {
  const dir = path.dirname(m.path);
  switch (m.type) {
    case "create-file": {
      mkdirSync(dir, { recursive: true });
      const res = writeFileExclusive(m.path, m.content, m.mode);
      return res === "created"
        ? { platform: "core", file: m.path, status: "Installed" }
        : {
            platform: "core",
            file: m.path,
            status: "Skipped",
            detail: "file already exists — preserved",
          };
    }
    case "merge-json": {
      const existing = readExisting(m.path);
      if (existing.kind === "malformed") {
        return {
          platform: "core",
          file: m.path,
          status: "Failed",
          detail: `cannot merge into malformed config: ${existing.error}`,
        };
      }
      const merged =
        existing.kind === "record"
          ? deepMerge(existing.value, m.value as Record<string, unknown>)
          : (m.value as Record<string, unknown>);
      if (existing.kind === "record" && JSON.stringify(existing.value) === JSON.stringify(merged)) {
        return { platform: "core", file: m.path, status: "Skipped", detail: "already configured" };
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(m.path, JSON.stringify(merged, null, 2) + "\n", "utf8");
      return existing.kind === "record"
        ? { platform: "core", file: m.path, status: "Configured" }
        : { platform: "core", file: m.path, status: "Installed" };
    }
    case "update-workspaces": {
      // RL-08: a mutation built by a non-wizard caller still cannot write an
      // unsupported matcher pattern — reported Failed, never silently stored.
      for (const entry of m.entries) {
        if (!entry || typeof entry.glob !== "string") continue;
        const v = validateWorkspaceGlob(entry.glob);
        if (!v.ok) return { platform: "core", file: m.path, status: "Failed", detail: v.error };
      }
      const next = JSON.stringify({ workspaces: m.entries }, null, 2) + "\n";
      const prev = readFileSafe(m.path);
      if (prev === next)
        return { platform: "core", file: m.path, status: "Skipped", detail: "already configured" };
      mkdirSync(dir, { recursive: true });
      writeFileSync(m.path, next, "utf8");
      return prev === null
        ? { platform: "core", file: m.path, status: "Installed" }
        : { platform: "core", file: m.path, status: "Configured" };
    }
    case "append-gitignore": {
      const existing = readFileSafe(m.path) ?? "";
      const existingLines = new Set(
        existing
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      );
      const add = m.entries.filter((e) => e.trim() !== "" && !existingLines.has(e.trim()));
      if (add.length === 0) {
        return {
          platform: "core",
          file: m.path,
          status: "Skipped",
          detail: "all entries already present",
        };
      }
      mkdirSync(dir, { recursive: true });
      const separator = existing && !existing.endsWith("\n") ? "\n" : "";
      writeFileSync(
        m.path,
        existing + separator + (existing ? "\n" : "") + add.join("\n") + "\n",
        "utf8",
      );
      return {
        platform: "core",
        file: m.path,
        status: "Configured",
        detail: `appended ${add.length} entr${add.length === 1 ? "y" : "ies"}`,
      };
    }
  }
}

// Package-native adapter resolution: the packaged CLI/core resolve the adapter
// packages from the same install (node_modules sibling), a dev checkout
// (WORKFLOW_TOOLKIT_DEV / packages/workit-<host> walking up from cwd), or the
// share clone (~/.local/share/workflow-toolkit) — mirroring the install scripts.
const isAdapter = (root: string, platform: Platform): boolean => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      name?: string;
    };
    return pkg.name === `@brainervirus/workit-${platform}`;
  } catch {
    return false;
  }
};

function adapterRoot(platform: Platform, res: ResolvedApply): string | null {
  const candidates: string[] = [];
  if (res.dev) {
    // A dev checkout is the complete source of truth for adapter packages: when
    // WORKFLOW_TOOLKIT_DEV is set, a package missing from it is a real failure,
    // not a reason to fall through to the running process's own install.
    candidates.push(path.join(res.dev, "packages", `workit-${platform}`));
  } else {
    // node_modules sibling (packed install) or monorepo sibling (source)
    candidates.push(path.join(packageRoot(), "..", `workit-${platform}`));
    // dev checkout walking up from cwd
    let dir = path.resolve(res.cwd);
    while (true) {
      candidates.push(path.join(dir, "packages", `workit-${platform}`));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  candidates.push(
    path.join(res.home, ".local", "share", "workflow-toolkit", "packages", `workit-${platform}`),
  );
  for (const candidate of candidates) {
    if (isAdapter(candidate, platform)) return candidate;
  }
  return null;
}

const opencodePin = (root: string): string | null => {
  for (const rel of ["src/plugin.ts", "dist/plugin.js"]) {
    const entry = path.join(root, rel);
    if (existsSync(entry)) return `file://${entry}`;
  }
  return null;
};

function applyOpenCode(root: string, res: ResolvedApply): SetupResultEntry {
  const pin = opencodePin(root);
  if (!pin) {
    return {
      platform: "opencode",
      file: res.opencodeConfig,
      status: "Failed",
      detail:
        "workit-opencode package has no loadable plugin entry (src/plugin.ts or dist/plugin.js)",
    };
  }
  mkdirSync(path.dirname(res.opencodeConfig), { recursive: true });
  const existing = readExisting(res.opencodeConfig);
  if (existing.kind === "malformed") {
    return {
      platform: "opencode",
      file: res.opencodeConfig,
      status: "Failed",
      detail: `cannot merge into malformed config: ${existing.error} — repair or remove the file`,
    };
  }
  const merged = mergeOpenCodeConfig(existing.kind === "record" ? existing.value : {}, pin);
  if (merged.changed.length === 0) {
    return {
      platform: "opencode",
      file: res.opencodeConfig,
      status: "Skipped",
      detail: "already registered",
    };
  }
  writeFileSync(res.opencodeConfig, JSON.stringify(merged.config, null, 2) + "\n", "utf8");
  return existing.kind === "record"
    ? {
        platform: "opencode",
        file: res.opencodeConfig,
        status: "Configured",
        detail: `pinned ${pin}`,
      }
    : {
        platform: "opencode",
        file: res.opencodeConfig,
        status: "Installed",
        detail: `pinned ${pin}`,
      };
}

// Mirror the sync-runtime plugin mirror: copy the package (minus node_modules),
// keep launchers executable, and write the same `.workflow-toolkit-root` marker
// so a re-sync from the same source is a truthful Skipped.
function copyPluginDir(src: string, dest: string): SetupResultStatus {
  const marker = path.join(dest, ".workflow-toolkit-root");
  const synced = readFileSafe(marker)?.trim() === src;
  if (synced) return "Skipped";
  const hadDir = existsSync(dest);
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    // Exclude node_modules anywhere under the source (the package itself may
    // live under the install's node_modules, so the filter must be relative).
    filter: (s) => {
      const rel = path.relative(src, s);
      return !rel.split(path.sep).includes("node_modules");
    },
  });
  writeFileSync(marker, src + "\n", "utf8");
  for (const rel of ["hooks/session-start", "mcp/run-server.sh"]) {
    try {
      chmodSync(path.join(dest, rel), 0o755);
    } catch {
      /* optional launcher */
    }
  }
  return hadDir ? "Configured" : "Installed";
}

function applyCursor(root: string, res: ResolvedApply): SetupResultEntry[] {
  const entries: SetupResultEntry[] = [];
  const dirStatus = copyPluginDir(root, res.cursorPluginDir);
  entries.push({ platform: "cursor", file: res.cursorPluginDir, status: dirStatus });

  mkdirSync(path.dirname(res.cursorSettings), { recursive: true });
  const settingsExisting = readExisting(res.cursorSettings);
  if (settingsExisting.kind === "malformed") {
    entries.push({
      platform: "cursor",
      file: res.cursorSettings,
      status: "Failed",
      detail: `cannot merge into malformed config: ${settingsExisting.error} — repair or remove the file`,
    });
  } else {
    const settings = mergeCursorSettings(
      settingsExisting.kind === "record" ? settingsExisting.value : {},
      res.cursorPluginDir,
    );
    if (settings.changed.length > 0) {
      writeFileSync(res.cursorSettings, JSON.stringify(settings.config, null, 2) + "\n", "utf8");
      entries.push({
        platform: "cursor",
        file: res.cursorSettings,
        status: settingsExisting.kind === "record" ? "Configured" : "Installed",
      });
    } else {
      entries.push({
        platform: "cursor",
        file: res.cursorSettings,
        status: "Skipped",
        detail: "already registered",
      });
    }
  }

  mkdirSync(path.dirname(res.cursorMcp), { recursive: true });
  const mcpExisting = readExisting(res.cursorMcp);
  if (mcpExisting.kind === "malformed") {
    entries.push({
      platform: "cursor",
      file: res.cursorMcp,
      status: "Failed",
      detail: `cannot merge into malformed config: ${mcpExisting.error} — repair or remove the file`,
    });
  } else {
    const mcp = mergeCursorMcp(
      mcpExisting.kind === "record" ? mcpExisting.value : {},
      "workit",
      cursorMcpServerEntry(res.cursorPluginDir),
    );
    if (mcp.changed.length > 0) {
      writeFileSync(res.cursorMcp, JSON.stringify(mcp.config, null, 2) + "\n", "utf8");
      entries.push({
        platform: "cursor",
        file: res.cursorMcp,
        status: mcpExisting.kind === "record" ? "Configured" : "Installed",
      });
    } else {
      entries.push({
        platform: "cursor",
        file: res.cursorMcp,
        status: "Skipped",
        detail: "already registered",
      });
    }
  }

  return entries;
}

function verifyPlatform(platform: Platform, res: ResolvedApply): DoctorReport | null {
  if (platform === "opencode" && !existsSync(res.opencodeConfig)) return null;
  if (platform === "cursor" && !existsSync(res.cursorSettings) && !existsSync(res.cursorMcp)) {
    return null;
  }
  return runDoctor({
    host: platform,
    installer: true,
    home: res.home,
    configDir: res.configDir,
    stateDir: res.env.WORKFLOW_TOOLKIT_STATE,
    dev: res.dev ?? undefined,
    cwd: res.cwd,
    env: res.env,
    opencodeConfig: res.opencodeConfig,
    cursorSettings: res.cursorSettings,
    cursorMcp: res.cursorMcp,
    cursorPluginDir: res.cursorPluginDir,
  });
}

const failedDetail = (report: DoctorReport): string =>
  report.checks
    .filter((c) => c.status === "fail")
    .map((c) => `${c.id}: ${c.detail}`)
    .join("; ");

export function applySetupPreview(
  preview: SetupPreview,
  options: ApplySetupOptions = {},
): SetupResult {
  if (!preview.ok) {
    const malformed = [
      preview.state.config,
      preview.state.youtrack,
      preview.state.vcs,
      preview.state.workspaces,
    ].filter((s) => s.status === "malformed");
    return {
      ok: false,
      exitCode: 1,
      entries: malformed.map((s) => ({
        platform: "core" as const,
        file: s.file,
        status: "Failed" as const,
        detail: s.error ?? "apply blocked by malformed configuration",
      })),
      preserved: [],
      blocked: preview.blocked,
      doctor: [],
    };
  }

  const res = resolveApply(preview, options);
  const entries: SetupResultEntry[] = [];

  for (const mutation of preview.mutations) entries.push(applyMutation(mutation));
  for (const preserved of preview.preserved) {
    entries.push({
      platform: "core",
      file: preserved,
      status: "Skipped",
      detail: "existing credential preserved",
    });
  }

  const doctor: DoctorReport[] = [];
  for (const platform of preview.platforms) {
    if (platform !== "opencode" && platform !== "cursor") continue;
    const root = adapterRoot(platform, res);
    if (!root) {
      entries.push({
        platform,
        file: platform === "opencode" ? res.opencodeConfig : res.cursorSettings,
        status: "Failed",
        detail: `@brainervirus/workit-${platform} package not found — set WORKFLOW_TOOLKIT_DEV to your checkout or install the package`,
      });
      continue;
    }
    if (platform === "opencode") {
      const entry = applyOpenCode(root, res);
      entries.push(entry);
      if (entry.status !== "Failed") {
        const report = verifyPlatform(platform, res);
        if (report) {
          doctor.push(report);
          if (report.exitCode !== 0) {
            entry.status = "Failed";
            entry.detail = `${entry.detail ? entry.detail + " — " : ""}doctor: ${failedDetail(report)}`;
          }
        }
      }
    } else {
      for (const entry of applyCursor(root, res)) entries.push(entry);
      const report = verifyPlatform(platform, res);
      if (report) {
        doctor.push(report);
        if (report.exitCode !== 0) {
          const primary = entries.find(
            (e) => e.platform === "cursor" && e.file === res.cursorSettings,
          );
          if (primary) {
            primary.status = "Failed";
            primary.detail = `${primary.detail ? primary.detail + " — " : ""}doctor: ${failedDetail(report)}`;
          } else {
            entries.push({
              platform: "cursor",
              file: res.cursorSettings,
              status: "Failed",
              detail: `doctor: ${failedDetail(report)}`,
            });
          }
        }
      }
    }
  }

  const failed = entries.some((e) => e.status === "Failed");
  return {
    ok: !failed,
    exitCode: failed ? 1 : 0,
    entries,
    preserved: preview.preserved,
    blocked: [],
    doctor,
  };
}

// Completion guidance shown by the CLI after Apply (and on the non-TTY path):
// the doctor command + /wk-status are the next steps for verifying the result.
export const setupCompletionGuidance = (): string[] => [
  "Run `workit doctor` to verify your installation.",
  "Run /wk-status in OpenCode to review token setup steps.",
];
