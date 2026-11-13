import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CODEX_MARKETPLACE,
  CODEX_MARKETPLACE_URL,
  codexMigrationSteps,
} from "../upgrade/codex-marketplace";

export type HostId = "opencode" | "cursor" | "codex" | "pi" | "claude-code";

/** A reviewed argv vector. Arguments are never composed into a shell string. */
export type HostInstallCommand = {
  command: string;
  args: string[];
  cwd?: string;
  purpose: string;
  /** Optional managed package tree to stage, for Cursor's local plugin copy. */
  packageRoot?: string;
  packageTarget?: string;
  skipWhenOutputIncludes?: string;
};

export type HostCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type HostCommandRunner = (step: HostInstallCommand) => HostCommandResult;
export type HostCommandContext = { home?: string; env?: NodeJS.ProcessEnv };

/** Why a host command cannot run: one text for the install and uninstall plans and their apply. */
export const missingExecutable = (name: string): string =>
  path.isAbsolute(name) || name.includes("/") || name.includes("\\")
    ? `${name} does not exist or is not executable`
    : `${name} executable was not found on PATH or supported user bin directories`;

export function hostCommand(
  name: string,
  args: string[],
  options: HostInstallOptions = {},
): HostInstallCommand {
  const executable = findHostExecutable(name, options);
  if (!executable) throw new Error(missingExecutable(name));
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
    const node = findHostExecutable("node", options);
    if (!node) throw new Error(`Node.js is required to run the ${name} Windows shim`);
    const script = resolveWindowsShimScript(executable);
    if (!script)
      throw new Error(`could not resolve the ${name} Windows shim to a JavaScript entrypoint`);
    return { command: node, args: [script, ...args], cwd: options.cwd, purpose: `${name} CLI` };
  }
  return { command: executable, args, cwd: options.cwd, purpose: `${name} CLI` };
}

export function resolveWindowsShimEntry(
  contents: string,
  shim: string,
  exists: (candidate: string) => boolean = existsSync,
): string | null {
  const root = path.win32.dirname(shim);
  const matches = contents.matchAll(/(["']?)([^\r\n"']*node_modules[\\/][^\r\n"']+?\.js)\1/gi);
  for (const match of matches) {
    const raw = match[2].replace(/%~?dp0%?/gi, root);
    const candidate = path.win32.isAbsolute(raw) ? raw : path.win32.resolve(root, raw);
    if (exists(candidate)) return candidate;
  }
  return null;
}

const resolveWindowsShimScript = (shim: string): string | null => {
  try {
    const contents = readFileSync(shim, "utf8");
    return resolveWindowsShimEntry(contents, shim);
  } catch {
    return null;
  }
};

export type HostInstallOptions = {
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  packageVersion?: string;
  alreadyInstalled?: boolean;
  targetDir?: string;
  mode?: "install" | "upgrade";
  /** Also reinstall a registered install whose plugin files are missing or broken
   *  (Claude Code, Pi); without it a registered host plans nothing, as setup does. */
  repair?: boolean;
  /** Pi: where `pi list` says the Workit package is installed, when known. */
  piPackageRoot?: string | null;
};

/** Claude Code reads the git-hosted marketplace at the repo root
 * (`.claude-plugin/marketplace.json`, name `workit`); its entry installs the
 * published npm package. */
const CLAUDE_MARKETPLACE_REPO = "BrainerVirus/workit";
export const CLAUDE_MARKETPLACE_NAME = "workit";
const CLAUDE_PLUGIN_ID = `workit@${CLAUDE_MARKETPLACE_NAME}`;
const validPackageVersion = (value: string): boolean =>
  value === "latest" || /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);

const nodePrerequisite = (options: HostInstallOptions): HostInstallCommand => {
  const node = findHostExecutable("node", options);
  if (!node) throw new Error("Workit host packages require Node.js 24+; install Node.js and retry");
  return {
    command: node,
    args: [
      "-e",
      'const v=Number(process.versions.node.split(".")[0]);if(v<24){console.error(`Workit host packages require Node.js 24+ (found ${process.versions.node})`);process.exit(1)}',
    ],
    cwd: options.cwd,
    purpose: "Check the Node.js 24+ package runtime requirement",
  };
};

