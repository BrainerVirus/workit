// Shared offline doctor (DG-07/DG-08, CA-09). One host-neutral engine checks the
// installed Workit surfaces — pins, versions, assets, launchers, runtimes,
// utilities, registrations, config, workspace match, credential metadata, and
// log writability — with no network access. Never reads credential values: only
// existence, mode, and a placeholder flag are evaluated; token bytes never enter
// the report or any log event.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SUPPORT_MATRIX } from "./support-matrix";
import { EVENT } from "./boundary";
import { getDiagnosticLogger, isConfigObject } from "./config";
import { CURSOR_RUNTIME_PACKAGE, cursorHooksEntry, isWorkitPlugin } from "./registration";
import { resolveWorkspaceFrom } from "./workspaces";
import { validateCursorSkills } from "./skill-manifests";

// Mirrors init.ts TOKEN_PLACEHOLDER; kept local so the doctor never needs to
// import the YouTrack/VCS stack just to label a credential state.
const TOKEN_PLACEHOLDER = "YOUR_TOKEN_HERE";

export type DoctorHost = "cli" | "opencode" | "cursor";

export type DoctorCheckId =
  | "runtime"
  | "versions"
  | "assets"
  | "launcher"
  | "utility"
  | "stale_pin"
  | "duplicate_registration"
  | "malformed_config"
  | "workspace_mismatch"
  | "credential_metadata"
  | "log_writable";

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export type DoctorCheck = {
  id: DoctorCheckId;
  status: DoctorCheckStatus;
  /** Bounded, path-level detail. Never contains credential values. */
  detail: string;
  fix?: string;
};

export type DoctorFix = { id: DoctorCheckId; fix: string };

export type DoctorSummary = { passed: number; warned: number; failed: number; total: number };

export type DoctorReport = {
  ok: boolean;
  exitCode: number;
  offline: true;
  host: DoctorHost;
  checked_at: string;
  summary: DoctorSummary;
  checks: DoctorCheck[];
  fixes: DoctorFix[];
};

export type DoctorOptions = {
  host?: DoctorHost;
  home?: string;
  configDir?: string;
  stateDir?: string;
  /** Checkout containing packages/ (monorepo or share clone). */
  dev?: string;
  cwd?: string;
  opencodeConfig?: string;
  cursorSettings?: string;
  cursorMcp?: string;
  cursorPluginDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Installer run: only registration/config checks count toward exitCode. */
  installer?: boolean;
};

type Resolved = {
  host: DoctorHost;
  home: string;
  configDir: string;
  stateDir: string;
  cwd: string;
  dev: string | null;
  opencodeConfig: string;
  cursorSettings: string;
  cursorMcp: string;
  cursorPluginDir: string;
  env: NodeJS.ProcessEnv;
  installer: boolean;
};

