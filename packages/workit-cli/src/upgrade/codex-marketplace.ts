import { readFileSync } from "node:fs";

/** Workit's Codex marketplace: `codex plugin add workit@workit`. */
export const CODEX_MARKETPLACE = "workit";
/** The git source Codex reads `.agents/plugins/marketplace.json` from. */
export const CODEX_MARKETPLACE_URL = "https://github.com/BrainerVirus/workit.git";
/** The marketplace name Codex installs used before the rename; setup and upgrade move them to CODEX_MARKETPLACE. */
export const CODEX_LEGACY_MARKETPLACE = "workflow-toolkit";

/** One `codex …` invocation (arguments after the executable) with its purpose. */
export type CodexStep = { args: string[]; purpose: string };

const tableHeaders = (configFile: string): string[] => {
  try {
    return readFileSync(configFile, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("["));
  } catch {
    return [];
  }
};

const hasMarketplace = (headers: string[], name: string): boolean =>
  headers.includes(`[marketplaces.${name}]`) || headers.includes(`[marketplaces."${name}"]`);

/** `[plugins."workit@<marketplace>"]` in Codex's config.toml, not disabled. */
export const codexPluginRegistered = (configFile: string, marketplace: string): boolean => {
  let text: string;
  try {
    text = readFileSync(configFile, "utf8");
  } catch {
    return false;
  }
  const header = `[plugins."workit@${marketplace}"]`;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return false;
  const body = lines
    .slice(start + 1)
    .join("\n")
    .split(/^\s*\[/m)[0];
  return !/^\s*enabled\s*=\s*false\b/m.test(body);
};

/** Whether config.toml still registers Workit under the old marketplace name. */
export const codexLegacyRegistration = (
  configFile: string,
): { marketplace: boolean; plugin: boolean } => {
  const headers = tableHeaders(configFile);
  return {
    marketplace: hasMarketplace(headers, CODEX_LEGACY_MARKETPLACE),
    plugin: headers.includes(`[plugins."workit@${CODEX_LEGACY_MARKETPLACE}"]`),
  };
};

/**
 * The Codex commands that move an install off the old marketplace name: drop
 * the old plugin and marketplace first (so Workit's hooks are never
 * registered twice), then register `workit@workit` once. Null when neither
 * config.toml nor `installed` (Codex's inventory listed a Workit plugin under
 * the old marketplace) shows an old registration.
 */
export const codexMigrationSteps = (
  configFile: string,
  options: { json?: boolean; installed?: boolean } = {},
): CodexStep[] | null => {
  const found = codexLegacyRegistration(configFile);
  const legacy = {
    plugin: found.plugin || options.installed === true,
    marketplace: found.marketplace || options.installed === true,
  };
  if (!legacy.marketplace && !legacy.plugin) return null;
  const steps: CodexStep[] = [];
  if (legacy.plugin)
    steps.push({
      args: ["plugin", "remove", `workit@${CODEX_LEGACY_MARKETPLACE}`],
      purpose: "Remove the Workit Codex plugin registered under the old marketplace name",
    });
  if (legacy.marketplace)
    steps.push({
      args: ["plugin", "marketplace", "remove", CODEX_LEGACY_MARKETPLACE],
      purpose: "Remove the Workit Codex marketplace registered under the old name",
    });
  steps.push(
    hasMarketplace(tableHeaders(configFile), CODEX_MARKETPLACE)
      ? {
          args: ["plugin", "marketplace", "upgrade", CODEX_MARKETPLACE],
          purpose: "Refresh the Workit Codex marketplace",
        }
      : {
          args: ["plugin", "marketplace", "add", CODEX_MARKETPLACE_URL],
          purpose: "Register the Workit Codex marketplace",
        },
    {
      args: ["plugin", "add", `workit@${CODEX_MARKETPLACE}`, ...(options.json ? ["--json"] : [])],
      purpose: "Install the Workit Codex plugin",
    },
  );
  return steps;
};

/** The migration as one shell line, for a failed row's fix. */
export const codexMigrationFix = (configFile: string, installed = false): string =>
  (codexMigrationSteps(configFile, { installed }) ?? [])
    .map((step) => `codex ${step.args.join(" ")}`)
    .join(" && ");
