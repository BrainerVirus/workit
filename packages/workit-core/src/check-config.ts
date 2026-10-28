// Named checks (design §2.1 S9 `workit check`; D5, D14). A check is *named*
// (configured) when its name is in the repo's check config and the argv run is
// exactly the configured argv, run from the repository top. Only named checks
// satisfy a gate that binds to them; `workit check -- true` is ad-hoc and
// never does (design §0 #3).
//
// Config, first source that exists at the repository top:
// 1. `.workit/checks.json`: `{"checks":{"test":"bun test","lint":["bun","run","lint"]},
//    "gates":{"testing":"test"}}`. Per-repo workit config lives in the
//    self-ignoring `.workit/`, never at the repo root. A legacy root
//    `workit.checks.json` is still read when `.workit/checks.json` is absent,
//    with a note that it moved.
//    In a linked worktree (a fanout slice's, an agent's) that has neither
//    file, the main checkout's is read: `.workit/` is git-ignored, so a new
//    worktree never has one, and it shares the main checkout's checks
//    (#426). Configured commands still run from the worktree's own top.
// 2. Built-in ecosystem defaults detected from the repo: package.json scripts
//    `test`, `lint`, `typecheck`, `check` (`<pm> run <script>`, pm from the
//    lockfile); go.mod → `go test ./...`; Cargo.toml → `cargo test`;
//    pytest.ini or a pyproject.toml that mentions pytest → `pytest`; a Makefile
//    `test:` target → `make test`. The first source to define a name wins.
//
// Gates: `testing` binds to `gates.testing` (default `test`), `verification`
// to `gates.verification` (default: every configured check). Ad-hoc runs never
// satisfy a gate; with nothing configured the gate says to add the file.
//
// Kept separate from checks.ts (the runner) because task evaluation, and so
// every hook bundle, imports it. Plain TS over node built-ins.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The package.json scripts that count as named checks when no checks config exists. */
export const SCRIPT_CHECKS = ["test", "lint", "typecheck", "check"] as const;
export const CHECKS_FILE = ".workit/checks.json";
export const LEGACY_CHECKS_FILE = "workit.checks.json";

/**
 * Where the repo's checks config lives under the repository top `root` (the
 * one path resolver): `.workit/checks.json`, else the legacy root file when
 * only that exists, else the `.workit/` path a new config belongs at.
 */
export function checksConfigFile(root: string): string {
  const current = path.join(root, CHECKS_FILE);
  const legacy = path.join(root, LEGACY_CHECKS_FILE);
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}

const WORKIT_GITIGNORE = "*\n!risk-paths\n";

/**
 * Create `<root>/.workit/` with its `.gitignore` (idempotent) and return the
 * dir. It ignores everything but `risk-paths`, which a repo commits; the old
 * `*` alone is rewritten.
 */
export function ensureWorkitDir(root: string): string {
  const dir = path.join(root, ".workit");
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore) || fs.readFileSync(ignore, "utf8") === "*\n")
    fs.writeFileSync(ignore, WORKIT_GITIGNORE);
  return dir;
}

/**
 * `resources.heavyCommands` of the repo's checks config under `root`, read
 * leniently (no git, no check validation): the heavy-command gate's patterns.
 */
export function repoHeavyCommands(root: string): string[] {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(checksConfigFile(root), "utf8"));
    const resources = isRecord(value) ? value.resources : undefined;
    const list = isRecord(resources) ? resources.heavyCommands : undefined;
    return Array.isArray(list)
      ? list.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export type NamedCheck = {
  name: string;
  /** The argv `workit check <name>` runs. */
  argv: string[];
  /** Every argv that counts as this check (the run argv plus package-manager aliases). */
  accepts: string[][];
};

export type CheckConfig = {
  /** Where the config came from; `defaults` = detected ecosystem defaults, `none` = nothing. */
  source: typeof CHECKS_FILE | typeof LEGACY_CHECKS_FILE | "defaults" | "none";
  /** The directory configured commands run in (the repository top). */
  root: string;
  checks: NamedCheck[];
  /** Explicit gate bindings from the checks config (`gates.testing`, `gates.verification`). */
  gates: Partial<Record<"testing" | "verification", string[]>>;
  /** Set when the config exists but cannot be used; gates then fail closed. */
  error: string | null;
  /** One line for the user when the config was read from the legacy root file. */
  note?: string;
  /** The raw `resources` block of the checks config (heavy-check limits; core/resources.ts reads it). */
  resources?: unknown;
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

/** Built-in ecosystem defaults detected at `root` (see the header). */
function detectedChecks(root: string): NamedCheck[] {
  const read = (file: string): string | null => {
    try {
      return fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      return null;
    }
  };
  const checks: NamedCheck[] = [];
  const add = (check: NamedCheck) => {
    if (!checks.some((item) => item.name === check.name)) checks.push(check);
  };
  const manifestText = read("package.json");
  if (manifestText !== null) {
    let manifest: unknown = null;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      // An unparsable package.json defines no scripts.
    }
    const scripts = isRecord(manifest) && isRecord(manifest.scripts) ? manifest.scripts : {};
    const pm = packageManager(root);
    for (const name of SCRIPT_CHECKS) {
      const script = scripts[name];
      if (typeof script === "string" && script.trim() !== "") add(scriptCheck(pm, name));
    }
  }
  const plain = (name: string, argv: string[]): NamedCheck => ({ name, argv, accepts: [argv] });
  if (read("go.mod") !== null) add(plain("test", ["go", "test", "./..."]));
  if (read("Cargo.toml") !== null) add(plain("test", ["cargo", "test"]));
  if (read("pytest.ini") !== null || /\bpytest\b/u.test(read("pyproject.toml") ?? ""))
    add(plain("test", ["pytest"]));
  const makefile = read("Makefile") ?? read("makefile") ?? read("GNUmakefile");
  if (makefile !== null && /^test\s*:(?!=)/mu.test(makefile)) add(plain("test", ["make", "test"]));
  return checks;
}

