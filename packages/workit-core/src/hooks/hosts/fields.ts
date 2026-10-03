// Lenient field readers for native hook payloads (D17): unknown keys are
// ignored, and only the keys a mapping needs are checked.
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

export const optionalText = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** The canonical path of an existing absolute directory, or null. */
export const existingDirectory = (value: unknown): string | null => {
  if (!nonEmpty(value) || !path.isAbsolute(value) || !existsSync(value)) return null;
  try {
    return statSync(value).isDirectory() ? realpathSync(value) : null;
  } catch {
    return null;
  }
};

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "pwsh", "powershell"]);
const quoteArg = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg));

/**
 * A shell command as one string. Hosts send either a string or an argv array;
 * `[shell, "-c"|"-lc", script]` yields the script itself, other arrays are
 * joined with quoting so a single argument never splits.
 */
export const commandText = (value: unknown): string | null => {
  if (nonEmpty(value)) return value;
  if (!Array.isArray(value) || value.length === 0) return null;
  const argv: unknown[] = value;
  if (!argv.every((arg): arg is string => typeof arg === "string")) return null;
  const shell =
    argv[0]
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/\.exe$/i, "")
      .toLowerCase() ?? "";
  if (argv.length >= 3 && SHELLS.has(shell) && /^-\w*c$/i.test(argv[1]) && nonEmpty(argv[2]))
    return argv[2];
  const joined = argv.map(quoteArg).join(" ");
  return nonEmpty(joined) ? joined : null;
};
