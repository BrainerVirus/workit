import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { recordHookNode } from "./hook-node";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  mergePreset,
  readConfigFromDir,
  resolveConfigDir,
  type BranchPreset,
  type ToolkitConfig,
} from "@workit-dev/core/src/core/config";
import { readSetupState, type SetupState } from "./setup-state";
import {
  readWorkspacesResult,
  validateWorkspacesDocument,
  validateWorkspaceGlob,
  workspacesRevision,
  type WorkspaceConfig,
} from "@workit-dev/core/src/core/workspaces";
import { isConfigSchemaFile, withSchemaRef } from "@workit-dev/core/src/core/config-schemas";
import { GITIGNORE_ENTRIES } from "@workit-dev/core/src/core/gitignore";
import { planHygieneFiles, projectTarget } from "@workit-dev/core/src/core/hygiene";
import { packageRoot } from "@workit-dev/core/src/core/package-root";
import {
  cursorHooksEntry,
  cursorMcpServerEntry,
  CURSOR_RUNTIME_PACKAGE,
  isWorkitPlugin,
  mergeCursorHooks,
  mergeCursorMcp,
  mergeCursorSettings,
  mergeOpenCodeConfig,
  OPENCODE_NPM_PIN,
} from "./registration";
import { runDoctor, type DoctorReport } from "./doctor";
import { sealAfterWrite, sealBefore } from "@workit-dev/core/src/autonomy";
import { SEAL_COMMAND } from "@workit-dev/core/src/core/grant-seal";
import { agentMarker } from "../upgrade/agent-marker";
import { CODEX_MARKETPLACE } from "../upgrade/codex-marketplace";
import { writeFileExclusive } from "@workit-dev/core/src/core/safe-write";
import {
  findYtrack,
  ytrackHostName,
  ytrackLogin,
  ytrackMissingUnblock,
  ytrackReadiness,
  ytrackAuthPathsArgs,
  ytrackRunner,
} from "@workit-dev/core/src/core/youtrack-ytrack";
import {
  pathWants,
  reviewYtrackPaths,
  type PathFix,
} from "@workit-dev/core/src/core/youtrack-paths";

import {
  isCodexWorkitInstalled,
  isPiWorkitInstalled,
  isClaudeWorkitInstalled,
  claudeConfigDir,
  openCodeInstalledPlugin,
  claudeRegistryProblem,
  hostFileProblem,
  piSettingsProblem,
  piWorkitPackage,
  planHostInstall,
  runHostInstall,
  type HostCommandRunner,
  type HostId,
  type HostInstallCommand,
  runHostCommand,
} from "./host-install";

// Setup preview + apply (WZ-04-WZ-09, WZ-13-WZ-15; CA-12, CA-14, CA-22, CA-23).
// buildSetupPreview is a pure reader: it classifies the current setup state and
// returns the exact mutations Apply would perform WITHOUT applying them, so the
// preview is authoritative and nothing touches the filesystem before Apply.
// applySetupPreview applies ONLY the reviewed mutations using package-native
// registration/assets, reports every platform/file independently, preserves
// unrelated user config byte-for-byte, and verifies the result with the shared
// offline doctor. Integrations are neutral and optional: youtrack is skipped
// when baseUrl is empty, vcs when the provider is "skip".

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
  branchPreset: BranchPreset;
  branchAllowed: string;
  branchProtected: string;
  baseUrl: string;
  vcsProvider: VcsProvider | "skip";
  workspaces: WorkspaceConfig[];
  applyProject: boolean;
  /** Optional global commit policy used as the base for repository overrides. */
  commitPolicy?: ToolkitConfig["commitPolicy"];
};

export type SetupMutation =
  | { type: "create-file"; path: string; content: string; mode?: number }
  | { type: "merge-json"; path: string; value: unknown }
  | {
      type: "update-workspaces";
      path: string;
      entries: WorkspaceConfig[];
      expectedRevision: string;
    }
  | { type: "append-gitignore"; path: string; entries: string[] }
  // AR-09: host registration merges and the adapter package copy are planned
  // during preview so the reviewed mutation set IS the Apply write set.
  | { type: "register-platform"; platform: Platform; path: string }
  | { type: "install-adapter"; platform: "cursor"; path: string }
  | {
      type: "install-host";
      platform: HostId;
      path: string;
      commands: HostInstallCommand[];
    };

type SetupOverride = {
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
  /** Credential files left byte-for-byte untouched: a legacy youtrack.token,
   *  which Workit no longer reads. */
  preserved: string[];
  /** With YouTrack enabled: whether ytrack is on PATH, and the command that
   *  unblocks it (install, or log in to the configured host). Apply checks
   *  the login itself. */
  ytrack?: { onPath: boolean; host: string; unblock: string };
  /**
   * ytrack's folder-to-host map for each workspace with a YouTrack baseUrl:
   * the `ytrack auth paths --add` calls Apply runs, or why none can be planned
   * (an older ytrack without `auth paths`, or its map unreadable).
   */
  ytrackPaths?: { planned: PathFix[] } | { skipped: string; unblock: string };
  /** Selected platform adapters to register on Apply (WZ-09). */
  platforms: string[];
  state: SetupState;
  /** Project files were requested outside a git repository: nothing is
   *  planned there, and this names the way out (`cd <repo>`). */
  projectRefused?: string;
};

const YT_OVERRIDES: { envKey: string; affects: string }[] = [
  { envKey: "WORKIT_YT_BASE_URL", affects: "youtrack.json baseUrl" },
  { envKey: "WORKIT_YT_MEETING_ISSUE", affects: "youtrack.json meetingIssue" },
  { envKey: "WORKIT_YT_WEB_MEETING_ISSUE", affects: "youtrack.json web meeting issue" },
];

