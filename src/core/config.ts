import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type BranchPreset = "gitflow" | "github-flow" | "trunk-based" | "custom";

export type ToolkitConfig = {
  locale: string;
  localeOptions: string[];
  timezone: string;
  branchPolicy: { preset: BranchPreset; allowed: string[]; protected: string[] };
};

export const PRESETS: Record<BranchPreset, { allowed: string[]; protected: string[] }> = {
  gitflow: { allowed: ["feature/*", "bugfix/*", "hotfix/*", "release/*"], protected: ["main", "develop", "master", "prod", "production"] },
  "github-flow": { allowed: ["*"], protected: ["main"] },
  "trunk-based": { allowed: ["*"], protected: ["main"] },
  custom: { allowed: [], protected: [] },
};

export const configDir = (): string =>
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR
  ?? path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "workflow-toolkit");

const LOCALE_RE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

const DEFAULTS: ToolkitConfig = {
  locale: "en",
  localeOptions: ["en", "es-CL", "es-MX", "es-AR", "pt-BR"],
  timezone: "America/Santiago",
  branchPolicy: { preset: "gitflow", allowed: PRESETS.gitflow.allowed, protected: PRESETS.gitflow.protected },
};

const readSafe = (p: string): string | null => {
  try { return readFileSync(p, "utf8"); } catch { return null; }
};

export const readConfig = (): ToolkitConfig => {
  const raw = readSafe(path.join(configDir(), "config.json"));
  if (!raw) return DEFAULTS;
  try {
    const parsed = JSON.parse(raw) as Partial<ToolkitConfig>;
    const locale = LOCALE_RE.test(String(parsed.locale ?? "")) ? parsed.locale as string : DEFAULTS.locale;
    const preset = (parsed.branchPolicy?.preset ?? "gitflow") as BranchPreset;
    const presetOk = preset in PRESETS ? preset : "gitflow";
    const presetDefs = PRESETS[presetOk];
    return {
      locale,
      localeOptions: Array.isArray(parsed.localeOptions) ? parsed.localeOptions : DEFAULTS.localeOptions,
      timezone: parsed.timezone ?? DEFAULTS.timezone,
      branchPolicy: {
        preset: presetOk,
        allowed: Array.isArray(parsed.branchPolicy?.allowed) ? parsed.branchPolicy.allowed : presetDefs.allowed,
        protected: Array.isArray(parsed.branchPolicy?.protected) ? parsed.branchPolicy.protected : presetDefs.protected,
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

export const resolveBranchPolicy = (config: ToolkitConfig): { allowed: RegExp[]; protected: Set<string> } => {
  const allowed = config.branchPolicy.allowed.map((p) =>
    new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));
  return { allowed, protected: new Set(config.branchPolicy.protected.map((p) => p.toLowerCase())) };
};
