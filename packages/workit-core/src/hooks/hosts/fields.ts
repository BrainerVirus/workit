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

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "pwsh", "powershell", "cmd"]);
/** `-c`, `-lc`, `-ec`…, PowerShell `-Command`, and cmd `/c`. */
const SCRIPT_FLAG = /^(?:-\w*c|-command|\/c)$/i;
const quoteArg = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg));

/**
 * A shell command as one string. Hosts send either a string or an argv array.
 * For a shell wrapper (`[bash, -e, -c, script]`, `[powershell.exe, -Command,
 * script]`, `[cmd, /c, script]`) the script after the first script flag is
 * the command; other arrays are joined with quoting so one argument never splits.
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
  if (SHELLS.has(shell))
    for (let index = 1; index < argv.length - 1; index++) {
      if (SCRIPT_FLAG.test(argv[index])) return nonEmpty(argv[index + 1]) ? argv[index + 1] : null;
      // Other options may precede the script flag; a positional ends the scan.
      if (!/^[-/]/.test(argv[index])) break;
    }
  const joined = argv.map(quoteArg).join(" ");
  return nonEmpty(joined) ? joined : null;
};

const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "applypatch",
  "patch",
  "delete",
  "remove",
  "rename",
  "mkdir",
  "mv",
  "cp",
  "touch",
  "strreplace",
  "searchreplace",
  "editfile",
  "writefile",
]);
/** A host tool that writes files (Claude Edit/Write, Cursor Write/Delete, apply_patch…). */
export const isWriteTool = (name: unknown): boolean =>
  typeof name === "string" && WRITE_TOOLS.has(name.toLowerCase().replace(/[_-]/g, ""));

const PATH_KEYS = ["file_path", "filePath", "notebook_path", "path", "target_file", "file"];
/** apply_patch file headers. Codex trims patch lines, so an indented header still applies. */
const PATCH_HEADER = /^[ \t]*\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;

/** The files a write tool names: its path fields, or the files of an apply_patch body. */
export const writePaths = (input: unknown): string[] => {
  if (!isRecord(input)) return [];
  const paths = PATH_KEYS.map((key) => input[key]).filter(nonEmpty);
  for (const value of Object.values(input))
    if (typeof value === "string")
      for (const match of value.matchAll(PATCH_HEADER)) paths.push(match[1].trim());
  return [...new Set(paths)];
};

/** A write tool's targets for the before-write gate: null (unknown, so gated) when none parse. */
export const writeTargets = (input: unknown): string[] | null => {
  const paths = writePaths(input);
  return paths.length > 0 ? paths : null;
};