/** Resolve host executables through PATH plus common user-level Node managers. */
export function findHostExecutable(
  name: string,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): string | null {
  // An absolute or explicitly relative executable is used as given, never searched on PATH.
  if (path.isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    try {
      if (!statSync(name).isFile()) return null;
      if (process.platform !== "win32") accessSync(name, constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? os.homedir();
  const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  dirs.push(path.join(home, ".local", "bin"), path.join(home, ".asdf", "shims"));
  for (const [base, tail] of [
    [path.join(home, ".local", "share", "fnm", "node-versions"), path.join("installation", "bin")],
    [path.join(home, ".nvm", "versions", "node"), "bin"],
  ] as const) {
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(path.join(base, entry.name, tail));
      }
    } catch {
      // A missing version-manager directory is normal.
    }
  }
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${name}${suffix}`);
      try {
        if (statSync(candidate).isFile()) {
          if (process.platform === "win32") return candidate;
          accessSync(candidate, constants.X_OK);
          return candidate;
        }
      } catch {
        // Continue through PATH entries and platform shims.
      }
    }
  }
  return null;
}

export const isPiWorkitInstalled = (
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  const settings = path.join(
    env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent"),
    "settings.json",
  );
  try {
    const document = JSON.parse(readFileSync(settings, "utf8")) as { packages?: unknown[] };
    return (document.packages ?? []).some((entry) => {
      const source =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as { source?: unknown }).source
          : entry;
      const value = String(source).replaceAll("\\", "/").replace(/\/+$/, "");
      return (
        /^npm:@workit-dev\/pi(?:@[^/]+)?$/.test(value) ||
        value === "@workit-dev/pi" ||
        /(?:^|\/)packages\/workit-pi$/.test(value)
      );
    });
  } catch {
    return false;
  }
};

/**
 * Why a host's own JSON file cannot be read, as `cannot read <file>: <why>:
 * not repaired`; null when it is missing or readable. `shape` names a key
 * with the wrong shape. Nothing plans a rewrite of a file it cannot read.
 */
export const hostFileProblem = (
  file: string,
  shape: (value: Record<string, unknown>) => string | null = () => null,
): string | null => {
  if (!existsSync(file)) return null;
  const problem = (why: string) => `cannot read ${file}: ${why}: not repaired`;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return problem("not readable");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return problem("not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return problem("not a JSON object");
  const why = shape(value as Record<string, unknown>);
  return why ? problem(why) : null;
};

const piSettingsFile = (home: string, env: NodeJS.ProcessEnv): string =>
  path.join(env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent"), "settings.json");

/** Pi's user settings, when they cannot be read. */
export const piSettingsProblem = (home: string, env: NodeJS.ProcessEnv = process.env) =>
  hostFileProblem(piSettingsFile(home, env), (settings) =>
    settings.packages !== undefined && !Array.isArray(settings.packages)
      ? "`packages` is not a list"
      : null,
  );

const PI_PACKAGE = "@workit-dev/pi";
const PI_EXTENSION = "dist/workit.js";

/** The user-scope Pi entry for Workit and the state of Pi's install of it. */
export type PiWorkitPackage = {
  source: string;
  root: string;
  /** An npm entry Pi installs itself; false for a local checkout. */
  npm: boolean;
  state: "ok" | "missing" | "not-loading";
};

/**
 * The Workit entry in Pi's user settings and whether Pi installed it: an npm
 * entry lives under `<agent dir>/npm/node_modules` (where doctor's
 * pi_extension looks) unless `pi list` named another root. `missing` has no
 * package there, `not-loading` has one without its extension. Read-only.
 */
export const piWorkitPackage = (
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  listedRoot: string | null = null,
): PiWorkitPackage | null => {
  const agentDir = env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent");
  let packages: unknown;
  try {
    packages = (
      JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8")) as {
        packages?: unknown;
      }
    ).packages;
  } catch {
    return null;
  }
  if (!Array.isArray(packages)) return null;
  for (const entry of packages) {
    const source =
      typeof entry === "string"
        ? entry
        : typeof (entry as { source?: unknown })?.source === "string"
          ? (entry as { source: string }).source
          : null;
    if (!source) continue;
    const npm = /^(?:npm:)?@workit-dev\/pi(?:@[^/]+)?$/.test(source);
    const local = !npm && /(?:^|\/)packages\/workit-pi$/.test(source.replaceAll("\\", "/"));
    if (!npm && !local) continue;
    const root = npm
      ? (listedRoot ?? path.join(agentDir, "npm", "node_modules", ...PI_PACKAGE.split("/")))
      : path.resolve(agentDir, source.replace(/^~(?=\/|\\)/, home));
    const named = packageVersionAt(root, PI_PACKAGE) !== null;
    return {
      source,
      root,
      npm,
      state: !named ? "missing" : existsSync(path.join(root, PI_EXTENSION)) ? "ok" : "not-loading",
    };
  }
  return null;
};

const OPENCODE_PLUGIN_SCOPE = "@workit-dev";
const OPENCODE_PLUGIN_NAME = "opencode";

const packageVersionAt = (root: string, name: string): string | null => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return pkg.name === name && typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
};

const compareVersions = (a: string, b: string): number => {
  const pa = a.split(/[.+-]/).map((n) => Number(n) || 0);
  const pb = b.split(/[.+-]/).map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/** OpenCode's own cache root (`$XDG_CACHE_HOME/opencode`, default `~/.cache/opencode`). */
const openCodeCacheDir = (home: string, env: NodeJS.ProcessEnv = process.env): string =>
  path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "opencode");

const subdirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
};

/**
 * The newest workit-opencode package OpenCode installed for itself for the
 * floating pin Workit writes (`@latest`). OpenCode 2.x keeps each resolve under
 * `npm/<scope>/<name>@latest/<stamp>/node_modules`, 1.x under
 * `packages/<scope>/<name>@latest/node_modules` (both measured on installed
 * hosts). An exact-version pin's cache is not the floating install. Read-only.
 */
export const openCodeInstalledPlugin = (
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): { root: string; version: string } | null => {
  const name = `${OPENCODE_PLUGIN_SCOPE}/${OPENCODE_PLUGIN_NAME}`;
  const cache = openCodeCacheDir(home, env);
  const specDirs = (layout: string): string[] =>
    subdirs(path.join(cache, layout, OPENCODE_PLUGIN_SCOPE)).filter(
      (dir) => path.basename(dir) === `${OPENCODE_PLUGIN_NAME}@latest`,
    );
  const installs = [...specDirs("npm").flatMap(subdirs), ...specDirs("packages")].map((dir) =>
    path.join(dir, "node_modules", OPENCODE_PLUGIN_SCOPE, OPENCODE_PLUGIN_NAME),
  );
  let best: { root: string; version: string } | null = null;
  for (const root of installs) {
    const version = packageVersionAt(root, name);
    if (version && (!best || compareVersions(version, best.version) > 0)) best = { root, version };
  }
  return best;
};

const isCanonicalCodexPackage = (root: string): boolean => {
  for (const file of [
    path.join(root, ".codex-plugin", "plugin.json"),
    path.join(root, "package.json"),
  ]) {
    try {
      const manifest = JSON.parse(readFileSync(file, "utf8")) as {
        name?: string;
        repository?: string | { url?: string };
      };
      const repository =
        typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
      if (
        (manifest.name === "workit" || manifest.name === "@workit-dev/codex") &&
        repository?.replace(/\.git$/, "").toLowerCase() === "https://github.com/brainervirus/workit"
      )
        return true;
    } catch {
      // Try the other manifest path.
    }
  }
  return false;
};

export const isCodexWorkitInstalled = (
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  const codexHome = env.CODEX_HOME ?? path.join(home, ".codex");
  const isPackageOrVersionDirectory = (root: string): boolean => {
    if (isCanonicalCodexPackage(root)) return true;
    try {
      return readdirSync(root, { withFileTypes: true }).some(
        (entry) => entry.isDirectory() && isCanonicalCodexPackage(path.join(root, entry.name)),
      );
    } catch {
      return false;
    }
  };
  if (isPackageOrVersionDirectory(path.join(codexHome, "plugins", "workit"))) return true;
  const root = path.join(codexHome, "plugins", "cache");
  try {
    for (const marketplace of readdirSync(root, { withFileTypes: true })) {
      if (!marketplace.isDirectory()) continue;
      if (isPackageOrVersionDirectory(path.join(root, marketplace.name, "workit"))) return true;
    }
  } catch {
    return false;
  }
  return false;
};

/** Claude Code's config root (`CLAUDE_CONFIG_DIR`, default `~/.claude`). */
export const claudeConfigDir = (home: string, env: NodeJS.ProcessEnv = process.env): string =>
  env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");

type ClaudeInstallScope = "user" | "project" | "local";

export type ClaudeWorkitInstall = {
  id: string;
  version: string | null;
  installPath: string;
  scope: ClaudeInstallScope;
  /** The project a project/local-scope install belongs to; null for user scope. */
  projectPath: string | null;
};

const CLAUDE_SCOPES = new Set<string>(["user", "project", "local"]);

/** A project/local install applies to `cwd` when cwd is inside its project. */
const appliesTo = (install: ClaudeWorkitInstall, cwd: string | null): boolean => {
  if (install.scope === "user") return true;
  if (cwd === null || install.projectPath === null) return false;
  const relative = path.relative(path.resolve(install.projectPath), path.resolve(cwd));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const isCanonicalClaudePlugin = (root: string): boolean => {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name?: string; repository?: string | { url?: string } };
    const repository =
      typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
    return (
      manifest.name === "workit" &&
      repository?.replace(/\.git$/, "").toLowerCase() === "https://github.com/brainervirus/workit"
    );
  } catch {
    return false;
  }
};

/**
 * Workit installs recorded in Claude Code's plugin registry
 * (`<config>/plugins/installed_plugins.json`, v2: `{plugins: {"name@market":
 * [{installPath, version}]}}`). Only entries whose install directory carries
 * the canonical Workit manifest count, whatever marketplace they came from.
 * Only installs that apply here count: user scope always, project/local
 * scope only when `cwd` is inside the recorded project (`cwd: null` keeps
 * user scope only). A `--plugin-dir` pin is per-session and never recorded.
 */
export const claudeWorkitInstalls = (
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string | null = process.cwd(),
): ClaudeWorkitInstall[] => {
  const file = path.join(claudeConfigDir(home, env), "plugins", "installed_plugins.json");
  let registry: unknown;
  try {
    registry = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const plugins =
    registry && typeof registry === "object" && "plugins" in registry ? registry.plugins : null;
  if (!plugins || typeof plugins !== "object") return [];
  const found: ClaudeWorkitInstall[] = [];
  for (const [id, entries] of Object.entries(plugins as Record<string, unknown>)) {
    if (!id.startsWith("workit@") || !Array.isArray(entries)) continue;
    for (const entry of entries as Array<{
      installPath?: unknown;
      version?: unknown;
      scope?: unknown;
      projectPath?: unknown;
    }>) {
      if (typeof entry?.installPath !== "string" || !isCanonicalClaudePlugin(entry.installPath))
        continue;
      // Older registries omit scope; Claude's default install scope is user.
      const scope = entry.scope === undefined ? "user" : String(entry.scope);
      if (!CLAUDE_SCOPES.has(scope)) continue; // e.g. managed: not ours to change
      const install: ClaudeWorkitInstall = {
        id,
        installPath: entry.installPath,
        version:
          typeof entry.version === "string" && /^\d+\.\d+\.\d+/.test(entry.version)
            ? entry.version
            : null,
        scope: scope as ClaudeInstallScope,
        projectPath:
          scope !== "user" && typeof entry.projectPath === "string" ? entry.projectPath : null,
      };
      if (appliesTo(install, cwd)) found.push(install);
    }
  }
  return found;
};

/**
 * User-scope `workit@*` records in Claude Code's plugin registry whose install
 * directory lost its Workit manifest: registered, so Claude Code reports the
 * plugin installed, but there is nothing for it to load.
 */
export const claudeStaleWorkitRecords = (
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] => {
  let registry: { plugins?: Record<string, unknown> } | null = null;
  try {
    registry = JSON.parse(
      readFileSync(
        path.join(claudeConfigDir(home, env), "plugins", "installed_plugins.json"),
        "utf8",
      ),
    );
  } catch {
    return [];
  }
  const plugins = registry?.plugins;
  if (!plugins || typeof plugins !== "object") return [];
  return Object.entries(plugins)
    .filter(
      ([id, entries]) =>
        id.startsWith("workit@") &&
        Array.isArray(entries) &&
        entries.some(
          (entry: { installPath?: unknown; scope?: unknown }) =>
            (entry?.scope === undefined || entry.scope === "user") &&
            !(typeof entry?.installPath === "string" && isCanonicalClaudePlugin(entry.installPath)),
        ),
    )
    .map(([id]) => id);
};

/** Claude Code's plugin registry, when it cannot be read. */
export const claudeRegistryProblem = (home: string, env: NodeJS.ProcessEnv = process.env) =>
  hostFileProblem(
    path.join(claudeConfigDir(home, env), "plugins", "installed_plugins.json"),
    ({ plugins }) => {
      if (plugins === undefined) return null;
      if (!plugins || typeof plugins !== "object" || Array.isArray(plugins))
        return "`plugins` is not an object";
      const bad = Object.entries(plugins).find(
        ([id, entries]) => id.startsWith("workit@") && !Array.isArray(entries),
      );
      return bad ? `\`${bad[0]}\` is not a list` : null;
    },
  );

