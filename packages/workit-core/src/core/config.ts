import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "./logger";
import { EVENT, errorDetail } from "./boundary";

// Optional diagnostic seam: adapters install their host logger so config
// migration and provenance events land in the same sanitized log stream.
let diagnosticLogger: Logger | undefined;
export const setDiagnosticLogger = (logger: Logger | undefined): void => {
  diagnosticLogger = logger;
};
export const getDiagnosticLogger = (): Logger | undefined => diagnosticLogger;

export type BranchPreset = "gitflow" | "github-flow" | "trunk-based" | "custom";

export type ToolkitConfig = {
  locale: string;
  localeOptions: string[];
  timezone: string;
  branchPolicy: { preset: BranchPreset; allowed: string[]; protected: string[] };
};

export const PRESETS: Record<BranchPreset, { allowed: string[]; protected: string[] }> = {
  gitflow: {
    allowed: ["feature/*", "bugfix/*", "hotfix/*", "release/*"],
    protected: ["main", "develop", "master", "prod", "production"],
  },
  "github-flow": { allowed: ["*"], protected: ["main"] },
  "trunk-based": { allowed: ["*"], protected: ["main"] },
  custom: { allowed: [], protected: [] },
};

// RL-02: one shared preset merge helper. Changing the preset resets every
// derived policy field from PRESETS; only `custom` carries explicit values
// (falling back to the current policy when none are given).
export const mergePreset = (
  preset: BranchPreset,
  input: { allowed?: string[]; protectedNames?: string[] } = {},
  current: { branchPolicy: ToolkitConfig["branchPolicy"] } = {
    branchPolicy: { preset, allowed: [], protected: [] },
  },
): ToolkitConfig["branchPolicy"] => {
  const defs = PRESETS[preset];
  return {
    preset,
    allowed:
      preset === "custom" ? (input.allowed ?? current.branchPolicy.allowed) : [...defs.allowed],
    protected:
      preset === "custom"
        ? (input.protectedNames ?? current.branchPolicy.protected)
        : [...defs.protected],
  };
};

export const resolveConfigDir = (): string =>
  process.env.WORKFLOW_TOOLKIT_CONFIG ??
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR ??
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "workit");

// One-time lazy migration from the legacy ~/.config/workflow-toolkit dir.
// migratedDir remembers the resolved dir already checked: configDir() is on
// hot paths, so subsequent calls are one string compare. Re-checking per
// unique dir also keeps tests with swapped env working.
// ponytail: cache keyed by dir value — an env override explicitly set to the
// default path caches before migration could trigger; only matters if that
// env is cleared mid-process (next unique dir value re-checks).
let migratedDir: string | null = null;
// A mid-loop copy failure leaves the new dir half-populated; keep retrying
// until a full pass succeeds instead of silently skipping the failed entry.
let migrationFailed = false;

export const ensureConfigDir = (dir: string = resolveConfigDir()): string => {
  if (migratedDir === dir) return dir;
  if (process.env.WORKFLOW_TOOLKIT_CONFIG || process.env.WORKFLOW_TOOLKIT_CONFIG_DIR) {
    migratedDir = dir;
    return dir;
  }
  const legacy = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "workflow-toolkit",
  );
  if (!existsSync(legacy)) {
    migratedDir = dir;
    return dir;
  }
  if (!migrationFailed && existsSync(dir)) {
    migratedDir = dir;
    return dir;
  }
  migrationFailed = false;
  mkdirSync(dir, { recursive: true });
  diagnosticLogger?.info(EVENT.migration, { from: legacy, to: dir });
  for (const entry of readdirSync(legacy, { withFileTypes: true })) {
    const src = path.join(legacy, entry.name);
    const dest = path.join(dir, entry.name);
    if (existsSync(dest)) continue;
    try {
      if (entry.isDirectory()) cpSync(src, dest, { recursive: true });
      else if (entry.isFile()) copyFileSync(src, dest);
    } catch (err) {
      migrationFailed = true;
      diagnosticLogger?.warn(EVENT.migration, { from: src, ok: false, ...errorDetail(err) });
      // Task 10 advisory: never leak the raw legacy source path to the terminal —
      // the structured warn above carries it through the sanitized logger.
      console.warn(
        `[workit] config migration: a file could not be copied to ${dir}; it will be retried on the next run`,
      );
    }
  }
  if (!migrationFailed) migratedDir = dir;
  return dir;
};

export const configDir = (): string => ensureConfigDir();

export const LOCALE_RE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

const DEFAULTS: ToolkitConfig = {
  locale: "en",
  localeOptions: ["en", "es-CL", "es-MX", "es-AR", "pt-BR"],
  timezone: "America/Santiago",
  branchPolicy: {
    preset: "gitflow",
    allowed: [...PRESETS.gitflow.allowed],
    protected: [...PRESETS.gitflow.protected],
  },
};

const readSafe = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

// RL-01: typed reader contract. Every config reader distinguishes missing from
// valid from malformed and reports the exact file path; risky consumers stop on
// malformed instead of silently falling back to defaults.
export type ReaderStatus = "missing" | "valid" | "malformed";

export type ReaderResult<T> = {
  status: ReaderStatus;
  path: string;
  config?: T;
  error?: string;
};

