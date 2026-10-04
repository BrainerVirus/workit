// Named checks (design §2.1 S9 `workit check`; D5, D14). A check is *named*
// (configured) when its name is in the repo's check config and the argv run is
// exactly the configured argv, run from the repository top. Only named checks
// satisfy a gate that binds to them; `workit check -- true` is ad-hoc and
// never does (design §0 #3).
//
// Config, first source that exists at the repository top:
// 1. `workit.checks.json`: `{"checks":{"test":"bun test","lint":["bun","run","lint"]}}`,
//    committed and visible in review. (Not `.workit/checks.json`: the store
//    directory is git-ignored, so a file there is never reviewed.)
// 2. package.json scripts `test`, `lint`, `typecheck`, `check`, run as
//    `<pm> run <script>` with the package manager from the lockfile.
//
// Kept separate from checks.ts (the runner) because task evaluation, and so
// every hook bundle, imports it. Plain TS over node built-ins.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The package.json scripts that count as named checks when no workit.checks.json exists. */
export const SCRIPT_CHECKS = ["test", "lint", "typecheck", "check"] as const;
export const CHECKS_FILE = "workit.checks.json";

export type NamedCheck = {
  name: string;
  /** The argv `workit check <name>` runs. */
  argv: string[];
  /** Every argv that counts as this check (the run argv plus package-manager aliases). */
  accepts: string[][];
};

export type CheckConfig = {
  /** Where the config came from; `none` when the repo configures no checks. */
  source: "workit.checks.json" | "package.json" | "none";
  /** The directory configured commands run in (the repository top). */
  root: string;
  checks: NamedCheck[];
  /** Set when the config exists but cannot be used; gates then fail closed. */
  error: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SHELL_META = /[|&;<>()$`\\*?[\]{}~!#]/u;

/**
 * Split a configured command string into argv: whitespace separated, with
 * single or double quotes grouping. Shell syntax (pipes, globs, variables,
 * redirects) is refused: configured checks never run through a shell.
 */
export function splitCommand(command: string): string[] | Error {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (started) argv.push(current);
      current = "";
      started = false;
      continue;
    }
    if (SHELL_META.test(char))
      return new Error(`"${command}" uses shell syntax (${char}); configure an argv array instead`);
    current += char;
    started = true;
  }
  if (quote) return new Error(`"${command}" has an unterminated quote`);
  if (started) argv.push(current);
  return argv.length ? argv : new Error("empty command");
}

const git = (cwd: string, args: string[]): string | null => {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  const value = run.status === 0 ? (run.stdout ?? "").trim() : "";
  return value || null;
};

/** The repository top for `cwd`, or `cwd` itself outside git. */
export function checkRoot(cwd: string): string {
  return path.resolve(git(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd);
}

const packageManager = (root: string): "bun" | "pnpm" | "yarn" | "npm" => {
  const has = (file: string) => fs.existsSync(path.join(root, file));
  if (has("bun.lock") || has("bun.lockb")) return "bun";
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  return "npm";
};

const scriptCheck = (pm: ReturnType<typeof packageManager>, name: string): NamedCheck => {
  const argv = [pm, "run", name];
  const accepts = [argv];
  // `bun test` is bun's own runner, not the script; npm only aliases `test`.
  if (pm === "pnpm" || pm === "yarn" || (pm === "npm" && name === "test")) accepts.push([pm, name]);
  return { name, argv, accepts };
};

const CHECK_NAME = /^[a-z0-9][a-z0-9:._-]{0,63}$/u;

/** The named checks for the repository containing `cwd` (see the header). */
export function loadCheckConfig(cwd: string): CheckConfig {
  const root = checkRoot(cwd);
  const file = path.join(root, CHECKS_FILE);
  const none = (error: string | null = null): CheckConfig => ({
    source: error ? CHECKS_FILE : "none",
    root,
    checks: [],
    error,
  });
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return none(`cannot read ${CHECKS_FILE}: ${(error as Error).message}`);
  }
  if (text !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return none(`${CHECKS_FILE} is not valid JSON`);
    }
    if (!isRecord(parsed) || !isRecord(parsed.checks))
      return none(`${CHECKS_FILE} must be {"checks":{"<name>":"<command>"|["argv",…]}}`);
    const checks: NamedCheck[] = [];
    for (const [name, value] of Object.entries(parsed.checks)) {
      if (!CHECK_NAME.test(name))
        return none(`${CHECKS_FILE}: check name "${name}" must match ${CHECK_NAME.source}`);
      const argv =
        typeof value === "string"
          ? splitCommand(value)
          : Array.isArray(value) &&
              value.length > 0 &&
              value.every((item) => typeof item === "string" && item.length > 0)
            ? (value as string[])
            : new Error("expected a command string or a non-empty argv array");
      if (argv instanceof Error) return none(`${CHECKS_FILE}: check "${name}": ${argv.message}`);
      checks.push({ name, argv, accepts: [argv] });
    }
    return { source: CHECKS_FILE, root, checks, error: null };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return none();
  }
  const scripts = isRecord(manifest) && isRecord(manifest.scripts) ? manifest.scripts : {};
  const pm = packageManager(root);
  const checks = SCRIPT_CHECKS.filter((name) => {
    const script = scripts[name];
    return typeof script === "string" && script.trim() !== "";
  }).map((name) => scriptCheck(pm, name));
  return checks.length ? { source: "package.json", root, checks, error: null } : none();
}

const sameArgv = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index]);

/**
 * Is a run of `argv` from `cwd` (relative to the repo top, posix) the named
 * check `name`? Only an exact argv match from the repository top counts.
 */
export function matchesNamedCheck(
  config: CheckConfig,
  name: string | null,
  argv: readonly string[],
  cwd: string,
): boolean {
  if (config.error || name === null || cwd !== ".") return false;
  const check = config.checks.find((item) => item.name === name);
  return Boolean(check?.accepts.some((accepted) => sameArgv(accepted, argv)));
}

/**
 * The named checks a gate of `dimension` binds to: `testing` binds to `test`
 * when it is configured, otherwise (and for `verification`) to any configured
 * check. Empty means the repo configures none and ad-hoc observed checks
 * satisfy the gate (D14).
 */
export function gateCheckNames(config: CheckConfig, dimension: string): string[] {
  const names = config.checks.map((check) => check.name);
  if (dimension === "testing" && names.includes("test")) return ["test"];
  return names;
}
