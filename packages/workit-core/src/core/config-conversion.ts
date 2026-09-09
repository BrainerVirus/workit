import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isConfigObject, mergePreset, type BranchPreset, type ToolkitConfig } from "./config";

export type ConversionInput = {
  configDir: string;
};

export type ConversionMapping = {
  key: string;
  from: unknown;
  to: unknown;
  note?: string;
};

export type ConversionUnresolved = {
  key: string;
  reason: string;
};

export type ConversionPreview = {
  mappings: ConversionMapping[];
  preserved: string[];
  unresolved: ConversionUnresolved[];
};

const REDACT_KEYS = /token|secret|password|credential/i;

const readJsonObject = (file: string): Record<string, unknown> | null => {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return isConfigObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const redactValue = (key: string, value: unknown): unknown => {
  if (REDACT_KEYS.test(key)) return "[redacted]";
  if (typeof value === "string" && value.length > 8 && !value.includes(" ")) return "[redacted]";
  return value;
};

export const redactConversionPreview = (preview: ConversionPreview): ConversionPreview => ({
  mappings: preview.mappings.map((m) => ({
    ...m,
    from: redactValue(m.key, m.from),
    to: redactValue(m.key, m.to),
  })),
  preserved: preview.preserved,
  unresolved: preview.unresolved,
});

export function previewConversion(input: ConversionInput): ConversionPreview {
  const configFile = path.join(input.configDir, "config.json");
  const config = readJsonObject(configFile);
  const mappings: ConversionMapping[] = [];
  const unresolved: ConversionUnresolved[] = [];
  const preserved: string[] = [];

  if (config) {
    if (config.locale !== undefined) {
      mappings.push({ key: "locale", from: config.locale, to: config.locale });
    }
    if (config.timezone !== undefined) {
      mappings.push({ key: "timezone", from: config.timezone, to: config.timezone });
    }
    if (config.branchPolicy !== undefined && isConfigObject(config.branchPolicy)) {
      const bp = config.branchPolicy as ToolkitConfig["branchPolicy"] & { allowed?: string[]; protected?: string[] };
      const preset = (bp.preset ?? "gitflow") as BranchPreset;
      const merged = mergePreset(
        preset,
        {
          allowed: Array.isArray(bp.allowed) ? bp.allowed : undefined,
          protectedNames: Array.isArray(bp.protected) ? bp.protected : undefined,
        },
        { branchPolicy: bp },
      );
      mappings.push({
        key: "branchPolicy",
        from: config.branchPolicy,
        to: merged,
        note: "preset-derived allowed/protected reset through mergePreset",
      });
      if (preset === "custom" && Array.isArray(bp.allowed)) {
        if (bp.allowed.includes("*")) {
          unresolved.push({
            key: "branchPolicy.allowed",
            reason: 'unsupported permissive value "*" requires an explicit v1 choice',
          });
        }
      }
    }
    if (config.workflowMode !== undefined) {
      unresolved.push({
        key: "legacyWorkflowMode",
        reason: "0.x workflow mode has no automatic v1 equivalent; choose how to continue",
      });
    }
  }

  for (const name of ["youtrack.json", "vcs.json", "workspaces.json"]) {
    const file = path.join(input.configDir, name);
    if (!existsSync(file)) continue;
    const parsed = readJsonObject(file);
    if (parsed) mappings.push({ key: name, from: parsed, to: parsed, note: "carry forward unchanged" });
  }

  for (const token of ["youtrack.token", "gitlab.token", "github.token"]) {
    const file = path.join(input.configDir, token);
    if (existsSync(file)) preserved.push(file);
  }

  return { mappings, preserved, unresolved };
}

export const conversionDigest = (preview: ConversionPreview): string =>
  createHash("sha256").update(JSON.stringify(redactConversionPreview(preview))).digest("hex");

export type ConversionApplyResult = {
  configPath: string;
  choicesPath: string;
};

/** Apply approved conversion mappings and record explicit resolution choices. */
export function applyConversionConfig(
  configDir: string,
  preview: ConversionPreview,
  resolutions: Record<string, string>,
): ConversionApplyResult {
  const configFile = path.join(configDir, "config.json");
  const raw = readJsonObject(configFile) ?? {};
  const next: Record<string, unknown> = { ...raw };

  for (const mapping of preview.mappings) {
    if (mapping.key === "locale" || mapping.key === "timezone") {
      next[mapping.key] = mapping.to;
    }
    if (mapping.key === "branchPolicy" && !resolutions["branchPolicy.allowed"]) {
      next.branchPolicy = mapping.to;
    }
  }

  if (resolutions["branchPolicy.allowed"]) {
    const bp = isConfigObject(next.branchPolicy)
      ? (next.branchPolicy as ToolkitConfig["branchPolicy"])
      : { preset: "custom" as BranchPreset, allowed: [], protected: [] };
    const preset = bp.preset ?? "custom";
    next.branchPolicy = mergePreset(
      preset,
      {
        allowed: resolutions["branchPolicy.allowed"]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      },
      { branchPolicy: bp },
    );
  }

  if (resolutions["legacyWorkflowMode"]) {
    delete next.workflowMode;
  }

  mkdirSync(configDir, { recursive: true });
  writeFileSync(configFile, JSON.stringify(next, null, 2) + "\n");

  const choicesPath = path.join(configDir, "cutover-choices.json");
  writeFileSync(
    choicesPath,
    JSON.stringify({ resolutions, applied_at: new Date().toISOString() }, null, 2) + "\n",
  );

  return { configPath: configFile, choicesPath };
}