const findDevFromCwd = (cwd: string): string | null => {
  let dir = path.resolve(cwd);
  while (true) {
    if (existsSync(path.join(dir, "packages", "workit-core", "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

const resolve = (options: DoctorOptions): Resolved => {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? os.homedir();
  const configDir =
    options.configDir ??
    env.WORKFLOW_TOOLKIT_CONFIG ??
    env.WORKFLOW_TOOLKIT_CONFIG_DIR ??
    path.join(home, ".config", "workit");
  const stateDir =
    options.stateDir ?? env.WORKFLOW_TOOLKIT_STATE ?? path.join(home, ".local", "state", "workit");
  const cwd = options.cwd ?? process.cwd();
  const dev = options.dev ?? env.WORKFLOW_TOOLKIT_DEV ?? findDevFromCwd(cwd);
  return {
    host: options.host ?? "cli",
    home,
    configDir,
    stateDir,
    cwd,
    dev,
    opencodeConfig:
      options.opencodeConfig ?? path.join(home, ".config", "opencode", "opencode.json"),
    cursorSettings: options.cursorSettings ?? path.join(home, ".cursor", "settings.json"),
    cursorMcp: options.cursorMcp ?? path.join(home, ".cursor", "mcp.json"),
    cursorPluginDir:
      options.cursorPluginDir ?? path.join(home, ".cursor", "plugins", "local", "workit"),
    env,
    installer: options.installer ?? false,
  };
};

const readJson = (p: string): Record<string, any> | null => {
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, any>)
      : null;
  } catch {
    return null;
  }
};

// AR-07/CA-37: a JSON file that parses but is not an object (null, scalar,
// array) is not a config file — the readers classify it malformed, so the
// doctor must flag it too (a parse-only gate would call it healthy = fail-open).
const parsesAsConfigObject = (p: string): boolean => {
  try {
    return isConfigObject(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return false;
  }
};

// OpenCode accepts `plugin` as a string or an array; normalize before reading.
const pluginEntries = (cfg: Record<string, any> | null): string[] => {
  const plugin = cfg?.plugin;
  const list = Array.isArray(plugin) ? plugin : typeof plugin === "string" ? [plugin] : [];
  return list.map(String).filter(isWorkitPlugin);
};

const commandOnPath = (name: string, env: NodeJS.ProcessEnv): boolean => {
  const dirs = (env.PATH ?? process.env.PATH ?? "").split(path.delimiter);
  // win32 executables carry an .exe suffix (bun.exe, git.exe), so probe both
  // names — statSync with the bare name would never find them.
  const names = process.platform === "win32" ? [name, `${name}.exe`] : [name];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const candidateName of names) {
      const candidate = path.join(dir, candidateName);
      try {
        const st = statSync(candidate);
        if (process.platform !== "win32" && (st.mode & 0o111) === 0) continue;
        return true;
      } catch {
        /* keep scanning */
      }
    }
  }
  return false;
};

const versionOf = (bin: string, env: NodeJS.ProcessEnv): string | null => {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", env });
  if (r.error) return null;
  return (r.stdout ?? "").trim();
};

const semverAtLeast = (version: string, min: string): boolean => {
  const a = version
    .replace(/^v/, "")
    .split(".")
    .map((n) => Number(n) || 0);
  const b = min.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return true;
};

const resolveBun = (env: NodeJS.ProcessEnv): string | null => {
  if (env.BUN && existsSync(env.BUN)) return env.BUN;
  for (const candidate of [
    path.join(os.homedir(), ".bun/bin/bun"),
    "/usr/local/bin/bun",
    "/usr/bin/bun",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return commandOnPath("bun", env) ? "bun" : null;
};

// Installation checks ---------------------------------------------------------

const checkRuntime = (res: Resolved): DoctorCheck => {
  const node = versionOf("node", res.env);
  const nodeOk = node !== null && semverAtLeast(node, SUPPORT_MATRIX.node.minimum);
  const bun = resolveBun(res.env);
  const bunVersion = bun ? versionOf(bun, res.env) : null;
  const bunOk = bunVersion !== null;
  const needsBun = res.dev !== null;
  if (!nodeOk) {
    return {
      id: "runtime",
      status: "fail",
      detail: `node ${SUPPORT_MATRIX.node.minimum}+ required (found ${node ?? "none on PATH"})`,
      fix: `Install Node ${SUPPORT_MATRIX.node.minimum}+ (declared support: ${SUPPORT_MATRIX.node.minimum}/current)`,
    };
  }
  if (!bunOk && needsBun) {
    return {
      id: "runtime",
      status: "fail",
      detail: `bun not found on PATH (dev checkout requires the pinned toolchain ${SUPPORT_MATRIX.bun})`,
      fix: `Install bun ${SUPPORT_MATRIX.bun} (curl -fsSL https://bun.sh/install | bash)`,
    };
  }
  if (!bunOk) {
    return {
      id: "runtime",
      status: "warn",
      detail: "bun not found on PATH — not required for published artifacts",
      fix: "Install bun for development/installer use",
    };
  }
  return {
    id: "runtime",
    status: "pass",
    detail: `node ${node} (>=${SUPPORT_MATRIX.node.minimum}), bun ${bunVersion ?? "n/a"}`,
  };
};

const checkVersions = (res: Resolved): DoctorCheck => {
  if (!res.dev) {
    return {
      id: "versions",
      status: "warn",
      detail: "no dev checkout found (WORKFLOW_TOOLKIT_DEV) — skipping version parity",
    };
  }
  const corePkg = readJson(path.join(res.dev, "packages/workit-core/package.json"));
  if (!corePkg) {
    return {
      id: "versions",
      status: "warn",
      detail: "dev checkout has no workit-core manifest — skipping version parity",
    };
  }
  const refs = new Set<string>();
  for (const name of ["workit-opencode", "workit-cursor", "workit-cli"]) {
    const pkg = readJson(path.join(res.dev, "packages", name, "package.json"));
    const dep = pkg?.dependencies?.["@brainervirus/workit-core"];
    if (typeof dep === "string") refs.add(dep);
  }
  if (refs.size === 0) {
    return {
      id: "versions",
      status: "warn",
      detail: "no adapter core references found in the dev checkout",
    };
  }
  const problems: string[] = [];
  if (refs.size > 1) {
    problems.push(`adapters pin different core versions: ${[...refs].join(", ")}`);
  }
  const opencodePkg = readJson(path.join(res.dev, "packages/workit-opencode/package.json"));
  const sdk = opencodePkg?.dependencies?.["@opencode-ai/plugin"];
  const sdkVersion = typeof sdk === "string" ? (sdk.match(/^\d+(?:\.\d+){0,2}/) ?? [])[0] : null;
  if (sdkVersion && !semverAtLeast(sdkVersion, SUPPORT_MATRIX.opencode.minimum)) {
    problems.push(
      `@opencode-ai/plugin ${sdk} is older than the supported minimum ${SUPPORT_MATRIX.opencode.minimum}`,
    );
  }
  if (problems.length === 0) {
    return {
      id: "versions",
      status: "pass",
      detail: `adapter core references consistent (${[...refs].join(", ")})`,
    };
  }
  return {
    id: "versions",
    status: "fail",
    detail: problems.join("; "),
    fix: "Align every adapter to the same @brainervirus/workit-core version (rewrite-workspace-deps.ts) or reinstall",
  };
};

const assetPathsFor = (host: DoctorHost, dev: string): string[] => {
  const pkg = path.join(dev, "packages", `workit-${host}`);
  switch (host) {
    case "opencode":
      return [
        path.join(pkg, "assets", "commands", "wk-init.md"),
        path.join(pkg, "assets", "skills", "wk-init", "SKILL.md"),
        path.join(pkg, "assets", "templates", "spec-template.md"),
        path.join(pkg, "assets", "vendor", "superpowers", "skills", "brainstorming", "SKILL.md"),
      ];
    case "cursor":
      return [
        path.join(pkg, "assets", "templates", "spec-template.md"),
        path.join(pkg, "mcp.json"),
        path.join(pkg, ".cursor-plugin"),
      ];
    case "cli":
      return [path.join(pkg, "assets", "templates", "spec-template.md")];
  }
};

// The CLI doctor is comprehensive: it verifies every host package, while the
// host tools verify only their own package.
const hostsFor = (host: DoctorHost): DoctorHost[] =>
  host === "cli" ? ["opencode", "cursor", "cli"] : [host];

const checkAssets = (res: Resolved): DoctorCheck => {
  const dev = res.dev;
  const missing = dev
    ? hostsFor(res.host).flatMap((h) =>
        assetPathsFor(h, dev)
          .filter((p) => !existsSync(p))
          .map((p) => `${h}: ${p}`),
      )
    : [];
  if (res.host === "cursor" || res.host === "cli") {
    const cursorError = validateCursorSkills(res.cursorPluginDir);
    if (cursorError) missing.push(`cursor: ${cursorError}`);
  }
  if (missing.length === 0) {
    if (!dev && res.host === "opencode") {
      return {
        id: "assets",
        status: "warn",
        detail: "no dev checkout found (WORKFLOW_TOOLKIT_DEV) — skipping asset check",
      };
    }
    return {
      id: "assets",
      status: "pass",
      detail: dev ? `${res.host} assets present` : "installed Cursor skills valid",
    };
  }
  return {
    id: "assets",
    status: "fail",
    detail: `missing assets: ${missing.join(", ")}`,
    fix: "Reinstall or rebuild the workit package (missing assets under packages/workit-<host>)",
  };
};

const launcherSlotsFor = (host: DoctorHost, dev: string): string[][] => {
  const pkg = path.join(dev, "packages", `workit-${host}`);
  switch (host) {
    case "opencode":
      return [[path.join(pkg, "src", "plugin.ts"), path.join(pkg, "dist", "plugin.js")]];
    case "cursor":
      // The dist entries are the npm bin targets the npx launcher executes.
      return [
        [path.join(pkg, "dist", "mcp-server.js")],
        [path.join(pkg, "dist", "cursor-session-start.js")],
      ];
    case "cli":
      return [[path.join(pkg, "src", "index.tsx"), path.join(pkg, "dist", "index.js")]];
  }
};

const validNodeEntry = (entry: string, runtime: string, env: NodeJS.ProcessEnv): boolean => {
  try {
    const stat = statSync(entry);
    if (
      !stat.isFile() ||
      stat.size === 0 ||
      !readFileSync(entry, "utf8").startsWith("#!/usr/bin/env node\n")
    ) {
      return false;
    }
    return spawnSync(runtime, ["--check", entry], { encoding: "utf8", env }).status === 0;
  } catch {
    return false;
  }
};

type CursorLauncher = { kind: "node"; runtime: string; entry: string } | { kind: "npx" };

const registeredCursorLauncher = (res: Resolved): CursorLauncher | null | "invalid" => {
  if (!existsSync(res.cursorMcp)) return "invalid";
  const config = readJson(res.cursorMcp);
  if (!config) return null; // malformed_config owns malformed JSON/object reporting
  const server = config.mcpServers?.workit;
  if (!server || typeof server !== "object" || Array.isArray(server)) return "invalid";
  const command = server.command;
  const args = server.args;
  if (typeof command !== "string" || !Array.isArray(args) || typeof args[0] !== "string") {
    return "invalid";
  }
  const executable = path.basename(command).toLowerCase();
  // CA-17: the canonical launcher runs the published package through npx; the
  // offline doctor validates its shape (never the registry reachability).
  if (executable === "npx" || executable === "npx.exe" || executable === "npx.cmd") {
    // CA-17: exact positional tokens — a substring match would accept
    // `@latest-alpha` or `workit-cursor-mcp-foo`.
    if (args[0] !== "-y") return "invalid";
    if (args[1] !== `--package=${CURSOR_RUNTIME_PACKAGE}`) return "invalid";
    if (args[2] !== "workit-cursor-mcp") return "invalid";
    return { kind: "npx" };
  }
  if (executable !== "node" && executable !== "node.exe") return "invalid";
  return {
    kind: "node",
    runtime: command,
    entry: path.isAbsolute(args[0]) ? args[0] : path.resolve(path.dirname(res.cursorMcp), args[0]),
  };
};

// CA-17: the canonical session-start hook runs the published package through
// npx as a single command string (Cursor's documented hook format). The doctor
// validates its shape exactly like the MCP launcher — no substring matching,
// no version abstraction.
const canonicalCursorHook = cursorHooksEntry("").command;

const registeredCursorHook = (res: Resolved): string | null | "invalid" => {
  const hooksFile = path.join(res.cursorPluginDir, "hooks", "hooks-cursor.json");
  if (!existsSync(hooksFile)) return "invalid";
  const config = readJson(hooksFile);
  // Unlike mcp.json, the hook file is not covered by checkMalformedConfig, so
  // an unparseable hook must fail the launcher check rather than slip through.
  if (!config) return "invalid";
  const sessionStart = config.hooks?.sessionStart;
  if (!Array.isArray(sessionStart) || sessionStart.length !== 1) return "invalid";
  const entry = sessionStart[0];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return "invalid";
  return typeof entry.command === "string" ? entry.command : "invalid";
};

const checkLauncher = (res: Resolved): DoctorCheck => {
  const dev = res.dev;
  const hosts = hostsFor(res.host);
  const registered = hosts.includes("cursor") ? registeredCursorLauncher(res) : null;
  const runtime =
    registered && registered !== "invalid" && registered.kind === "node"
      ? registered.runtime
      : "node";
  const missing = hosts.includes("cursor")
    ? ["dist/mcp-server.js", "dist/cursor-session-start.js"]
        .map((rel) => path.join(res.cursorPluginDir, rel))
        .filter((p) => !validNodeEntry(p, runtime, res.env))
        .map((p) => `cursor: ${p}`)
    : [];
  if (hosts.includes("cursor")) {
    if (registered === "invalid") {
      missing.push(`cursor: canonical workit MCP launcher in ${res.cursorMcp}`);
    } else if (
      registered &&
      registered.kind === "node" &&
      !validNodeEntry(registered.entry, registered.runtime, res.env)
    ) {
      missing.push(`cursor: registered ${registered.entry}`);
    }
    const hook = registeredCursorHook(res);
    if (hook === "invalid") {
      missing.push(
        `cursor: canonical session-start hook in ${path.join(res.cursorPluginDir, "hooks", "hooks-cursor.json")}`,
      );
    } else if (hook !== null && hook !== canonicalCursorHook) {
      missing.push(
        `cursor: canonical session-start hook in ${path.join(res.cursorPluginDir, "hooks", "hooks-cursor.json")} (registered ${hook})`,
      );
    }
  }
  if (dev) {
    missing.push(
      ...hosts
        .filter((h) => h !== "cursor")
        .flatMap((h) =>
          launcherSlotsFor(h, dev)
            .filter((slot) => !slot.some((p) => existsSync(p)))
            .map((slot) => `${h}: ${slot.join(" or ")}`),
        ),
    );
  }
  if (missing.length > 0) {
    return {
      id: "launcher",
      status: "fail",
      detail: `missing or invalid launcher entry: ${missing.join("; ")}`,
      fix: `Rebuild and reinstall the workit package (bun run build) — dist entries must be non-empty Node launchers`,
    };
  }
  if (!dev && res.host !== "cursor") {
    return {
      id: "launcher",
      status: "warn",
      detail: "no dev checkout found (WORKFLOW_TOOLKIT_DEV) — skipping non-Cursor launcher checks",
    };
  }
  return { id: "launcher", status: "pass", detail: `${res.host} launcher/hook entries present` };
};

const checkUtility = (res: Resolved): DoctorCheck => {
  const git = commandOnPath("git", res.env);
  if (!git) {
    return {
      id: "utility",
      status: "fail",
      detail: "git not found in PATH — installers, PRs and verification require it",
      fix: "Install git and ensure it is on PATH",
    };
  }
  if (process.platform !== "win32" && !commandOnPath("flock", res.env)) {
    return {
      id: "utility",
      status: "warn",
      detail: "flock (util-linux) not found — sync-runtime requires it for locking",
      fix: "Install util-linux (flock)",
    };
  }
  return { id: "utility", status: "pass", detail: "git (and flock where required) on PATH" };
};

const staleEntry = (entry: string): "ok" | "stale" | "missing-file" => {
  if (!entry) return "stale";
  if (entry.includes("git+file")) return "stale";
  if (entry.startsWith("file:")) {
    const target = entry.replace(/^file:\/\//, "").replace(/^file:/, "");
    return existsSync(target) ? "ok" : "missing-file";
  }
  // registry/ssh/git pins are not the canonical file pin, but are left to the
  // duplicate/versions checks rather than being labelled stale.
  return "ok";
};

const checkStalePin = (res: Resolved): DoctorCheck => {
  if (res.host === "cursor") {
    return {
      id: "stale_pin",
      status: "pass",
      detail: "opencode pin not inspected on the cursor host",
    };
  }
  if (!existsSync(res.opencodeConfig)) {
    return { id: "stale_pin", status: "pass", detail: "no opencode config — not registered" };
  }
  const cfg = readJson(res.opencodeConfig);
  const entries = pluginEntries(cfg);
  if (entries.length === 0) {
    return {
      id: "stale_pin",
      status: "fail",
      detail: "no workit plugin registered in the opencode config",
      fix: "Run install-opencode-plugin.sh to pin the workit plugin entry",
    };
  }
  const first = staleEntry(entries[0]);
  if (first === "stale") {
    return {
      id: "stale_pin",
      status: "fail",
      detail: `stale workit pin: ${entries[0]}`,
      fix: "Re-run install-opencode-plugin.sh — the pin points at a git+file or non-file source",
    };
  }
  if (first === "missing-file") {
    return {
      id: "stale_pin",
      status: "fail",
      detail: `workit pin points at a missing file: ${entries[0]}`,
      fix: "Re-run install-opencode-plugin.sh after restoring the checkout the pin references",
    };
  }
  return { id: "stale_pin", status: "pass", detail: "opencode pin resolves" };
};

const checkDuplicateRegistration = (res: Resolved): DoctorCheck => {
  const problems: string[] = [];
  const opencodeHost = res.host !== "cursor";
  const cursorHost = res.host !== "opencode";

  if (opencodeHost && existsSync(res.opencodeConfig)) {
    const cfg = readJson(res.opencodeConfig);
    const entries = pluginEntries(cfg);
    if (entries.length > 1)
      problems.push(`opencode registers ${entries.length} workit plugin entries`);
  }
  if (cursorHost && existsSync(res.cursorSettings)) {
    const settings = readJson(res.cursorSettings);
    const enabled = settings?.enabled_plugins;
    if (enabled && typeof enabled === "object") {
      const keys = Object.keys(enabled).filter((k) => isWorkitPlugin(k));
      if (keys.length > 1)
        problems.push(
          `cursor enables ${keys.length} workit plugin identities (${keys.join(", ")})`,
        );
    }
    const dirs = Array.isArray(settings?.plugin_dirs)
      ? settings.plugin_dirs.map(String).filter((d) => {
          // Exact local plugin-dir identities only (CA-09): a similarly-named
          // unrelated dir (e.g. `local/workflow-toolkit-extra`) is preserved
          // and must never be counted as a Workit entry.
          const n = d.replaceAll("\\", "/").replace(/\/+$/, "");
          return (
            isWorkitPlugin(d) || n.endsWith("local/workit") || n.endsWith("local/workflow-toolkit")
          );
        })
      : [];
    if (dirs.length > 1) problems.push(`cursor plugin_dirs has ${dirs.length} workit entries`);
  }
  if (cursorHost && existsSync(res.cursorMcp)) {
    const mcp = readJson(res.cursorMcp);
    const servers = mcp?.mcpServers ?? {};
    if (servers && typeof servers === "object") {
      const workitServers = Object.keys(servers).filter(
        (s) => s === "workit" || s.includes("workflow-toolkit"),
      );
      if (workitServers.length > 1)
        problems.push(
          `cursor registers ${workitServers.length} workit MCP servers (${workitServers.join(", ")})`,
        );
    }
  }
  if (problems.length === 0) {
    return { id: "duplicate_registration", status: "pass", detail: "no duplicate registrations" };
  }
  return {
    id: "duplicate_registration",
    status: "fail",
    detail: problems.join("; "),
    fix: "Re-run install-opencode-plugin.sh / install-cursor-plugin.sh to deduplicate registrations",
  };
};

const checkMalformedConfig = (res: Resolved): DoctorCheck => {
  const files: string[] = [];
  for (const name of ["config.json", "youtrack.json", "vcs.json", "workspaces.json"]) {
    const p = path.join(res.configDir, name);
    if (existsSync(p)) files.push(p);
  }
  const opencodeHost = res.host !== "cursor";
  const cursorHost = res.host !== "opencode";
  if (opencodeHost && existsSync(res.opencodeConfig)) files.push(res.opencodeConfig);
  if (cursorHost && existsSync(res.cursorSettings)) files.push(res.cursorSettings);
  if (cursorHost && existsSync(res.cursorMcp)) files.push(res.cursorMcp);
  const bad = files.filter((p) => !parsesAsConfigObject(p));
  if (bad.length === 0)
    return { id: "malformed_config", status: "pass", detail: "config files parse" };
  return {
    id: "malformed_config",
    status: "fail",
    detail: `malformed config: ${bad.join(", ")}`,
    fix: `Repair the malformed config in ${bad[0]}`,
  };
};

const checkWorkspaceMismatch = (res: Resolved): DoctorCheck => {
  const file = path.join(res.configDir, "workspaces.json");
  if (!existsSync(file))
    return { id: "workspace_mismatch", status: "pass", detail: "no workspaces configured" };
  const ws = readJson(file);
  if (!Array.isArray(ws?.workspaces)) {
    return { id: "workspace_mismatch", status: "pass", detail: "no workspaces configured" };
  }
  const match = resolveWorkspaceFrom(res.cwd, res.configDir);
  if (match)
    return {
      id: "workspace_mismatch",
      status: "pass",
      detail: `current directory matches workspace "${match.name}"`,
    };
  return {
    id: "workspace_mismatch",
    status: "fail",
    detail: `current directory ${res.cwd} does not match any configured workspace`,
    fix: `Add a workspace glob matching this directory to ${file} or run /wk-init`,
  };
};

// Credential metadata: existence, mode, placeholder — never the value.
const isPlaceholder = (p: string): boolean => {
  try {
    return readFileSync(p, "utf8").trim() === TOKEN_PLACEHOLDER;
  } catch {
    return false;
  }
};

const checkCredentialMetadata = (res: Resolved): DoctorCheck => {
  const tokenPaths: string[] = [];
  const youtrackJson = readJson(path.join(res.configDir, "youtrack.json"));
  if (youtrackJson) {
    tokenPaths.push(
      typeof youtrackJson.tokenFile === "string"
        ? youtrackJson.tokenFile
        : path.join(res.configDir, "youtrack.token"),
    );
  } else if (existsSync(path.join(res.configDir, "youtrack.token"))) {
    tokenPaths.push(path.join(res.configDir, "youtrack.token"));
  }

  const vcsJson = readJson(path.join(res.configDir, "vcs.json"));
  for (const key of ["gitlab", "github"] as const) {
    const provider = vcsJson?.[key];
    if (provider && typeof provider === "object") {
      const tf = provider.tokenFile;
      tokenPaths.push(typeof tf === "string" ? tf : path.join(res.configDir, `${key}.token`));
    } else if (!vcsJson && existsSync(path.join(res.configDir, `${key}.token`))) {
      tokenPaths.push(path.join(res.configDir, `${key}.token`));
    }
  }

  if (tokenPaths.length === 0) {
    return { id: "credential_metadata", status: "pass", detail: "no credentials configured" };
  }
  const problems: string[] = [];
  for (const raw of tokenPaths) {
    const p = path.isAbsolute(raw) ? raw : path.resolve(res.configDir, raw);
    if (!existsSync(p)) {
      problems.push(`${p} is missing`);
      continue;
    }
    if (process.platform !== "win32") {
      const mode = statSync(p).mode & 0o777;
      if (mode !== 0o600) problems.push(`${p} must be mode 0600 (found ${mode.toString(8)})`);
    }
    if (isPlaceholder(p)) problems.push(`${p} still contains the placeholder token`);
  }
  if (problems.length === 0) {
    return {
      id: "credential_metadata",
      status: "pass",
      detail: "credential files present with safe metadata",
    };
  }
  return {
    id: "credential_metadata",
    status: "fail",
    detail: problems.join("; "),
    fix: "Create or fix the token file (mode 0600, real value) — see /wk-status for the exact path",
  };
};

const checkLogWritable = (res: Resolved): DoctorCheck => {
  const logsDir = path.join(res.stateDir, "logs");
  // Fixed-name probe: even a killed process leaves at most one bounded file that
  // the next run overwrites; the finally removes it on any thrown path.
  const probe = path.join(logsDir, "doctor-probe.tmp");
  try {
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    writeFileSync(probe, '{"probe":true}\n', { mode: 0o600 });
    return { id: "log_writable", status: "pass", detail: "log directory writable" };
  } catch (err) {
    return {
      id: "log_writable",
      status: "fail",
      detail: `log directory not writable: ${err instanceof Error ? err.message : String(err)}`,
      fix: `Fix permissions on ${logsDir} or set WORKFLOW_TOOLKIT_STATE to a writable directory`,
    };
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      /* already gone */
    }
  }
};

const RUN_CHECKS: Array<(res: Resolved) => DoctorCheck> = [
  checkRuntime,
  checkVersions,
  checkAssets,
  checkLauncher,
  checkUtility,
  checkStalePin,
  checkDuplicateRegistration,
  checkMalformedConfig,
  checkWorkspaceMismatch,
  checkCredentialMetadata,
  checkLogWritable,
];

// AR-11/CA-40: the installer guarantees the selected host itself — runtime,
// assets, launchers, registration, and required utilities — plus the config it
// just wrote. Those defects stay failures with nonzero status; only optional
// parity checks (versions/workspace/credentials/log) may downgrade to warnings.
const INSTALLER_REQUIRED = new Set<DoctorCheckId>([
  "runtime",
  "assets",
  "launcher",
  "utility",
  "stale_pin",
  "duplicate_registration",
  "malformed_config",
]);

export const runDoctor = (options: DoctorOptions = {}): DoctorReport => {
  const res = resolve(options);
  const raw = RUN_CHECKS.map((fn) => fn(res));
  const checks = res.installer
    ? raw.map((c) =>
        c.status === "fail" && !INSTALLER_REQUIRED.has(c.id)
          ? { ...c, status: "warn" as const, detail: `${c.detail} (not enforced by installer)` }
          : c,
      )
    : raw;

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const passed = checks.filter((c) => c.status === "pass").length;
  const exitCode = failed > 0 ? 1 : 0;
  const report: DoctorReport = {
    ok: failed === 0,
    exitCode,
    offline: true,
    host: res.host,
    checked_at: new Date().toISOString(),
    summary: { passed, warned, failed, total: checks.length },
    checks,
    fixes: checks
      .filter((c) => c.status === "fail" && c.fix)
      .map((c) => ({ id: c.id, fix: c.fix! })),
  };

  getDiagnosticLogger()?.info(EVENT.doctor, {
    host: res.host,
    exit_code: exitCode,
    offline: true,
    failed: checks.filter((c) => c.status === "fail").map((c) => c.id),
    total: checks.length,
  });

  return report;
};