const VCS_OVERRIDES: { envKey: string; affects: string }[] = [
  { envKey: "WORKIT_VCS_PROVIDER", affects: "vcs.json provider" },
  { envKey: "WORKIT_VCS_TARGET_BRANCH", affects: "vcs.json defaultTargetBranch" },
  { envKey: "WORKIT_GITLAB_HOST", affects: "vcs.json gitlab.host" },
  { envKey: "WORKIT_GITLAB_API_URL", affects: "vcs.json gitlab.apiUrl" },
  { envKey: "WORKIT_GITHUB_HOST", affects: "vcs.json github.host" },
];

const SETUP_OVERRIDES = [...YT_OVERRIDES, ...VCS_OVERRIDES];

const activeSetupOverrides = (env: NodeJS.ProcessEnv = process.env): SetupOverride[] => {
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
// language defaults (WZ-04/CA-14), and no token: YouTrack goes through ytrack.
// merge-json preserves unrelated keys on Apply.
function youtrackDraft(values: SetupPreviewInput): Record<string, unknown> {
  return { baseUrl: values.baseUrl.replace(/\/+$/, ""), locale: values.locale };
}

function vcsDraft(provider: VcsProvider): Record<string, unknown> {
  return {
    provider,
    gitlab: {
      host: "gitlab.com",
      apiUrl: "https://gitlab.com/api/v4",
    },
    github: { host: "github.com" },
    pr: { squashOnMerge: true, removeSourceBranch: true, pushBranch: true, confirmSkip: true },
  };
}

// A legacy youtrack.token (youtrack.json's tokenFile, else the default path):
// only its existence is checked, never its contents.
const legacyYouTrackToken = (
  config: Record<string, unknown> | null,
  configDir: string,
): string | null => {
  const configured = typeof config?.tokenFile === "string" ? config.tokenFile.trim() : "";
  const file = configured
    ? path.resolve(configDir, configured)
    : path.join(configDir, "youtrack.token");
  return existsSync(file) ? file : null;
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

export function buildSetupPreview(
  values: SetupPreviewInput,
  opts: SetupPreviewOptions = {},
): SetupPreview {
  const env = opts.env ?? process.env;
  const state = readSetupState(opts.dir ?? resolveConfigDir());
  const blocked: string[] = [];
  const mutations: SetupMutation[] = [];
  const preserved: string[] = [];
  let projectRefused: string | undefined;
  let ytrack: SetupPreview["ytrack"];
  let paths: SetupPreview["ytrackPaths"];
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
        ...(values.commitPolicy === undefined ? {} : { commitPolicy: values.commitPolicy }),
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
    const diskWorkspaceResult = readWorkspacesResult(state.configDir);
    const diskWorkspaces = diskWorkspaceResult.entries;
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
          expectedRevision: diskWorkspaceResult.revision!,
        });
      }
    }

    if (values.baseUrl.trim()) {
      const ytPath = path.join(state.configDir, "youtrack.json");
      const ytExisting = readConfigRecord(ytPath);
      mutations.push({
        type: "merge-json",
        path: ytPath,
        value: youtrackDraft(values),
      });
      const legacy = legacyYouTrackToken(ytExisting, state.configDir);
      if (legacy) preserved.push(legacy);
      const host = ytrackHostName(values.baseUrl);
      const onPath = findYtrack(env) !== null;
      ytrack = {
        onPath,
        host,
        unblock: onPath ? ytrackLogin(host) : ytrackMissingUnblock(host),
      };
    }

    const ytrackPaths = planYtrackPaths(values.workspaces, env);
    if (ytrackPaths) paths = ytrackPaths;

    if (values.vcsProvider !== "skip") {
      const vcsPath = path.join(state.configDir, "vcs.json");
      mutations.push({
        type: "merge-json",
        path: vcsPath,
        value: vcsDraft(values.vcsProvider),
      });
    }

    // AR-09: host registrations and the adapter package copy are planned here
    // with the exact target paths Apply will write, so the reviewed mutation
    // set IS the Apply write set. Apply re-resolves the adapter SOURCE with
    // its own options (dev/cwd) — a resolution failure reports Failed without
    // writing, it never creates an unreviewed write.
    const platforms = values.platforms ?? [];
    if (platforms.length > 0) {
      const res = {
        ...resolveSetupPaths(opts, state.configDir),
        dev: opts.dev ?? env.WORKIT_DEV ?? null,
      };
      for (const platform of platforms) mutations.push(...platformMutations(platform, res));
    }

    const target = values.applyProject ? projectTarget(opts.cwd ?? process.cwd()) : null;
    if (target && !target.ok) projectRefused = target.refused;
    if (target?.ok) {
      const root = target.root;
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
    ...(ytrack ? { ytrack } : {}),
    ...(paths ? { ytrackPaths: paths } : {}),
    platforms: values.platforms ?? [],
    state,
    ...(projectRefused === undefined ? {} : { projectRefused }),
  };
}

// ---------------------------------------------------------------------------
// One host's install or repair with no Workit config change (#423): the
// planner a per-host install verb, `doctor --fix` and `upgrade` call.
// ---------------------------------------------------------------------------

/** What applying a host-only plan changes, shown before it runs. */
export type HostInstallDiff = {
  /** Files and directories written: host config and plugin files only. */
  files: string[];
  /** Config keys changed, as `<file>: <key>`. */
  keys: string[];
  /** Host commands in order, as their argv (never run through a shell). */
  commands: string[];
};

export type HostOnlyInstallPlan = {
  host: HostId;
  /** This host's install mutations only; none when the host is healthy. */
  preview: SetupPreview;
  diff: HostInstallDiff;
  /** What this path leaves to the host or the user. */
  notes: string[];
};

type HostOnlyInstallOptions = SetupPreviewOptions & {
  /** The npm version Cursor's download and a new Pi install pin; default latest. */
  packageVersion?: string;
  /** Pi: the Workit package root `pi list` named, when known. */
  piPackageRoot?: string | null;
};

