// Named checks (design §2.1 S9 `workit check`; D5, D14). A check is *named*
// (configured) when its name is in the repo's check config and the argv run is
// exactly the configured argv, run from the repository top. Only named checks
// satisfy a gate that binds to them; `workit check -- true` is ad-hoc and
// never does (design §0 #3).
//
// Config, first source that exists at the repository top:
// 1. `.workit/checks.json`: `{"checks":{"test":"bun test","lint":["bun","run","lint"]},
//    "gates":{"testing":"test"},"groups":{"ci":["lint","test"]}}`. A *group* is
//    a named list of configured checks that `workit check <group>` runs one by
//    one; the `ci` group is the checks the repo's CI runs, so a PR never goes
//    red on a gate that never ran locally. Per-repo workit config lives in
//    `.workit/`, which holds only committed team config (per-clone data lives
//    in `<git-common-dir>/workit/`), never at the repo root. A legacy root
//    `workit.checks.json` is still read when `.workit/checks.json` is absent,
//    with a note that it moved.
//    In a linked worktree (a fanout slice's, an agent's) that has neither
//    file, the main checkout's is read: a config not committed yet (or
//    ignored by an older Workit's `.workit/.gitignore`) is not in a new worktree,
//    which shares the main checkout's checks (#426). Configured commands
//    still run from the worktree's own top.
//    `cleanup.regenerable` lists repo-relative globs (`*`, `**`) of generated,
//    git-ignored dirs; cleanup (core/cleanup.ts) discards ignored files under
//    them, on top of its built-in list, when it removes a merged worktree.
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
import { gitDirs } from "./git/facts";

/** The package.json scripts that count as named checks when no checks config exists. */
export const SCRIPT_CHECKS = ["test", "lint", "typecheck", "check"] as const;
/** Scripts run as a check under another name: `test:packaging` is `workit check packaging` (#509). */
const SCRIPT_CHECK_ALIASES = { packaging: "test:packaging" } as const;
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

/** The `.workit/.gitignore` bodies older Workit wrote to make the dir self-ignoring. */
const GENERATED_GITIGNORES = new Set(["*\n", "*\n!risk-paths\n"]);

/**
 * Create `<root>/.workit/` (idempotent) and return the dir. It holds committed
 * team config only, so a self-ignoring `.gitignore` an older Workit wrote
 * (`*`, or `*` with `!risk-paths`) is removed; any other `.gitignore` is the
 * repo's own and kept.
 */
export function ensureWorkitDir(root: string): string {
  const dir = path.join(root, ".workit");
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  try {
    if (GENERATED_GITIGNORES.has(fs.readFileSync(ignore, "utf8"))) fs.rmSync(ignore);
  } catch {}
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
  /** Named lists of configured checks (`groups.ci`: what CI runs); `workit check <group>` runs each member. */
  groups: Record<string, string[]>;
  /** Set when the config exists but cannot be used; gates then fail closed. */
  error: string | null;
  /** One line for the user when the config was read from the legacy root file. */
  note?: string;
  /** The raw `resources` block of the checks config (heavy-check limits; core/resources.ts reads it). */
  resources?: unknown;
  /** `cleanup.regenerable`: repo globs of generated, ignored dirs that cleanup may discard. */
  regenerable?: string[];
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
  return path.resolve(gitDirs(cwd)?.top ?? cwd);
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
    for (const [name, script] of Object.entries(SCRIPT_CHECK_ALIASES)) {
      const body = scripts[script];
      if (typeof body === "string" && body.trim() !== "") add({ ...scriptCheck(pm, script), name });
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

/** What the cleanup matcher (core/workspaces.ts matchWorkspace) supports: `*` and `**`. */
const UNSUPPORTED_GLOB = /[?[\]{}!\\]|[@+*]\(/u;
const REGENERABLE_SHAPE =
  'cleanup.regenerable must be a list of repo-relative globs (["packages/*/skills"])';

/** `cleanup` of the checks config: the regenerable globs (trailing `/` dropped), or why it is invalid. */
function cleanupGlobs(value: unknown): string[] | Error {
  if (value === undefined) return [];
  if (!isRecord(value)) return new Error('cleanup must be {"regenerable":["<glob>",…]}');
  const unknown = Object.keys(value).find((key) => key !== "regenerable");
  if (unknown) return new Error(`cleanup.${unknown} is not a setting (use cleanup.regenerable)`);
  const list = value.regenerable ?? [];
  if (!Array.isArray(list)) return new Error(REGENERABLE_SHAPE);
  const globs: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") return new Error(REGENERABLE_SHAPE);
    const glob = item.trim().replace(/\/+$/u, "");
    if (!glob || glob.startsWith("/") || glob.split("/").includes(".."))
      return new Error(`${REGENERABLE_SHAPE}; "${item}" is not repo-relative`);
    if (UNSUPPORTED_GLOB.test(glob))
      return new Error(`${REGENERABLE_SHAPE}; "${item}" uses syntax beyond * and **`);
    // A last segment of only wildcards ("*", "**", "dist/**") names every ignored
    // file under it, `.env` included: cleanup would discard what it must keep.
    if (/^\*+$/u.test(glob.split("/").at(-1) ?? ""))
      return new Error(
        `${REGENERABLE_SHAPE}; "${item}" ends in a bare wildcard, which would discard ignored files such as .env: name the generated dir`,
      );
    globs.push(glob);
  }
  return globs;
}

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
    groups: {},
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
    return checks.length
      ? { source: "defaults", root, checks, gates: {}, groups: {}, error: null }
      : none();
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
  const groups: CheckConfig["groups"] = {};
  if (parsed.groups !== undefined) {
    if (!isRecord(parsed.groups)) return none(`${label}: groups must be {"ci":["<name>",…]}`);
    for (const [group, value] of Object.entries(parsed.groups)) {
      if (!CHECK_NAME.test(group))
        return none(`${label}: group name "${group}" must match ${CHECK_NAME.source}`);
      if (checks.some((c) => c.name === group))
        return none(`${label}: group "${group}" has the name of a configured check`);
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        !value.every((name) => typeof name === "string" && checks.some((c) => c.name === name))
      )
        return none(`${label}: groups.${group} must be a non-empty list of configured checks`);
      groups[group] = [...new Set(value as string[])];
    }
  }
  const regenerable = cleanupGlobs(parsed.cleanup);
  if (regenerable instanceof Error) return none(`${label}: ${regenerable.message}`);
  return {
    source: label,
    root,
    checks,
    gates,
    groups,
    error: null,
    ...note,
    resources: parsed.resources,
    regenerable,
  };
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