/** A Workit install Claude Code loads for this user (any project). */
export const isClaudeWorkitInstalled = (
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string | null = process.cwd(),
): boolean => claudeWorkitInstalls(home, env, cwd).length > 0;

export function installedHostApp(
  host: HostId,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (candidate: string) => boolean = existsSync,
): boolean {
  const candidates: string[] = [];
  const pathApi = platform === "win32" ? path.win32 : path;
  if (platform === "darwin") {
    const app =
      host === "cursor"
        ? "Cursor.app"
        : host === "codex"
          ? "Codex.app"
          : host === "opencode"
            ? "OpenCode.app"
            : "";
    if (app) candidates.push(`/Applications/${app}`, pathApi.join(home, "Applications", app));
  } else if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? pathApi.join(home, "AppData", "Local");
    if (host === "cursor") candidates.push(pathApi.join(local, "Programs", "Cursor", "Cursor.exe"));
    if (host === "codex") candidates.push(pathApi.join(local, "Programs", "Codex", "Codex.exe"));
    if (host === "opencode")
      candidates.push(pathApi.join(local, "Programs", "OpenCode", "OpenCode.exe"));
  }
  return candidates.some(exists);
}

/** Plan the host-native registration commands used by setup and upgrade. */
export function planHostInstall(
  host: HostId,
  options: HostInstallOptions = {},
): HostInstallCommand[] {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const version = options.packageVersion ?? "latest";
  if (!validPackageVersion(version))
    throw new Error(`unsupported package version selector: ${version}`);
  if (options.alreadyInstalled && options.mode !== "upgrade") return [];
  const upgrading = options.mode === "upgrade";
  if (host === "codex") {
    const codexHome = env.CODEX_HOME ?? path.join(home, ".codex");
    // An install under the old marketplace name is re-registered as
    // workit@workit, by setup and upgrade alike.
    const migration = codexMigrationSteps(path.join(codexHome, "config.toml"));
    if (migration) {
      const base = hostCommand("codex", [], { home, cwd, env });
      return [
        nodePrerequisite({ home, cwd, env }),
        ...migration.map((step) => ({
          ...base,
          args: [...base.args, ...step.args],
          purpose: step.purpose,
        })),
      ];
    }
    if (!upgrading && isCodexWorkitInstalled(home, env)) return [];
    const base = hostCommand("codex", [], { home, cwd, env });
    return [
      nodePrerequisite({ home, cwd, env }),
      {
        ...base,
        args: [...base.args, "plugin", "marketplace", "list"],
        purpose: "Check whether the Workit marketplace is already registered",
      },
      {
        ...base,
        args: [
          ...base.args,
          "plugin",
          "marketplace",
          upgrading ? "upgrade" : "add",
          ...(upgrading ? [CODEX_MARKETPLACE] : [CODEX_MARKETPLACE_URL]),
        ],
        purpose: upgrading
          ? "Refresh the Workit Codex marketplace"
          : "Register the Workit Codex marketplace",
        ...(upgrading ? {} : { skipWhenOutputIncludes: CODEX_MARKETPLACE }),
      },
      {
        ...base,
        args: [...base.args, "plugin", "add", `workit@${CODEX_MARKETPLACE}`],
        purpose: upgrading ? "Refresh the Workit Codex plugin" : "Install the Workit Codex plugin",
      },
    ];
  }
  if (host === "claude-code") {
    if (!upgrading && isClaudeWorkitInstalled(home, env, null)) return [];
    const base = hostCommand("claude", [], { home, cwd, env });
    // A registered record without its files is removed before the install, so
    // the install starts from no record of Workit.
    const stale = options.repair && !upgrading ? claudeStaleWorkitRecords(home, env) : [];
    return [
      nodePrerequisite({ home, cwd, env }),
      {
        ...base,
        args: [...base.args, "plugin", "marketplace", "list", "--json"],
        purpose: "Check whether the Workit Claude Code marketplace is already registered",
      },
      upgrading
        ? {
            ...base,
            args: [...base.args, "plugin", "marketplace", "update", CLAUDE_MARKETPLACE_NAME],
            purpose: "Refresh the Workit Claude Code marketplace",
          }
        : {
            ...base,
            args: [...base.args, "plugin", "marketplace", "add", CLAUDE_MARKETPLACE_REPO],
            purpose: "Register the Workit Claude Code marketplace",
            skipWhenOutputIncludes: `"name": "${CLAUDE_MARKETPLACE_NAME}"`,
          },
      ...stale.map((id) => ({
        ...base,
        args: [...base.args, "plugin", "uninstall", id, "--scope", "user"],
        purpose: `Remove the ${id} record whose plugin files are missing`,
      })),
      {
        ...base,
        args: upgrading
          ? [...base.args, "plugin", "update", CLAUDE_PLUGIN_ID]
          : [...base.args, "plugin", "install", CLAUDE_PLUGIN_ID, "--scope", "user"],
        purpose: upgrading
          ? "Update the Workit Claude Code plugin"
          : "Install the Workit Claude Code plugin",
      },
    ];
  }
  if (host === "pi") {
    const listed =
      options.repair && !upgrading ? piWorkitPackage(home, env, options.piPackageRoot) : null;
    if (listed) {
      // A local checkout is the user's to build; only an npm entry is reinstalled.
      if (listed.state === "ok" || !listed.npm) return [];
      const base = hostCommand("pi", [], { home, cwd, env });
      return [
        nodePrerequisite({ home, cwd, env }),
        // npm leaves an installed same-version package as is: remove it first.
        ...(listed.state === "not-loading"
          ? [
              {
                ...base,
                args: [...base.args, "remove", listed.source],
                purpose: "Remove the Workit Pi package that does not load its extension",
              },
            ]
          : []),
        {
          ...base,
          args: [...base.args, "install", listed.source],
          purpose: "Reinstall the Workit Pi package Pi lists but has not installed",
        },
      ];
    }
    if (!upgrading && isPiWorkitInstalled(home, env)) return [];
    const base = hostCommand("pi", [], { home, cwd, env });
    return [
      nodePrerequisite({ home, cwd, env }),
      {
        ...base,
        args: upgrading
          ? [...base.args, "update", "--extension", "npm:@workit-dev/pi"]
          : [...base.args, "install", `npm:@workit-dev/pi@${version}`],
        purpose: upgrading
          ? "Update the Workit Pi package"
          : "Install the Workit Pi package in personal Pi settings",
      },
    ];
  }
  if (host === "cursor") {
    const node = findHostExecutable("node", { home, env });
    if (!node)
      throw new Error("Workit host packages require Node.js 24+; install Node.js and retry");
    const npm = findHostExecutable("npm", { home, env });
    const npmCli = npm ? findNpmCli(npm) : null;
    if (!npmCli)
      throw new Error("npm CLI could not be resolved; install Node.js 24+ and npm, then retry");
    const stage = path.join(home, ".cursor", "plugins", "local", ".workit-package-bootstrap");
    const target = options.targetDir ?? path.join(home, ".cursor", "plugins", "local", "workit");
    return [
      nodePrerequisite({ home, cwd, env }),
      {
        command: node,
        args: [
          npmCli,
          "install",
          "--prefix",
          stage,
          "--no-save",
          "--package-lock=false",
          `@workit-dev/cursor@${version}`,
        ],
        cwd,
        purpose: upgrading
          ? "Download the current Workit Cursor adapter for the managed local plugin directory"
          : "Download the Workit Cursor adapter package for the managed local plugin directory",
        packageRoot: path.join(stage, "node_modules", "@workit-dev", "cursor"),
        packageTarget: target,
      },
    ];
  }
  if (host === "opencode") {
    if (upgrading)
      throw new Error(
        "OpenCode CLI cannot target the Workit server plugin for a scoped update; upgrade is unsupported and the current registration was preserved",
      );
    // The normal setup path merges this package pin into OpenCode's config;
    // OpenCode's native resolver installs and refreshes npm plugin packages.
    return [];
  }
  return [];
}

