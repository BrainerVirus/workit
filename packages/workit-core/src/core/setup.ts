import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  configDir,
  mergePreset,
  readConfigFromDir,
  resolveConfigDir,
  type BranchPreset,
} from "./config";
import { detectBranchPolicy } from "./branch-policy";
import { readSetupState, type SetupState } from "./setup-state";
import {
  loadWorkspacesFrom,
  matchWorkspace,
  readWorkspacesResult,
  validateWorkspaceGlob,
  type WorkspaceConfig,
} from "./workspaces";
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
  /** Deliberate token-path overrides. When they differ from an existing
   *  configured tokenFile, the replacement is planned as its own distinct
   *  reviewed mutation (AR-10). */
  tokenPaths?: { youtrack?: string; gitlab?: string; github?: string };
};

export type SetupMutation =
  | { type: "create-file"; path: string; content: string; mode?: number }
  | { type: "merge-json"; path: string; value: unknown }
  | { type: "update-workspaces"; path: string; entries: WorkspaceConfig[] }
  | { type: "append-gitignore"; path: string; entries: string[] }
  // AR-09: host registration merges and the adapter package copy are planned
  // during preview so the reviewed mutation set IS the Apply write set.
  | { type: "register-platform"; platform: Platform; path: string }
  | { type: "install-adapter"; platform: "cursor"; path: string }
  // AR-10: changing a configured tokenFile path is never hidden inside a
  // generic merge — it is its own reviewed mutation.
  | { type: "set-token-path"; path: string; key: string; value: string };

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
// The tokenFile is the RESOLVED path (existing configured path reused, override
// honored) — a default path never silently replaces a custom one (AR-10).
function youtrackDraft(values: SetupPreviewInput, tokenPath: string): Record<string, unknown> {
  return {
    baseUrl: values.baseUrl.replace(/\/+$/, ""),
    tokenFile: tokenPath,
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

function vcsDraft(
  provider: VcsProvider,
  gitlabToken: string,
  githubToken: string,
): Record<string, unknown> {
  return {
    provider,
    gitlab: {
      host: "gitlab.com",
      apiUrl: "https://gitlab.com/api/v4",
      tokenFile: gitlabToken,
    },
    github: { host: "github.com", tokenFile: githubToken },
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

// Resolve the token file for a service: an explicit override wins, then the
// configured tokenFile from an existing valid config, then the default path.
// Reuse means a custom credential location stays authoritative (AR-10).
const configuredTokenPath = (
  config: Record<string, unknown> | null,
  ...keys: string[]
): string | null => {
  let cursor: unknown = config;
  for (const key of keys) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[key];
  }
  if (typeof cursor === "string" && cursor.trim() !== "") return cursor;
  return null;
};

const resolveTokenPath = (
  configured: string | null,
  fallback: string,
  override?: string,
): string => {
  if (override && override.trim() !== "") return override;
  return configured ?? fallback;
};

// Read a config file that readSetupState already classified as valid. Only
// called inside the blocked.length === 0 branch, so unreadable/malformed files
// never reach here; a missing file returns null.
const readConfigRecord = (file: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

const deleteAtPath = (obj: Record<string, unknown>, keyPath: string): void => {
  const keys = keyPath.split(".");
  let cursor = obj;
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key];
    if (!isRecord(next)) return;
    cursor = next;
  }
  delete cursor[keys[keys.length - 1]];
};

export function buildSetupPreview(
  values: SetupPreviewInput,
  opts: SetupPreviewOptions = {},
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
      const ytPath = path.join(state.configDir, "youtrack.json");
      const ytExisting = readConfigRecord(ytPath);
      const ytConfigured = configuredTokenPath(ytExisting, "tokenFile");
      const tokenPath = resolveTokenPath(
        ytConfigured,
        path.join(state.configDir, "youtrack.token"),
        values.tokenPaths?.youtrack,
      );
      const draft = youtrackDraft(values, tokenPath);
      if (ytConfigured !== null && tokenPath !== ytConfigured) {
        // AR-10: a real tokenFile replacement is its own reviewed mutation —
        // never hidden inside the generic config merge.
        delete draft.tokenFile;
        mutations.push({
          type: "set-token-path",
          path: ytPath,
          key: "tokenFile",
          value: tokenPath,
        });
      }
      mutations.push({
        type: "merge-json",
        path: ytPath,
        value: draft,
      });
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
      const vcsPath = path.join(state.configDir, "vcs.json");
      const vcsExisting = readConfigRecord(vcsPath);
      const glConfigured = configuredTokenPath(vcsExisting, "gitlab", "tokenFile");
      const ghConfigured = configuredTokenPath(vcsExisting, "github", "tokenFile");
      const gitlabToken = resolveTokenPath(
        glConfigured,
        path.join(state.configDir, "gitlab.token"),
        values.tokenPaths?.gitlab,
      );
      const githubToken = resolveTokenPath(
        ghConfigured,
        path.join(state.configDir, "github.token"),
        values.tokenPaths?.github,
      );
      const draft = vcsDraft(values.vcsProvider, gitlabToken, githubToken);
      for (const [configured, token, key] of [
        [glConfigured, gitlabToken, "gitlab.tokenFile"],
        [ghConfigured, githubToken, "github.tokenFile"],
      ] as const) {
        if (configured !== null && token !== configured) {
          deleteAtPath(draft, key);
          mutations.push({
            type: "set-token-path",
            path: vcsPath,
            key,
            value: token,
          });
        }
      }
      mutations.push({
        type: "merge-json",
        path: vcsPath,
        value: draft,
      });
      const activeToken = values.vcsProvider === "gitlab" ? gitlabToken : githubToken;
      if (existsSync(activeToken)) preserved.push(activeToken);
      else
        mutations.push({
          type: "create-file",
          path: activeToken,
          content: TOKEN_PLACEHOLDER + "\n",
          mode: 0o600,
        });
    }

    // AR-09: host registrations and the adapter package copy are planned here
    // with the exact target paths Apply will write, so the reviewed mutation
    // set IS the Apply write set. Apply re-resolves the adapter SOURCE with
    // its own options (dev/cwd) — a resolution failure reports Failed without
    // writing, it never creates an unreviewed write.
    const platforms = values.platforms ?? [];
    if (platforms.length > 0) {
      const paths = resolveSetupPaths(opts, state.configDir);
      for (const platform of platforms) {
        if (platform === "opencode") {
          mutations.push({ type: "register-platform", platform, path: paths.opencodeConfig });
        } else if (platform === "cursor") {
          mutations.push({ type: "install-adapter", platform, path: paths.cursorPluginDir });
          mutations.push({ type: "register-platform", platform, path: paths.cursorSettings });
          mutations.push({ type: "register-platform", platform, path: paths.cursorMcp });
        }
      }
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

export type SetupPreviewOptions = ApplySetupOptions & { dir?: string };

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

// Shared path resolution for preview AND apply: the preview plans the platform
// write targets with the same resolution apply uses, so the mutation paths ARE
// the apply write paths (AR-09). Callers must build the preview and apply with
// the same options (defaulting both from env) — tests pass `home` explicitly.
const resolveSetupPaths = (
  options: ApplySetupOptions,
  configDir: string,
): Omit<ResolvedApply, "dev"> => {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? os.homedir();
  return {
    home,
    configDir,
    cwd: options.cwd ?? process.cwd(),
    env,
    opencodeConfig:
      options.opencodeConfig ?? path.join(home, ".config", "opencode", "opencode.json"),
    cursorSettings: options.cursorSettings ?? path.join(home, ".cursor", "settings.json"),
    cursorMcp: options.cursorMcp ?? path.join(home, ".cursor", "mcp.json"),
    cursorPluginDir:
      options.cursorPluginDir ?? path.join(home, ".cursor", "plugins", "local", "workflow-toolkit"),
  };
};

function resolveApply(preview: SetupPreview, options: ApplySetupOptions): ResolvedApply {
  const paths = resolveSetupPaths(options, options.configDir ?? preview.state.configDir);
  return {
    ...paths,
    dev: options.dev ?? paths.env.WORKFLOW_TOOLKIT_DEV ?? null,
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
    // A read-permission error (EACCES) must not look like a missing file: a
    // write attempt would throw after partially touching the filesystem.
    // Classify it malformed so callers report Failed with the path untouched.
    if (existsSync(p)) return { kind: "malformed", error: `${p} is not readable` };
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

// Core mutations are dispatched by applyMutation; platform mutations
// (register-platform / install-adapter) are handled by the dispatcher with
// adapter resolution (AR-09).
type CoreMutation = Exclude<
  SetupMutation,
  { type: "register-platform" } | { type: "install-adapter" }
>;

function applyMutation(m: CoreMutation): SetupResultEntry {
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
    case "set-token-path": {
      // AR-10: a reviewed tokenFile replacement. Writes ONLY the config key at
      // the key path — the token file itself is a separate create-file or
      // preserved entry, and any file at the old path is never touched.
      const existing = readExisting(m.path);
      if (existing.kind === "malformed") {
        return {
          platform: "core",
          file: m.path,
          status: "Failed",
          detail: `cannot merge into malformed config: ${existing.error}`,
        };
      }
      const keys = m.key.split(".");
      const patch: Record<string, unknown> = {};
      let cursor = patch;
      for (const key of keys.slice(0, -1)) {
        const next: Record<string, unknown> = {};
        cursor[key] = next;
        cursor = next;
      }
      cursor[keys[keys.length - 1]] = m.value;
      const merged = deepMerge(existing.kind === "record" ? existing.value : {}, patch);
      if (existing.kind === "record" && JSON.stringify(existing.value) === JSON.stringify(merged)) {
        return {
          platform: "core",
          file: m.path,
          status: "Skipped",
          detail: "already configured",
        };
      }
      mkdirSync(path.dirname(m.path), { recursive: true });
      writeFileSync(m.path, JSON.stringify(merged, null, 2) + "\n", "utf8");
      return existing.kind === "record"
        ? { platform: "core", file: m.path, status: "Configured" }
        : { platform: "core", file: m.path, status: "Installed" };
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
//
// The installed plugin's mcp.json is a derived artifact: the shipped manifest
// stays package-relative (PT-10), but Cursor spawns plugin MCP servers with
// the workspace as cwd, so the installed copy must carry an absolute entry.
const cursorMcpManifest = (dir: string): string =>
  JSON.stringify({ mcpServers: { workit: cursorMcpServerEntry(dir) } }, null, 2) + "\n";

const samePluginContent = (src: string, dest: string, relative = ""): boolean => {
  try {
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      // mcp.json is derived at install time (cursorMcpManifest), not copied.
      if (relative === "" && entry.name === "mcp.json") continue;
      const source = path.join(src, entry.name);
      const installed = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        if (
          !statSync(installed).isDirectory() ||
          !samePluginContent(source, installed, path.join(relative, entry.name))
        )
          return false;
      } else if (!readFileSync(source).equals(readFileSync(installed))) {
        return false;
      }
    }
    for (const entry of readdirSync(dest, { withFileTypes: true })) {
      if (existsSync(path.join(src, entry.name))) continue;
      const rel = path.join(relative, entry.name);
      if (rel === ".workflow-toolkit-root") continue;
      if (relative === "rules" && entry.isFile() && entry.name.endsWith(".mdc")) continue;
      if (relative === "" && entry.name === "mcp.json") continue;
      return false;
    }
    return true;
  } catch {
    return false;
  }
};

const preservedCursorRules = (src: string, dest: string): Map<string, Buffer> => {
  const preserved = new Map<string, Buffer>();
  const sourceRules = path.join(src, "rules");
  const installedRules = path.join(dest, "rules");
  try {
    for (const entry of readdirSync(installedRules, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".mdc")) continue;
      if (existsSync(path.join(sourceRules, entry.name))) continue;
      preserved.set(entry.name, readFileSync(path.join(installedRules, entry.name)));
    }
  } catch {
    /* no compiled user rules */
  }
  return preserved;
};

function copyPluginDir(src: string, dest: string): SetupResultStatus {
  const marker = path.join(dest, ".workflow-toolkit-root");
  const synced =
    readFileSafe(marker)?.trim() === src &&
    samePluginContent(src, dest) &&
    // The mcp.json equality makes the Skipped verdict truthful: the derived
    // manifest on disk must be the one this install would write.
    readFileSafe(path.join(dest, "mcp.json")) === cursorMcpManifest(dest);
  if (synced) return "Skipped";
  const hadDir = existsSync(dest);
  const rules = preservedCursorRules(src, dest);
  const parent = path.dirname(dest);
  mkdirSync(parent, { recursive: true });
  const swap = mkdtempSync(path.join(parent, `.${path.basename(dest)}.swap-`));
  const stage = path.join(swap, "stage");
  const backup = path.join(swap, "backup");
  try {
    cpSync(src, stage, {
      recursive: true,
      filter: (entry) => !path.relative(src, entry).split(path.sep).includes("node_modules"),
    });
    for (const [name, content] of rules) {
      mkdirSync(path.join(stage, "rules"), { recursive: true });
      writeFileSync(path.join(stage, "rules", name), content);
    }
    writeFileSync(path.join(stage, ".workflow-toolkit-root"), src + "\n", "utf8");
    for (const rel of ["hooks/session-start", "mcp/run-server.sh"]) {
      try {
        chmodSync(path.join(stage, rel), 0o755);
      } catch {
        /* optional launcher */
      }
    }
    if (!samePluginContent(src, stage)) throw new Error("staged adapter content is incomplete");
    if (hadDir) renameSync(dest, backup);
    try {
      renameSync(stage, dest);
    } catch (error) {
      if (hadDir && !existsSync(dest)) renameSync(backup, dest);
      throw error;
    }
    // Derive the installed manifest against the FINAL installed path: the
    // stage path dies with the swap dir, and the entry's dist check needs the
    // live plugin dir to exist.
    writeFileSync(path.join(dest, "mcp.json"), cursorMcpManifest(dest), "utf8");
    rmSync(backup, { recursive: true, force: true });
  } finally {
    rmSync(swap, { recursive: true, force: true });
  }
  return hadDir ? "Configured" : "Installed";
}

// One reviewed mutation per Cursor write target (AR-09): the settings merge and
// the mcp merge are dispatched independently, exactly like the adapter copy.
function applyCursorSettings(root: string, res: ResolvedApply): SetupResultEntry {
  mkdirSync(path.dirname(res.cursorSettings), { recursive: true });
  const settingsExisting = readExisting(res.cursorSettings);
  if (settingsExisting.kind === "malformed") {
    return {
      platform: "cursor",
      file: res.cursorSettings,
      status: "Failed",
      detail: `cannot merge into malformed config: ${settingsExisting.error} — repair or remove the file`,
    };
  }
  const settings = mergeCursorSettings(
    settingsExisting.kind === "record" ? settingsExisting.value : {},
    res.cursorPluginDir,
  );
  if (settings.changed.length === 0) {
    return {
      platform: "cursor",
      file: res.cursorSettings,
      status: "Skipped",
      detail: "already registered",
    };
  }
  writeFileSync(res.cursorSettings, JSON.stringify(settings.config, null, 2) + "\n", "utf8");
  return {
    platform: "cursor",
    file: res.cursorSettings,
    status: settingsExisting.kind === "record" ? "Configured" : "Installed",
  };
}

function applyCursorMcp(root: string, res: ResolvedApply): SetupResultEntry {
  mkdirSync(path.dirname(res.cursorMcp), { recursive: true });
  const mcpExisting = readExisting(res.cursorMcp);
  if (mcpExisting.kind === "malformed") {
    return {
      platform: "cursor",
      file: res.cursorMcp,
      status: "Failed",
      detail: `cannot merge into malformed config: ${mcpExisting.error} — repair or remove the file`,
    };
  }
  const mcp = mergeCursorMcp(
    mcpExisting.kind === "record" ? mcpExisting.value : {},
    "workit",
    cursorMcpServerEntry(res.cursorPluginDir),
  );
  if (mcp.changed.length === 0) {
    return {
      platform: "cursor",
      file: res.cursorMcp,
      status: "Skipped",
      detail: "already registered",
    };
  }
  writeFileSync(res.cursorMcp, JSON.stringify(mcp.config, null, 2) + "\n", "utf8");
  return {
    platform: "cursor",
    file: res.cursorMcp,
    status: mcpExisting.kind === "record" ? "Configured" : "Installed",
  };
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
  // AR-09/AR-13: Apply dispatches ONLY the reviewed mutation union. The adapter
  // source is re-resolved with the apply options (dev/cwd); a resolution
  // failure reports Failed without writing — it never produces a write that
  // was not previewed. The reviewed path itself is code-enforced: a platform
  // mutation whose planned path does not exactly equal the apply-time resolved
  // path (a caller that resolved the preview with different options) fails
  // fast — Failed, no write — instead of silently writing an unreviewed path.
  const rootFor = new Map<Platform, string | null>();
  for (const mutation of preview.mutations) {
    if (mutation.type !== "register-platform" && mutation.type !== "install-adapter") {
      entries.push(applyMutation(mutation));
      continue;
    }
    const platform = mutation.platform;
    const resolvedPath =
      mutation.type === "install-adapter"
        ? res.cursorPluginDir
        : platform === "opencode"
          ? res.opencodeConfig
          : mutation.path === res.cursorSettings
            ? res.cursorSettings
            : res.cursorMcp;
    if (mutation.path !== resolvedPath) {
      entries.push({
        platform,
        file: mutation.path,
        status: "Failed",
        detail: `preview/apply path mismatch: apply resolved ${resolvedPath}, the previewed write was ${mutation.path} — rebuild the preview with the same options`,
      });
      continue;
    }
    let root = rootFor.get(platform);
    if (root === undefined) {
      root = adapterRoot(platform, res);
      rootFor.set(platform, root);
    }
    if (root === null) {
      entries.push({
        platform,
        file: mutation.path,
        status: "Failed",
        detail: `@brainervirus/workit-${platform} package not found — set WORKFLOW_TOOLKIT_DEV to your checkout or install the package`,
      });
      continue;
    }
    if (mutation.type === "install-adapter") {
      try {
        entries.push({ platform, file: mutation.path, status: copyPluginDir(root, mutation.path) });
      } catch (error) {
        entries.push({
          platform,
          file: mutation.path,
          status: "Failed",
          detail: `adapter install failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } else if (platform === "opencode") {
      entries.push(applyOpenCode(root, res));
    } else {
      entries.push(
        mutation.path === res.cursorSettings
          ? applyCursorSettings(root, res)
          : applyCursorMcp(root, res),
      );
    }
  }
  for (const preserved of preview.preserved) {
    entries.push({
      platform: "core",
      file: preserved,
      status: "Skipped",
      detail: "existing credential preserved",
    });
  }

  // Post-apply verification per platform (read-only): a registered host whose
  // writes succeeded is verified by the shared offline doctor.
  const doctor: DoctorReport[] = [];
  for (const platform of preview.platforms) {
    if (platform !== "opencode" && platform !== "cursor") continue;
    const root = rootFor.get(platform);
    if (root === null || root === undefined) continue;
    if (!entries.some((e) => e.platform === platform && e.status !== "Failed")) continue;
    const report = verifyPlatform(platform, res);
    if (!report) continue;
    doctor.push(report);
    if (report.exitCode === 0) continue;
    if (platform === "opencode") {
      const entry = entries.find((e) => e.platform === "opencode" && e.file === res.opencodeConfig);
      if (entry) {
        entry.status = "Failed";
        entry.detail = `${entry.detail ? entry.detail + " — " : ""}doctor: ${failedDetail(report)}`;
      }
    } else {
      const primary = entries.find((e) => e.platform === "cursor" && e.file === res.cursorSettings);
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

// Shared per-workspace branch policy writer (CA-06): the initApplyData
// branch_policy action (OpenCode/Cursor) and the Task 5 wizard both route
// through this proposal→write path, so the written bytes are identical. The
// write is idempotent: a matching entry is reported already-configured without
// touching the file; an existing entry is updated; otherwise appended.
export function applyWorkspaceBranchPolicy(opts: {
  workspace_root: string;
  env?: NodeJS.ProcessEnv;
}): Record<string, any> {
  const { workspace_root, env = process.env } = opts;
  const dir = path.join(env.WORKFLOW_TOOLKIT_CONFIG ?? configDir());
  const { status, path: wsPath, entries } = readWorkspacesResult(dir);
  if (status === "malformed") return { ok: false, error: `malformed workspaces.json: ${wsPath}` };
  const detection = detectBranchPolicy(workspace_root);
  const name = String(env.WORKFLOW_BP_NAME ?? path.basename(workspace_root));
  const integration = (env.WORKFLOW_BP_INTEGRATION ?? detection.integration) as "pr" | "merge";
  const policy = {
    preset: detection.preset,
    developBranch: env.WORKFLOW_BP_DEVELOP ?? detection.developBranch ?? undefined,
    prefixes: detection.prefixes,
    allowed: detection.allowed,
    protected: detection.protected,
    integration,
  };
  const glob = `${workspace_root.replace(/[\\/]+$/, "")}/**`;
  if (!validateWorkspaceGlob(glob).ok)
    return { ok: false, error: `invalid workspace glob: ${glob}` };
  const idx = entries.findIndex((w) => matchWorkspace(w.glob, workspace_root));
  const existing = idx >= 0 ? entries[idx] : null;
  if (existing?.branchPolicy && isDeepStrictEqual(existing.branchPolicy, policy)) {
    return {
      ok: true,
      status: "already-configured",
      workspace: existing,
      policy,
      config_path: wsPath,
    };
  }
  const next = existing
    ? entries.map((w, i) => (i === idx ? { ...w, branchPolicy: policy } : w))
    : [...entries, { name, glob, branchPolicy: policy }];
  mkdirSync(path.dirname(wsPath), { recursive: true });
  writeFileSync(wsPath, JSON.stringify({ workspaces: next }, null, 2) + "\n", "utf8");
  return {
    ok: true,
    status: existing ? "updated" : "configured",
    workspace: existing
      ? { ...existing, branchPolicy: policy }
      : { name, glob, branchPolicy: policy },
    policy,
    config_path: wsPath,
  };
}