const GATES = ["testing", "verification"] as const;

/**
 * The checks config file for `root`: its own, else (in a linked worktree
 * without one) the main checkout's, else the path a new config belongs at.
 */
function configFileFor(root: string): string {
  const own = checksConfigFile(root);
  if (fs.existsSync(own)) return own;
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common || path.basename(common) !== ".git") return own;
  const main = path.dirname(common);
  if (path.resolve(main) === path.resolve(root)) return own;
  const shared = checksConfigFile(main);
  return fs.existsSync(shared) ? shared : own;
}

/** The named checks for the repository containing `cwd` (see the header). */
export function loadCheckConfig(cwd: string): CheckConfig {
  const root = checkRoot(cwd);
  const file = configFileFor(root);
  const legacy = path.basename(file) === LEGACY_CHECKS_FILE;
  const label = legacy ? LEGACY_CHECKS_FILE : CHECKS_FILE;
  const note = legacy
    ? {
        note: `${LEGACY_CHECKS_FILE} is deprecated; move it to ${CHECKS_FILE} (workit doctor --fix)`,
      }
    : {};
  const none = (error: string | null = null): CheckConfig => ({
    source: error ? label : "none",
    root,
    checks: [],
    gates: {},
    error,
    ...note,
  });
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return none(`cannot read ${label}: ${(error as Error).message}`);
  }
  if (text === null) {
    const checks = detectedChecks(root);
    return checks.length ? { source: "defaults", root, checks, gates: {}, error: null } : none();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return none(`${label} is not valid JSON`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.checks))
    return none(`${label} must be {"checks":{"<name>":"<command>"|["argv",…]}}`);
  const checks: NamedCheck[] = [];
  for (const [name, value] of Object.entries(parsed.checks)) {
    if (!CHECK_NAME.test(name))
      return none(`${label}: check name "${name}" must match ${CHECK_NAME.source}`);
    const argv =
      typeof value === "string"
        ? splitCommand(value)
        : Array.isArray(value) &&
            value.length > 0 &&
            value.every((item) => typeof item === "string" && item.length > 0)
          ? (value as string[])
          : new Error("expected a command string or a non-empty argv array");
    if (argv instanceof Error) return none(`${label}: check "${name}": ${argv.message}`);
    checks.push({ name, argv, accepts: [argv] });
  }
  const gates: CheckConfig["gates"] = {};
  if (parsed.gates !== undefined) {
    if (!isRecord(parsed.gates))
      return none(`${label}: gates must be {"testing":"<name>"|["<name>",…]}`);
    for (const [gate, value] of Object.entries(parsed.gates)) {
      if (!(GATES as readonly string[]).includes(gate))
        return none(`${label}: unknown gate "${gate}" (use ${GATES.join(" or ")})`);
      const names = typeof value === "string" ? [value] : value;
      if (
        !Array.isArray(names) ||
        names.length === 0 ||
        !names.every((name) => typeof name === "string" && checks.some((c) => c.name === name))
      )
        return none(`${label}: gates.${gate} must name configured checks`);
      gates[gate as (typeof GATES)[number]] = names as string[];
    }
  }
  return { source: label, root, checks, gates, error: null, ...note, resources: parsed.resources };
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
 * The named checks a gate of `dimension` binds to: `gates.<dimension>` when
 * set, else `testing` → `test` (only when configured) and `verification` →
 * every configured check. Empty means nothing can satisfy the gate: ad-hoc
 * runs never do (D14).
 */
export function gateCheckNames(config: CheckConfig, dimension: string): string[] {
  const explicit = config.gates[dimension as (typeof GATES)[number]];
  if (explicit) return explicit;
  const names = config.checks.map((check) => check.name);
  if (dimension === "testing") return names.includes("test") ? ["test"] : [];
  return names;
}

let workitOnPath: boolean | undefined;

/** Is a `workit` executable on PATH (PATHEXT-aware on Windows)? Probed once per process. */
export function workitAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (workitOnPath !== undefined) return workitOnPath;
  const windows = process.platform === "win32";
  const exts = windows ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  workitOnPath = dirs.some((dir) =>
    exts.some((ext) => {
      try {
        return fs.statSync(path.join(dir, `workit${ext}`)).isFile();
      } catch {
        return false;
      }
    }),
  );
  return workitOnPath;
}

/**
 * The command that runs `workit check <args>`: plain `workit` when it is on
 * PATH, else a pinned `npx -y @brainervirus/workit-cli@<version>` fallback.
 */
export function checkCommand(args: string, version: string, onPath = workitAvailable()): string {
  return onPath
    ? `workit check ${args}`
    : `npx -y @brainervirus/workit-cli@${version} check ${args}`;
}
