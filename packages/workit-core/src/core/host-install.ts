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

export function hostCommand(
  name: string,
  args: string[],
  options: HostInstallOptions = {},
): HostInstallCommand {
  const executable = findHostExecutable(name, options);
  if (!executable)
    throw new Error(`${name} executable was not found on PATH or supported user bin directories`);
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
};

const MARKETPLACE = "https://github.com/BrainerVirus/workit.git";
const CODEX_MARKETPLACE_NAME = "workflow-toolkit";
/** Claude Code reads the git-hosted marketplace at the repo root
 * (`.claude-plugin/marketplace.json`, name `workit`); its entry installs the
 * published npm package. */
export const CLAUDE_MARKETPLACE_REPO = "BrainerVirus/workit";
export const CLAUDE_MARKETPLACE_NAME = "workit";
export const CLAUDE_PLUGIN_ID = `workit@${CLAUDE_MARKETPLACE_NAME}`;
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
        /^npm:@brainervirus\/workit-pi(?:@[^/]+)?$/.test(value) ||
        value === "@brainervirus/workit-pi" ||
        /(?:^|\/)packages\/workit-pi$/.test(value)
      );
    });
  } catch {
    return false;
  }
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
        (manifest.name === "workit" || manifest.name === "@brainervirus/workit-codex") &&
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

export type ClaudeWorkitInstall = { id: string; version: string | null; installPath: string };

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
 * A `--plugin-dir` local pin is per-session and never appears here.
 */
export const claudeWorkitInstalls = (
  home: string,
  env: NodeJS.ProcessEnv = process.env,
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
    for (const entry of entries as Array<{ installPath?: unknown; version?: unknown }>) {
      if (typeof entry?.installPath !== "string" || !isCanonicalClaudePlugin(entry.installPath))
        continue;
      found.push({
        id,
        installPath: entry.installPath,
        version:
          typeof entry.version === "string" && /^\d+\.\d+\.\d+/.test(entry.version)
            ? entry.version
            : null,
      });
    }
  }
  return found;
};

export const isClaudeWorkitInstalled = (
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean => claudeWorkitInstalls(home, env).length > 0;

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
          ...(upgrading ? [CODEX_MARKETPLACE_NAME] : [MARKETPLACE]),
        ],
        purpose: upgrading
          ? "Refresh the Workit Codex marketplace"
          : "Register the Workit Codex marketplace",
        ...(upgrading ? {} : { skipWhenOutputIncludes: CODEX_MARKETPLACE_NAME }),
      },
      {
        ...base,
        args: [...base.args, "plugin", "add", `workit@${CODEX_MARKETPLACE_NAME}`],
        purpose: upgrading ? "Refresh the Workit Codex plugin" : "Install the Workit Codex plugin",
      },
    ];
  }
  if (host === "claude-code") {
    if (!upgrading && isClaudeWorkitInstalled(home, env)) return [];
    const base = hostCommand("claude", [], { home, cwd, env });
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
    if (!upgrading && isPiWorkitInstalled(home, env)) return [];
    const base = hostCommand("pi", [], { home, cwd, env });
    return [
      nodePrerequisite({ home, cwd, env }),
      {
        ...base,
        args: upgrading
          ? [...base.args, "update", "--extension", "npm:@brainervirus/workit-pi"]
          : [...base.args, "install", `npm:@brainervirus/workit-pi@${version}`],
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
          `@brainervirus/workit-cursor@${version}`,
        ],
        cwd,
        purpose: upgrading
          ? "Download the current Workit Cursor adapter for the managed local plugin directory"
          : "Download the Workit Cursor adapter package for the managed local plugin directory",
        packageRoot: path.join(stage, "node_modules", "@brainervirus", "workit-cursor"),
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