/** Execute a reviewed plan serially and stop immediately on the first failure. */
export function runHostInstall(
  commands: HostInstallCommand[],
  runner?: HostCommandRunner,
  context: HostCommandContext = {},
): {
  ok: boolean;
  results: Array<{ command: HostInstallCommand; result: HostCommandResult }>;
  packageRoot?: string;
} {
  const results: Array<{ command: HostInstallCommand; result: HostCommandResult }> = [];
  let packageRoot: string | undefined;
  let outputHistory = "";
  for (const command of commands) {
    if (command.skipWhenOutputIncludes && outputHistory.includes(command.skipWhenOutputIncludes)) {
      results.push({
        command,
        result: { exitCode: 0, stdout: "", stderr: "already registered; skipped" },
      });
      continue;
    }
    const result = runner ? runner(command) : runHostCommand(command, context);
    results.push({ command, result });
    if (result.exitCode !== 0) return { ok: false, results };
    outputHistory += `\n${result.stdout}\n${result.stderr}`;
    if (command.packageRoot && command.packageTarget) {
      try {
        if (!existsSync(command.packageRoot)) {
          return {
            ok: false,
            results: [
              {
                command,
                result: {
                  ...result,
                  exitCode: 1,
                  stderr: "npm completed without producing the expected Cursor package",
                },
              },
            ],
          };
        } else {
          packageRoot = command.packageRoot;
        }
      } catch (error) {
        return {
          ok: false,
          results: [
            {
              command,
              result: {
                ...result,
                exitCode: 1,
                stderr: error instanceof Error ? error.message : String(error),
              },
            },
          ],
        };
      }
    }
  }
  return { ok: true, results, packageRoot };
}