const describeMutations = (
  mutations: SetupMutation[],
  res: ResolvedApply,
  opencodeRoot: string | null,
): HostInstallDiff => {
  const diff: HostInstallDiff = { files: [], keys: [], commands: [] };
  for (const mutation of mutations) {
    if (mutation.type === "install-host")
      diff.commands.push(
        ...mutation.commands.map((step) => [step.command, ...step.args].join(" ")),
      );
    if (
      mutation.type !== "install-host" &&
      mutation.type !== "install-adapter" &&
      mutation.type !== "register-platform"
    )
      continue;
    diff.files.push(mutation.path);
    if (mutation.type !== "register-platform") continue;
    const registration =
      mutation.platform === "opencode"
        ? opencodeRegistration(opencodeRoot, res)
        : mutation.path === res.cursorSettings
          ? cursorSettingsRegistration(res)
          : cursorMcpRegistration(res);
    if (!("error" in registration))
      diff.keys.push(...registration.merged.changed.map((key) => `${mutation.path}: ${key}`));
  }
  return diff;
};

const registered = (registration: Registration): boolean =>
  registration.existing.kind === "record" && registration.merged.changed.length === 0;

/** Cursor is healthy when its plugin dir holds the adapter (the resolved source's
 *  content, or the requested version) and settings and mcp.json register it. */
const cursorHealthy = (res: ResolvedApply, opts: HostOnlyInstallOptions): boolean => {
  const installed = path.join(res.cursorPluginDir, "package.json");
  if (!isAdapter(res.cursorPluginDir, "cursor") || lstatSync(res.cursorPluginDir).isSymbolicLink())
    return false;
  const root = adapterRoot("cursor", res, opts.preferInstalledAdapter);
  if (root !== null && !samePluginContent(root, res.cursorPluginDir, res.cursorPluginDir))
    return false;
  const wanted = opts.packageVersion;
  if (
    root === null &&
    wanted &&
    wanted !== "latest" &&
    readConfigRecord(installed)?.version !== wanted
  )
    return false;
  return registered(cursorSettingsRegistration(res)) && registered(cursorMcpRegistration(res));
};

const HOST_IDS: readonly HostId[] = ["claude-code", "opencode", "codex", "cursor", "pi"];

/** A host id the host-only planner does not know: never read as "already healthy". */
class UnknownHostError extends Error {
  override name = "UnknownHostError";
  constructor(host: string) {
    super(`unknown host "${host}"; valid hosts: ${HOST_IDS.join(", ")}`);
  }
}

/**
 * Plan the install, or the repair, of one host's Workit plugin: its plugin
 * files, its own config keys and its native commands, never the Workit config,
 * workspaces, project files or another host. A healthy host plans nothing, so
 * applying twice changes nothing. Read-only; apply with applySetupPreview and
 * the same options. Throws UnknownHostError for a host id it does not know.
 */
export function planHostOnlyInstall(
  host: HostId,
  opts: HostOnlyInstallOptions = {},
): HostOnlyInstallPlan {
  if (!HOST_IDS.includes(host)) throw new UnknownHostError(host);
  const env = opts.env ?? process.env;
  const state = readSetupState(opts.dir ?? opts.configDir ?? resolveConfigDir());
  const res: ResolvedApply = {
    ...resolveSetupPaths(opts, state.configDir),
    dev: opts.dev ?? env.WORKIT_DEV ?? null,
  };
  const notes: string[] = [];
  let opencodeRoot: string | null = null;
  const plan = (mutations: SetupMutation[], blocked: string[] = []): HostOnlyInstallPlan => ({
    host,
    preview: {
      ok: blocked.length === 0,
      blocked,
      mutations,
      overrides: [],
      preserved: [],
      platforms: [host],
      state,
    },
    diff: describeMutations(mutations, res, opencodeRoot),
    notes,
  });
  try {
    if (host === "opencode") {
      opencodeRoot = adapterRoot("opencode", res, opts.preferInstalledAdapter);
      const registration = opencodeRegistration(opencodeRoot, res);
      notes.push(
        "OpenCode downloads and refreshes the npm package of its pin itself when it loads",
      );
      if ("error" in registration) return plan([], [registration.error]);
      if (
        registration.pin.startsWith("file://") &&
        !existsSync(registration.pin.slice("file://".length))
      )
        notes.push(
          `the configured pin ${registration.pin} names a missing file; a local pin is kept as is: rebuild the checkout or change the pin`,
        );
      return plan(registered(registration) ? [] : platformMutations(host, res));
    }
    // A host file that cannot be read is reported, never rewritten.
    const unreadable = (
      host === "claude-code"
        ? [claudeRegistryProblem(res.home, env)]
        : host === "pi"
          ? [piSettingsProblem(res.home, env)]
          : host === "cursor"
            ? [hostFileProblem(res.cursorSettings), hostFileProblem(res.cursorMcp)]
            : []
    ).filter((problem): problem is string => problem !== null);
    if (unreadable.length) {
      notes.push(...unreadable);
      return plan([]);
    }
    if (host === "cursor")
      return plan(
        cursorHealthy(res, opts)
          ? []
          : platformMutations(host, res, { packageVersion: opts.packageVersion }),
      );
    const pi = host === "pi" ? piWorkitPackage(res.home, env, opts.piPackageRoot ?? null) : null;
    if (pi && !pi.npm && pi.state !== "ok")
      notes.push(
        `Pi lists the local checkout ${pi.root}, which does not load; build it there (bun run build)`,
      );
    return plan(
      platformMutations(host, res, {
        repair: true,
        piPackageRoot: opts.piPackageRoot ?? null,
        ...(opts.packageVersion ? { packageVersion: opts.packageVersion } : {}),
      }),
    );
  } catch (error) {
    return plan([], [error instanceof Error ? error.message : String(error)]);
  }
}

// ---------------------------------------------------------------------------
// Apply (Task 14: WZ-09, WZ-10, WZ-13-WZ-15; CA-08, CA-13, CA-14, CA-31).
// ---------------------------------------------------------------------------