// AR-07/CA-37: the one shared fail-closed shape rule for every object-config
// reader (config, setup-state, workspaces, doctor). A parseable non-object
// (null, scalar, array) is malformed, never defaults.
export const isConfigObject = (value: unknown): boolean =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseConfigResult = (raw: string | null, file: string): ReaderResult<ToolkitConfig> => {
  if (raw === null) return { status: "missing", path: file };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "malformed", path: file, error: `${file} is not valid JSON` };
  }
  if (!isConfigObject(parsed)) {
    return { status: "malformed", path: file, error: `${file} is not a JSON object` };
  }
  const input = parsed as Partial<ToolkitConfig>;
  const locale = LOCALE_RE.test(String(input.locale ?? ""))
    ? (input.locale as string)
    : DEFAULTS.locale;
  const preset = (
    Object.hasOwn(PRESETS, input.branchPolicy?.preset as string)
      ? input.branchPolicy?.preset
      : "gitflow"
  ) as BranchPreset;
  return {
    status: "valid",
    path: file,
    config: {
      locale,
      localeOptions: Array.isArray(input.localeOptions)
        ? input.localeOptions
        : DEFAULTS.localeOptions,
      timezone: input.timezone ?? DEFAULTS.timezone,
      // RL-02/CA-23: the persisted preset is authoritative; derived allowed /
      // protected fields always reset from PRESETS via the one shared merge.
      branchPolicy: mergePreset(
        preset,
        {
          allowed: Array.isArray(input.branchPolicy?.allowed)
            ? input.branchPolicy.allowed
            : undefined,
          protectedNames: Array.isArray(input.branchPolicy?.protected)
            ? input.branchPolicy.protected
            : undefined,
        },
        DEFAULTS,
      ),
    },
  };
};

export const readConfigTyped = (dir?: string): ReaderResult<ToolkitConfig> => {
  const file = path.join(dir ?? configDir(), "config.json");
  return parseConfigResult(readSafe(file), file);
};

// RL-01: no silent fallback on malformed config — every consumer gets an
// exact-path diagnostic instead of defaults. Missing config still defaults.
export const readConfig = (): ToolkitConfig => {
  const result = readConfigTyped();
  if (result.status === "malformed") throw new Error(result.error);
  return result.config ?? DEFAULTS;
};

export const readConfigFromDir = (dir: string): ToolkitConfig => {
  const result = readConfigTyped(dir);
  if (result.status === "malformed") throw new Error(result.error);
  return result.config ?? DEFAULTS;
};

export type ConfigInput = {
  locale?: string;
  localeOptions?: string[];
  timezone?: string;
  preset?: BranchPreset;
  allowed?: string[];
  protectedNames?: string[];
};

// RL-02: the single authoritative ToolkitConfig merge. CLI, OpenCode, and Cursor
// adapters all route their `config` writes through this so a preset switch
// resets every derived policy field identically everywhere.
export const mergeConfigValues = (input: ConfigInput, current: ToolkitConfig): ToolkitConfig => ({
  locale: input.locale ?? current.locale,
  localeOptions: input.localeOptions ?? current.localeOptions,
  timezone: input.timezone ?? current.timezone,
  branchPolicy: mergePreset(input.preset ?? current.branchPolicy.preset, input, current),
});

export const writeConfig = (config: ToolkitConfig): void => {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
};

// Configuration provenance for startup diagnostics: where config.json came from
// and whether it parsed. Only paths + a malformed flag — never the file body.
export const describeConfigSource = (
  dir: string = resolveConfigDir(),
): { source: string; config_dir: string; malformed: boolean } => {
  const file = path.join(dir, "config.json");
  if (!existsSync(file)) return { source: "defaults", config_dir: dir, malformed: false };
  const raw = readSafe(file);
  if (raw === null) return { source: "unreadable", config_dir: dir, malformed: true };
  try {
    const parsed = JSON.parse(raw);
    if (!isConfigObject(parsed)) {
      return { source: "defaults", config_dir: dir, malformed: true };
    }
    return { source: "file", config_dir: dir, malformed: false };
  } catch {
    return { source: "defaults", config_dir: dir, malformed: true };
  }
};

export const resolveBranchPolicy = (
  config: ToolkitConfig,
  workspace?: { branchPolicy?: Record<string, any> } | null,
): {
  preset: BranchPreset;
  allowed: RegExp[];
  protected: Set<string>;
  integration: "pr" | "merge";
  defaultTargetBranch: string;
} => {
  const wp = (workspace?.branchPolicy ?? {}) as Record<string, any>;
  // An invalid workspace preset (e.g. a typo) falls back to the global preset,
  // preserving resolution order workspace > global > preset, instead of
  // crashing on PRESETS[preset] (mirrors parseConfigResult's Object.hasOwn).
  const preset = (
    Object.hasOwn(PRESETS, wp.preset) ? wp.preset : (config.branchPolicy?.preset ?? "gitflow")
  ) as BranchPreset;
  // RL-02: the preset is authoritative — allowed/protected re-derive from the
  // workspace's own values or the preset table, never the global config's, and
  // the current config remains the `custom` fallback when no values are given.
  const merged = mergePreset(
    preset,
    {
      allowed: wp.allowed,
      protectedNames: wp.protected,
    },
    config,
  );
  const allowed = merged.allowed.map(
    (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i"),
  );
  return {
    preset,
    allowed,
    protected: new Set(merged.protected.map((p) => p.toLowerCase())),
    integration: wp.integration === "merge" ? "merge" : "pr",
    // CA-05: preset-aware default target when vcs.defaultTargetBranch is unset.
    defaultTargetBranch:
      preset === "github-flow" ? "main" : preset === "trunk-based" ? "master" : "develop",
  };
};
