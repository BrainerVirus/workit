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
      console.warn(`[workit] config migration: failed to copy ${src}: ${(err as Error).message}`);
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

export const readConfig = (): ToolkitConfig => {
  const raw = readSafe(path.join(configDir(), "config.json"));
  if (!raw) return DEFAULTS;
  try {
    const parsed = JSON.parse(raw) as Partial<ToolkitConfig>;
    const locale = LOCALE_RE.test(String(parsed.locale ?? ""))
      ? (parsed.locale as string)
      : DEFAULTS.locale;
    const preset = (parsed.branchPolicy?.preset ?? "gitflow") as BranchPreset;
    const presetOk = Object.hasOwn(PRESETS, preset) ? preset : "gitflow";
    const presetDefs = PRESETS[presetOk];
    return {
      locale,
      localeOptions: Array.isArray(parsed.localeOptions)
        ? parsed.localeOptions
        : DEFAULTS.localeOptions,
      timezone: parsed.timezone ?? DEFAULTS.timezone,
      branchPolicy: {
        preset: presetOk,
        allowed: Array.isArray(parsed.branchPolicy?.allowed)
          ? parsed.branchPolicy.allowed
          : presetDefs.allowed,
        protected: Array.isArray(parsed.branchPolicy?.protected)
          ? parsed.branchPolicy.protected
          : presetDefs.protected,
      },
    };
  } catch {
    return DEFAULTS;
  }
};

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
    JSON.parse(raw);
    return { source: "file", config_dir: dir, malformed: false };
  } catch {
    return { source: "defaults", config_dir: dir, malformed: true };
  }
};

export const resolveBranchPolicy = (
  config: ToolkitConfig,
): { allowed: RegExp[]; protected: Set<string> } => {
  const allowed = config.branchPolicy.allowed.map(
    (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i"),
  );
  return { allowed, protected: new Set(config.branchPolicy.protected.map((p) => p.toLowerCase())) };
};