/** Where a host's native install lands: the reviewed path of its install-host mutation. */
const hostInstallRecord = (platform: HostId, home: string, env: NodeJS.ProcessEnv): string =>
  platform === "cursor"
    ? path.join(home, ".cursor", "plugins", "local", ".workit-package-bootstrap")
    : platform === "codex"
      ? path.join(
          env.CODEX_HOME ?? path.join(home, ".codex"),
          "plugins",
          "cache",
          CODEX_MARKETPLACE,
          "workit",
        )
      : platform === "pi"
        ? path.join(env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent"), "settings.json")
        : platform === "claude-code"
          ? path.join(claudeConfigDir(home, env), "plugins", "installed_plugins.json")
          : "";

type PlatformPlan = { packageVersion?: string; repair?: boolean; piPackageRoot?: string | null };

/** One platform's install mutations: the host's own files and registrations, nothing else. */
function platformMutations(
  platform: string,
  res: ResolvedApply,
  plan: PlatformPlan = {},
): SetupMutation[] {
  const { home, cwd, env } = res;
  if (platform === "opencode")
    return [{ type: "register-platform", platform, path: res.opencodeConfig }];
  if (platform === "cursor") {
    const mutations: SetupMutation[] = [];
    if (adapterRoot("cursor", res) === null)
      mutations.push({
        type: "install-host",
        platform: "cursor",
        path: hostInstallRecord("cursor", home, env),
        commands: planHostInstall("cursor", {
          home,
          cwd,
          env,
          packageVersion: plan.packageVersion ?? "latest",
          targetDir: res.cursorPluginDir,
        }),
      });
    mutations.push({ type: "install-adapter", platform, path: res.cursorPluginDir });
    mutations.push({ type: "register-platform", platform, path: res.cursorSettings });
    mutations.push({ type: "register-platform", platform, path: res.cursorMcp });
    return mutations;
  }
  if (platform !== "codex" && platform !== "pi" && platform !== "claude-code") return [];
  const commands = planHostInstall(platform, {
    home,
    cwd,
    env,
    ...(plan.packageVersion ? { packageVersion: plan.packageVersion } : {}),
    ...(plan.repair ? { repair: true, piPackageRoot: plan.piPackageRoot ?? null } : {}),
  });
  return commands.length > 0
    ? [{ type: "install-host", platform, path: hostInstallRecord(platform, home, env), commands }]
    : [];
}

type Platform = "opencode" | "cursor";

export type SetupResultStatus = "Installed" | "Configured" | "Skipped" | "Failed";

type SetupResultEntry = {
  platform: HostId | "core";
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
  /** Injectable synchronous host runner; defaults to a bounded no-shell spawn. */
  runHostCommand?: HostCommandRunner;
  /** Prefer staged npm adapter assets, used by the explicit upgrade flow. */
  preferInstalledAdapter?: boolean;
  /**
   * The user at an interactive terminal outside an agent (default: both
   * stdio streams are TTYs and no agent marker is set): a workspaces.json
   * write then reseals when the seal matched before (autonomy.ts sealAfterWrite).
   */
  terminal?: boolean;
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
  resolvedConfigDir: string,
): Omit<ResolvedApply, "dev"> => {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? os.homedir();
  return {
    home,
    configDir: resolvedConfigDir,
    cwd: options.cwd ?? process.cwd(),
    env,
    opencodeConfig:
      options.opencodeConfig ?? path.join(home, ".config", "opencode", "opencode.json"),
    cursorSettings: options.cursorSettings ?? path.join(home, ".cursor", "settings.json"),
    cursorMcp: options.cursorMcp ?? path.join(home, ".cursor", "mcp.json"),
    cursorPluginDir:
      options.cursorPluginDir ?? path.join(home, ".cursor", "plugins", "local", "workit"),
  };
};

function resolveApply(preview: SetupPreview, options: ApplySetupOptions): ResolvedApply {
  const paths = resolveSetupPaths(options, options.configDir ?? preview.state.configDir);
  return {
    ...paths,
    dev: options.dev ?? paths.env.WORKIT_DEV ?? null,
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

/** A config file setup writes starts with `"$schema"` (#614), keeping the user's own value. */
const schemaFirst = (file: string, document: Record<string, unknown>): Record<string, unknown> => {
  const name = path.basename(file);
  return isConfigSchemaFile(name) ? withSchemaRef(name, document) : document;
};

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
  { type: "register-platform" } | { type: "install-adapter" } | { type: "install-host" }
>;

const workspaceEntriesAlreadyMatch = (
  contents: string | null,
  file: string,
  entries: WorkspaceConfig[],
): boolean => {
  if (contents === null) return entries.length === 0;
  try {
    const current = validateWorkspacesDocument(JSON.parse(contents), file);
    return (
      current.status === "valid" && JSON.stringify(current.entries) === JSON.stringify(entries)
    );
  } catch {
    return false;
  }
};

function applyMutation(m: CoreMutation, terminal = false): SetupResultEntry {
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
      writeFileSync(m.path, JSON.stringify(schemaFirst(m.path, merged), null, 2) + "\n", "utf8");
      return existing.kind === "record"
        ? { platform: "core", file: m.path, status: "Configured" }
        : { platform: "core", file: m.path, status: "Installed" };
    }
    case "update-workspaces": {
      const prev = readFileSafe(m.path);
      if (workspaceEntriesAlreadyMatch(prev, m.path, m.entries))
        return { platform: "core", file: m.path, status: "Skipped", detail: "already configured" };
      if (workspacesRevision(prev) !== m.expectedRevision) {
        return {
          platform: "core",
          file: m.path,
          status: "Failed",
          detail:
            "workspace config changed after preview; rebuild the preview and review the new values",
        };
      }
      let document: Record<string, unknown> = {};
      if (prev !== null) {
        try {
          const current = validateWorkspacesDocument(JSON.parse(prev), m.path);
          if (current.status === "malformed" || current.status === "invalid") {
            return { platform: "core", file: m.path, status: "Failed", detail: current.error };
          }
          document = current.document ?? {};
        } catch {
          return {
            platform: "core",
            file: m.path,
            status: "Failed",
            detail: `${m.path} is not valid JSON`,
          };
        }
      }
      const proposed = validateWorkspacesDocument({ ...document, workspaces: m.entries }, m.path);
      if (proposed.status !== "valid") {
        return { platform: "core", file: m.path, status: "Failed", detail: proposed.error };
      }
      const next =
        JSON.stringify(
          withSchemaRef("workspaces.json", { ...document, workspaces: m.entries }),
          null,
          2,
        ) + "\n";
      if (prev === next)
        return { platform: "core", file: m.path, status: "Skipped", detail: "already configured" };
      mkdirSync(dir, { recursive: true });
      // Read before the write: the account's seal decides whether it reseals.
      const before = sealBefore(dir);
      const tmp = `${m.path}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, next, "utf8");
        if (workspacesRevision(readFileSafe(m.path)) !== m.expectedRevision) {
          rmSync(tmp, { force: true });
          return {
            platform: "core",
            file: m.path,
            status: "Failed",
            detail: "workspace config changed while applying the preview; rebuild and review it",
          };
        }
        renameSync(tmp, m.path);
      } catch (error) {
        rmSync(tmp, { force: true });
        return {
          platform: "core",
          file: m.path,
          status: "Failed",
          detail: `failed to write ${m.path}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const unsealed =
        sealAfterWrite(before, terminal) === "mismatch"
          ? {
              detail: `not sealed: grants, endpoint and verification above the last seal (or the D4 defaults) apply after the user runs, in their own terminal: ${SEAL_COMMAND}`,
            }
          : {};
      return prev === null
        ? { platform: "core", file: m.path, status: "Installed", ...unsealed }
        : { platform: "core", file: m.path, status: "Configured", ...unsealed };
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

// Package-native adapter resolution, in order: an explicit dev checkout
// (WORKIT_DEV, authoritative when set), the package as Node resolves
// it from the running CLI (nested `npm i -g` node_modules, hoisted siblings, a
// workspace link), the host's own install (Cursor's staged bootstrap,
// OpenCode's plugin cache), then a dev checkout found walking up from cwd. No
// share clone (~/.local/share/workit): nothing keeps it at the CLI's version,
// so it would install an older adapter as current.
const isAdapter = (root: string, platform: Platform): boolean => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      name?: string;
    };
    return pkg.name === `@workit-dev/${platform}`;
  } catch {
    return false;
  }
};

/** Every directory Node would load `@workit-dev/<platform>` from for
 *  the running CLI, nearest first. It probes the package directory itself, so
 *  a package without a resolvable main (Cursor) or behind an exports map that
 *  hides package.json (OpenCode) still counts. */
const nodeResolvedAdapters = (platform: Platform): string[] => {
  const name = `@workit-dev/${platform}`;
  const require = createRequire(path.join(packageRoot(), "package.json"));
  return (require.resolve.paths(name) ?? []).map((dir) => path.join(dir, name));
};

const realRoot = (root: string): string => {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
};

function adapterRoot(
  platform: Platform,
  res: Pick<ResolvedApply, "home" | "cwd" | "env" | "dev">,
  preferInstalledAdapter = false,
): string | null {
  const candidates: string[] = [];
  const stagedCursor = path.join(
    res.home,
    ".cursor",
    "plugins",
    "local",
    ".workit-package-bootstrap",
    "node_modules",
    "@workit-dev",
    "cursor",
  );
  if (platform === "cursor" && preferInstalledAdapter) candidates.push(stagedCursor);
  if (res.dev) {
    // A dev checkout is the complete source of truth for adapter packages: when
    // WORKIT_DEV is set, a package missing from it is a real failure,
    // not a reason to fall through to the running process's own install.
    candidates.push(path.join(res.dev, "packages", `workit-${platform}`));
  } else {
    candidates.push(...nodeResolvedAdapters(platform));
    if (platform === "cursor") candidates.push(stagedCursor);
    if (platform === "opencode") {
      const cached = openCodeInstalledPlugin(res.home, res.env);
      if (cached) candidates.push(cached.root);
    }
    let dir = path.resolve(res.cwd);
    while (true) {
      candidates.push(path.join(dir, "packages", `workit-${platform}`));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const candidate of candidates) {
    if (isAdapter(candidate, platform)) return realRoot(candidate);
  }
  return null;
}

/** True when the adapter root is a monorepo checkout (dev pin), not a packed node_modules install. */
const isDevOpenCodeAdapterRoot = (root: string, dev: string | null | undefined): boolean => {
  if (dev) return true;
  const norm = root.replaceAll("\\", "/");
  return /\/packages\/workit-opencode\/?$/.test(norm);
};

/** Published installs pin the npm package; checkout installs pin file:// entry. */
export const resolveOpenCodePin = (
  root: string,
  opts: { dev?: string | null } = {},
): string | null => {
  if (!isDevOpenCodeAdapterRoot(root, opts.dev)) return OPENCODE_NPM_PIN;
  for (const rel of ["src/plugin.ts", "dist/plugin.js"]) {
    const entry = path.join(root, rel);
    if (existsSync(entry)) return `file://${entry}`;
  }
  return null;
};

const opencodePin = (root: string, res: ResolvedApply): string | null =>
  resolveOpenCodePin(root, { dev: res.dev });

// A published install registers the npm pin and OpenCode installs the package
// itself, so it needs no local adapter; only a dev checkout pins a file.
const registersNpmPin = (platform: Platform, res: ResolvedApply): boolean =>
  platform === "opencode" && !res.dev;

type Registration = { existing: Existing; merged: { config: unknown; changed: string[] } };

/** OpenCode's registration merge, unwritten: the pin already configured wins. */
const opencodeRegistration = (
  root: string | null,
  res: ResolvedApply,
): (Registration & { pin: string }) | { error: string } => {
  const resolvedPin = root === null ? OPENCODE_NPM_PIN : opencodePin(root, res);
  if (!resolvedPin)
    return {
      error:
        "workit-opencode package has no loadable plugin entry (src/plugin.ts or dist/plugin.js)",
    };
  const existing = readExisting(res.opencodeConfig);
  if (existing.kind === "malformed")
    return {
      error: `cannot merge into malformed config: ${existing.error} — repair or remove the file`,
    };
  const listOf = (value: unknown): unknown[] =>
    Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const configuredPlugins =
    existing.kind === "record"
      ? [...listOf(existing.value.plugins), ...listOf(existing.value.plugin)]
      : [];
  const configuredPin = configuredPlugins.find(
    (entry): entry is string => typeof entry === "string" && isWorkitPlugin(entry),
  );
  const pin = configuredPin ?? resolvedPin;
  const merged = mergeOpenCodeConfig(existing.kind === "record" ? existing.value : {}, pin);
  return { existing, merged, pin };
};

function applyOpenCode(root: string | null, res: ResolvedApply): SetupResultEntry {
  const registration = opencodeRegistration(root, res);
  if ("error" in registration)
    return {
      platform: "opencode",
      file: res.opencodeConfig,
      status: "Failed",
      detail: registration.error,
    };
  mkdirSync(path.dirname(res.opencodeConfig), { recursive: true });
  const { existing, merged, pin } = registration;
  const moved = merged.changed.includes("plugin");
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
        detail: moved
          ? `pinned ${pin}; moved the Workit entry from the deprecated "plugin" key to "plugins"`
          : `pinned ${pin}`,
      }
    : {
        platform: "opencode",
        file: res.opencodeConfig,
        status: "Installed",
        detail: `pinned ${pin}`,
      };
}

// Mirror the sync-runtime plugin mirror: copy the package (minus node_modules)
// and write the same `.workit-root` marker so a re-sync from the same
// source is a truthful Skipped. The shipped mcp.json is the Marketplace-safe
// npx command (CA-17), so it is copied verbatim — no absolute dist derivation.
const CURSOR_HOOKS_FILE = path.join("hooks", "hooks-cursor.json");

/** The shipped hooks-cursor.json reaches the launcher through
 *  `${CURSOR_PLUGIN_ROOT}`; a local install writes the absolute launcher path
 *  of `pluginDir` into every event so hooks never depend on Cursor expanding
 *  the variable. Unparseable content is copied as is. */
const localizedCursorHooks = (shipped: Buffer, pluginDir: string): Buffer => {
  try {
    const merged = mergeCursorHooks(
      JSON.parse(shipped.toString("utf8")),
      { command: cursorHooksEntry(pluginDir).command },
      pluginDir,
    );
    return Buffer.from(`${JSON.stringify(merged.config, null, 2)}\n`);
  } catch {
    return shipped;
  }
};

const samePluginContent = (
  src: string,
  dest: string,
  pluginDir: string,
  relative = "",
): boolean => {
  try {
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const source = path.join(src, entry.name);
      const installed = path.join(dest, entry.name);
      const rel = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (
          !statSync(installed).isDirectory() ||
          !samePluginContent(source, installed, pluginDir, rel)
        )
          return false;
      } else {
        const expected =
          rel === CURSOR_HOOKS_FILE
            ? localizedCursorHooks(readFileSync(source), pluginDir)
            : readFileSync(source);
        if (!expected.equals(readFileSync(installed))) return false;
      }
    }
    for (const entry of readdirSync(dest, { withFileTypes: true })) {
      if (existsSync(path.join(src, entry.name))) continue;
      const rel = path.join(relative, entry.name);
      if (rel === ".workit-root") continue;
      if (relative === "rules" && entry.isFile() && entry.name.endsWith(".mdc")) continue;
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

/** Install Cursor plugin files as a real directory (never a symlink into a package cache). */
export function copyPluginDir(src: string, dest: string): SetupResultStatus {
  // pnpm dlx/pacquet (and similar) expose packages as symlinks into a content
  // store. Node's cpSync copies a symlink *root* as a symlink, so the installed
  // plugin would point into an ephemeral cache. Always materialize from the
  // realpath so ~/.cursor/plugins/local/workit is a real directory.
  const realSrc = realpathSync(src);
  const marker = path.join(dest, ".workit-root");
  const destIsLink = existsSync(dest) && lstatSync(dest).isSymbolicLink();
  const synced =
    !destIsLink &&
    readFileSafe(marker)?.trim() === realSrc &&
    samePluginContent(realSrc, dest, dest);
  if (synced) return "Skipped";
  const hadDir = existsSync(dest);
  const rules = preservedCursorRules(realSrc, dest);
  const parent = path.dirname(dest);
  mkdirSync(parent, { recursive: true });
  const swap = mkdtempSync(path.join(parent, `.${path.basename(dest)}.swap-`));
  const stage = path.join(swap, "stage");
  const backup = path.join(swap, "backup");
  try {
    cpSync(realSrc, stage, {
      recursive: true,
      filter: (entry) => !path.relative(realSrc, entry).split(path.sep).includes("node_modules"),
    });
    const stagedHooks = path.join(stage, CURSOR_HOOKS_FILE);
    if (existsSync(stagedHooks))
      writeFileSync(stagedHooks, localizedCursorHooks(readFileSync(stagedHooks), dest));
    for (const [name, content] of rules) {
      mkdirSync(path.join(stage, "rules"), { recursive: true });
      writeFileSync(path.join(stage, "rules", name), content);
    }
    writeFileSync(path.join(stage, ".workit-root"), realSrc + "\n", "utf8");
    if (!samePluginContent(realSrc, stage, dest))
      throw new Error("staged adapter content is incomplete");
    if (lstatSync(stage).isSymbolicLink()) {
      throw new Error("staged adapter resolved to a symlink — refusing fragile cache install");
    }
    if (hadDir) renameSync(dest, backup);
    try {
      renameSync(stage, dest);
    } catch (error) {
      if (hadDir && !existsSync(dest)) renameSync(backup, dest);
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });
  } finally {
    rmSync(swap, { recursive: true, force: true });
  }
  return hadDir ? "Configured" : "Installed";
}

// One reviewed mutation per Cursor write target (AR-09): the settings merge and
// the mcp merge are dispatched independently, exactly like the adapter copy.
const cursorSettingsRegistration = (res: ResolvedApply): Registration => {
  const existing = readExisting(res.cursorSettings);
  return {
    existing,
    merged: mergeCursorSettings(
      existing.kind === "record" ? existing.value : {},
      res.cursorPluginDir,
      res.home,
    ),
  };
};

/** Cursor's mcp.json merge, unwritten: an exact package pin the user chose stays. */
const cursorMcpRegistration = (res: ResolvedApply): Registration => {
  const existing = readExisting(res.cursorMcp);
  const mcpBase = existing.kind === "record" ? existing.value : {};
  const server = cursorMcpServerEntry(res.cursorPluginDir);
  const servers = isRecord(mcpBase.mcpServers) ? mcpBase.mcpServers : {};
  const current = isRecord(servers.workit) ? servers.workit : {};
  const previousArgs = Array.isArray(current.args) ? current.args.map(String) : [];
  const previousPackage = previousArgs.find(
    (arg) =>
      arg.startsWith("--package=@workit-dev/cursor@") &&
      arg !== `--package=${CURSOR_RUNTIME_PACKAGE}`,
  );
  if (previousPackage) {
    const index = server.args.findIndex((arg) => arg.startsWith("--package="));
    if (index >= 0) server.args[index] = previousPackage;
  }
  return { existing, merged: mergeCursorMcp(mcpBase, "workit", server) };
};

function applyCursorSettings(root: string, res: ResolvedApply): SetupResultEntry {
  mkdirSync(path.dirname(res.cursorSettings), { recursive: true });
  const { existing: settingsExisting, merged: settings } = cursorSettingsRegistration(res);
  if (settingsExisting.kind === "malformed") {
    return {
      platform: "cursor",
      file: res.cursorSettings,
      status: "Failed",
      detail: `cannot merge into malformed config: ${settingsExisting.error} — repair or remove the file`,
    };
  }
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
  const { existing: mcpExisting, merged: mcp } = cursorMcpRegistration(res);
  if (mcpExisting.kind === "malformed") {
    return {
      platform: "cursor",
      file: res.cursorMcp,
      status: "Failed",
      detail: `cannot merge into malformed config: ${mcpExisting.error} — repair or remove the file`,
    };
  }
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
    stateDir: res.env.WORKIT_STATE_DIR,
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
    // Some details already lead with their id (`stale_install: …`).
    .map((c) => (c.detail.startsWith(`${c.id}:`) ? c.detail : `${c.id}: ${c.detail}`))
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

  const workspaceMutation = preview.mutations.find(
    (mutation): mutation is Extract<SetupMutation, { type: "update-workspaces" }> =>
      mutation.type === "update-workspaces",
  );
  const currentWorkspaceContents = workspaceMutation ? readFileSafe(workspaceMutation.path) : null;
  if (
    workspaceMutation &&
    workspacesRevision(currentWorkspaceContents) !== workspaceMutation.expectedRevision &&
    !workspaceEntriesAlreadyMatch(
      currentWorkspaceContents,
      workspaceMutation.path,
      workspaceMutation.entries,
    )
  ) {
    return {
      ok: false,
      exitCode: 1,
      entries: [
        {
          platform: "core",
          file: workspaceMutation.path,
          status: "Failed",
          detail:
            "workspace config changed after preview; rebuild the preview and review the new values",
        },
      ],
      preserved: preview.preserved,
      blocked: [],
      doctor: [],
    };
  }

  const res = resolveApply(preview, options);
  const terminal =
    options.terminal ??
    (process.stdin.isTTY === true &&
      process.stdout.isTTY === true &&
      !agentMarker(options.env ?? process.env));
  // Hook launchers find a Node >= the floor from this record when the PATH node is older.
  recordHookNode(options.stateDir ? { ...res.env, WORKIT_STATE_DIR: options.stateDir } : res.env);
  const entries: SetupResultEntry[] = [];
  // AR-09/AR-13: Apply dispatches ONLY the reviewed mutation union. The adapter
  // source is re-resolved with the apply options (dev/cwd); a resolution
  // failure reports Failed without writing — it never produces a write that
  // was not previewed. The reviewed path itself is code-enforced: a platform
  // mutation whose planned path does not exactly equal the apply-time resolved
  // path (a caller that resolved the preview with different options) fails
  // fast — Failed, no write — instead of silently writing an unreviewed path.
  const rootFor = new Map<Platform, string | null>();
  // CA-09: cursor registration only proceeds after the canonical copy
  // succeeded — a failed copy must never be registered.
  let cursorCopyOk = false;
  for (const mutation of preview.mutations) {
    if (mutation.type === "install-host") {
      const expectedPath = hostInstallRecord(mutation.platform, res.home, res.env);
      if (mutation.path !== expectedPath) {
        entries.push({
          platform: mutation.platform,
          file: mutation.path,
          status: "Failed",
          detail: `preview/apply path mismatch: apply resolved ${expectedPath}, the previewed host install was ${mutation.path} — rebuild the preview with the same options`,
        });
        continue;
      }
      const run =
        options.runHostCommand ??
        ((step: HostInstallCommand) => runHostCommand(step, { home: res.home, env: res.env }));
      const installed = runHostInstall(mutation.commands, run);
      for (const { command, result } of installed.results) {
        entries.push({
          platform: mutation.platform,
          file: command.command,
          status: result.exitCode === 0 ? "Installed" : "Failed",
          detail:
            result.exitCode === 0
              ? `${command.purpose} (${command.args.join(" ")})`
              : `${command.purpose} failed (${command.args.join(" ")}): ${result.stderr || `exit ${result.exitCode}`}`,
        });
      }
      if (!installed.ok && installed.results.length === 0) {
        entries.push({
          platform: mutation.platform,
          file: mutation.platform,
          status: "Failed",
          detail: "host installation did not run",
        });
      }
      if (!installed.ok) continue;
      if (mutation.platform === "cursor" && installed.packageRoot) {
        rootFor.set("cursor", installed.packageRoot);
      }
      const verified =
        mutation.platform === "codex"
          ? isCodexWorkitInstalled(res.home, res.env)
          : mutation.platform === "pi"
            ? isPiWorkitInstalled(res.home, res.env)
            : mutation.platform === "claude-code"
              ? isClaudeWorkitInstalled(res.home, res.env, null)
              : true;
      if (!verified) {
        entries.push({
          platform: mutation.platform,
          file: mutation.platform,
          status: "Failed",
          detail:
            "the host command succeeded, but Workit registration was not found; inspect the host's native package list and retry",
        });
      }
      continue;
    }
    if (mutation.type !== "register-platform" && mutation.type !== "install-adapter") {
      entries.push(applyMutation(mutation, terminal));
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
      root = adapterRoot(platform, res, options.preferInstalledAdapter);
      rootFor.set(platform, root);
    }
    if (root === null && registersNpmPin(platform, res)) {
      entries.push(applyOpenCode(null, res));
      continue;
    }
    if (root === null) {
      entries.push({
        platform,
        file: mutation.path,
        status: "Failed",
        detail: `@workit-dev/${platform} package not found — set WORKIT_DEV to your checkout or install the package`,
      });
      continue;
    }
    if (mutation.type === "install-adapter") {
      try {
        const status = copyPluginDir(root, mutation.path);
        cursorCopyOk = true;
        entries.push({ platform, file: mutation.path, status });
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
    } else if (!cursorCopyOk) {
      // CA-09: the canonical copy failed — leave the registration intact.
      continue;
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
      detail:
        "legacy YouTrack token file: Workit no longer reads it; delete it once ytrack is logged in",
    });
  }
  if (preview.ytrack) entries.push(ytrackEntry(preview.ytrack.host, res.env));
  if (preview.ytrackPaths) entries.push(...applyYtrackPaths(preview.ytrackPaths, res.env));
  if (preview.projectRefused) {
    entries.push({
      platform: "core",
      file: path.resolve(res.cwd),
      status: "Skipped",
      detail: preview.projectRefused,
    });
  }

  // Post-apply verification per platform (read-only): a registered host whose
  // writes succeeded is verified by the shared offline doctor.
  const doctor: DoctorReport[] = [];
  for (const platform of preview.platforms) {
    if (platform !== "opencode" && platform !== "cursor") continue;
    const root = rootFor.get(platform);
    if (root === undefined || (root === null && !registersNpmPin(platform, res))) continue;
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

// ytrack's `auth status` may reach the network; Apply waits this long at most.
const YTRACK_SETUP_TIMEOUT_MS = 15_000;

/**
 * The `ytrack auth paths --add` calls that map each workspace glob to its
 * YouTrack host (core/youtrack-paths.ts), so an agent's own ytrack in that
 * folder reaches the right instance. Read-only: it only reads ytrack's map.
 * None without such a workspace or without ytrack on PATH.
 */
function planYtrackPaths(
  workspaces: readonly unknown[],
  env: NodeJS.ProcessEnv,
): SetupPreview["ytrackPaths"] {
  const wants = pathWants(workspaces);
  if (!wants.length || !findYtrack(env)) return undefined;
  const review = reviewYtrackPaths(ytrackRunner(env, null, YTRACK_SETUP_TIMEOUT_MS), wants);
  if (review.state === "ok")
    return {
      planned: review.fixes.filter((fix) => fix.add.length).map((fix) => ({ ...fix, remove: [] })),
    };
  if (review.state === "missing") return undefined;
  return {
    skipped: review.error,
    unblock:
      review.state === "old" ? "ytrack upgrade, then run workit setup again" : "run workit doctor",
  };
}

/** Run the planned `ytrack auth paths --add` calls, one Apply row each. */
const applyYtrackPaths = (
  paths: NonNullable<SetupPreview["ytrackPaths"]>,
  env: NodeJS.ProcessEnv,
): SetupResultEntry[] => {
  if ("skipped" in paths)
    return [
      {
        platform: "core",
        file: "ytrack auth paths",
        status: "Skipped",
        detail: `${paths.skipped}: ${paths.unblock}`,
      },
    ];
  const run = ytrackRunner(env, null, YTRACK_SETUP_TIMEOUT_MS);
  return paths.planned.map((fix) => {
    const out = run(ytrackAuthPathsArgs(fix.host, { add: fix.add }));
    const ok = !out.missing && out.status === 0;
    return {
      platform: "core",
      file: "ytrack auth paths",
      status: ok ? "Configured" : "Failed",
      detail: ok
        ? `${fix.add.join(", ")} now reach ${fix.host}`
        : `${fix.command} failed${out.missing ? ": ytrack is not on PATH" : ` (exit ${out.status ?? "signal"})${out.stderr.trim() ? `: ${out.stderr.trim().split("\n").slice(-1)[0]}` : ""}`}`,
    };
  });
};

/** ytrack's login for the configured YouTrack host, as an Apply row; never a failure. */
const ytrackEntry = (host: string, env: NodeJS.ProcessEnv): SetupResultEntry => {
  const ready = ytrackReadiness(ytrackRunner(env, host, YTRACK_SETUP_TIMEOUT_MS), host);
  return ready.ok
    ? {
        platform: "core",
        file: "ytrack",
        status: "Configured",
        detail: `ytrack${ready.version ? ` ${ready.version}` : ""} logged in to ${host}${ready.login ? ` as ${ready.login}` : ""}`,
      }
    : {
        platform: "core",
        file: "ytrack",
        status: "Skipped",
        detail: `${ready.error}: ${ready.unblock}`,
      };
};

// Completion guidance shown by the CLI after Apply (and on the non-TTY path):
// `workit doctor` (and ytrack login) are the next steps for verifying the result.
export const setupCompletionGuidance = (): string[] => [
  "Run `workit doctor` to verify your installation.",
  "YouTrack goes through ytrack: `ytrack auth login --host <host>` once; Workit stores no YouTrack token.",
];

// Shared per-workspace branch policy writer (CA-06): the initApplyData
// branch_policy action (OpenCode/Cursor) and the Task 5 wizard both route
// through this proposal→write path, so the written bytes are identical. The
// write is idempotent: a matching entry is reported already-configured without
// touching the file; an existing entry is updated; otherwise appended.