/** Synchronous, bounded command runner for the synchronous setup Apply API. */
export function runHostCommand(
  step: HostInstallCommand,
  context: HostCommandContext = {},
): HostCommandResult {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(step.command)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Cannot safely execute batch shim ${step.command}; resolve its Node.js CLI entrypoint and retry`,
    };
  }
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    env: (() => {
      const home = context.home ?? context.env?.HOME ?? os.homedir();
      const env: NodeJS.ProcessEnv = { ...process.env, ...context.env, HOME: home };
      env.CODEX_HOME = context.env?.CODEX_HOME ?? path.join(home, ".codex");
      env.PI_CODING_AGENT_DIR = context.env?.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent");
      env.CLAUDE_CONFIG_DIR = context.env?.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
      env.XDG_CONFIG_HOME = context.env?.XDG_CONFIG_HOME ?? path.join(home, ".config");
      return env;
    })(),
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    shell: false,
  });
  return {
    exitCode: result.status ?? (result.error ? 1 : 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

const findNpmCli = (npm: string): string | null => {
  // `npm` is usually a symlink to npm-cli.js (Node's bin/npm, a package's
  // node_modules/.bin/npm); resolve it before guessing install layouts.
  try {
    const resolved = realpathSync(npm);
    if (path.basename(resolved) === "npm-cli.js") return resolved;
  } catch {
    // Fall through to the layout candidates.
  }
  const dir = path.dirname(npm);
  const candidates = [
    path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(dir, "..", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};
