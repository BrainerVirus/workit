// Shared offline doctor (DG-07/CA-09). One host-neutral engine checks the
// installed Workit surfaces — pins, versions, assets, launchers, runtimes,
// utilities, registrations, config, workspace match, credential metadata, and
// log writability — with no network access except the optional registry probe
// behind the stale-install comparison (CA-04) and fail-open provider CLI
// identity probes. Credentials are handled by gh/glab; token values never enter
// the report, any fix text, or any log event.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import cliPkg from "../../package.json" with { type: "json" };
import { SUPPORT_MATRIX } from "@brainervirus/workit-core/src/core/support-matrix";
import { inspectMetadataLock } from "@brainervirus/workit-core/src/core/store-lock";
import {
  bundleHashOfFile,
  isEphemeralCachePath,
} from "@brainervirus/workit-core/src/core/runtime-identity";
import { EVENT } from "@brainervirus/workit-core/src/core/boundary";
import {
  describeReleaseTracks,
  releaseTracksReport,
} from "@brainervirus/workit-core/src/core/release-tracks";
import { repoBranchPreset } from "@brainervirus/workit-core/src/core/branch-policy";
import {
  getDiagnosticLogger,
  isConfigObject,
  readConfigFromDir,
} from "@brainervirus/workit-core/src/core/config";
import { resolveStateDir } from "@brainervirus/workit-core/src/core/logger";
import { packageRoot } from "@brainervirus/workit-core/src/core/package-root";
import {
  CURSOR_RUNTIME_PACKAGE,
  OPENCODE_NPM_PIN,
  cursorHookDrift,
  cursorHooksEntry,
  cursorMcpServerEntry,
  isWorkitPlugin,
} from "./registration";
import {
  readWorkspacesResult,
  resolveWorkspaceFrom,
  resolveWorkspacePolicy,
  type WorkspaceConfig,
} from "@brainervirus/workit-core/src/core/workspaces";
import {
  CLAUDE_MARKETPLACE_NAME,
  claudeWorkitInstalls,
  type ClaudeWorkitInstall,
} from "./host-install";
import {
  validateCursorSkills,
  WORKIT_METHOD_SKILLS,
} from "@brainervirus/workit-core/src/core/skill-manifests";

// Mirrors init.ts TOKEN_PLACEHOLDER; kept local so the doctor never needs to
// import the YouTrack/VCS stack just to label a credential state.
const TOKEN_PLACEHOLDER = "YOUR_TOKEN_HERE";

type DoctorHost = "cli" | "opencode" | "cursor";

type DoctorCheckId =
  | "runtime"
  | "versions"
  | "codex_pin"
  | "codex_hooks"
  | "codex_agents"
  | "pi_extension"
  | "opencode_version"
  | "claude_plugin"
  | "workit_on_path"
  | "assets"
  | "launcher"
  | "cursor_hook"
  | "utility"
  | "stale_pin"
  | "stale_install"
  | "registry_unreachable"
  | "duplicate_registration"
  | "malformed_config"
  | "workspace_mismatch"
  | "workspace_lock"
  | "credential_metadata"
  | "github_identity"
  | "gitlab_identity"
  | "log_writable";

type DoctorCheckStatus = "pass" | "warn" | "fail";

export type DoctorCheck = {
  id: DoctorCheckId;
  status: DoctorCheckStatus;
  /** Bounded, path-level detail. Never contains credential values. */
  detail: string;
  fix?: string;
};

type DoctorFix = { id: DoctorCheckId; fix: string };

type DoctorSummary = {
  passed: number;
  warned: number;
  failed: number;
  total: number;
};

export type DoctorReport = {
  ok: boolean;
  exitCode: number;
  /** False when the doctor consulted the npm registry (local-dist version probe). */
  offline: boolean;
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
  /** Workit store root for the lock check (default: WORKFLOW_WORKSPACE_ROOT, then cwd). */
  workspaceRoot?: string;
  opencodeConfig?: string;
  /** OpenCode npm `@latest` package cache root (test seam). */
  opencodePackageCacheDir?: string;
  cursorSettings?: string;
  cursorMcp?: string;
  cursorPluginDir?: string;
  /** Codex home (default: CODEX_HOME, then ~/.codex). */
  codexHome?: string;
  /** Pi agent dir (default: PI_CODING_AGENT_DIR, then ~/.pi/agent). */
  piAgentDir?: string;
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
  workspaceRoot: string;
  dev: string | null;
  opencodeConfig: string;
  opencodePackageCacheDir: string;
  cursorSettings: string;
  cursorMcp: string;
  cursorPluginDir: string;
  /** Where the Cursor hook launcher and MCP server leave their heartbeats
   *  (core's resolveStateDir, unless a state dir is given). */
  cursorHeartbeatDir: string;
  codexHome?: string;
  piAgentDir?: string;
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
    workspaceRoot: options.workspaceRoot ?? env.WORKFLOW_WORKSPACE_ROOT ?? cwd,
    dev,
    opencodeConfig:
      options.opencodeConfig ?? path.join(home, ".config", "opencode", "opencode.json"),
    opencodePackageCacheDir:
      options.opencodePackageCacheDir ??
      path.join(home, ".cache", "opencode", "packages", "@brainervirus", "workit-opencode@latest"),
    cursorSettings: options.cursorSettings ?? path.join(home, ".cursor", "settings.json"),
    cursorMcp: options.cursorMcp ?? path.join(home, ".cursor", "mcp.json"),
    cursorPluginDir:
      options.cursorPluginDir ?? path.join(home, ".cursor", "plugins", "local", "workit"),
    cursorHeartbeatDir: options.stateDir ?? (env.WORKFLOW_TOOLKIT_STATE || resolveStateDir()),
    codexHome: options.codexHome,
    piAgentDir: options.piAgentDir,
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

// V2 uses plugins; V1 accepts plugin as a string or array. Inspect both.
const pluginEntries = (cfg: Record<string, any> | null): string[] => {
  const entries = [cfg?.plugins, cfg?.plugin].flatMap((value) =>
    Array.isArray(value) ? value : typeof value === "string" ? [value] : [],
  );
  return [
    ...new Set(
      entries.filter(
        (entry): entry is string => typeof entry === "string" && isWorkitPlugin(entry),
      ),
    ),
  ];
};

// win32 executables carry an .exe suffix (bun.exe, git.exe), so probe both
// names — statSync with the bare name would never find them.
const commandOnPath = (name: string, env: NodeJS.ProcessEnv): boolean =>
  findOnPath(process.platform === "win32" ? [name, `${name}.exe`] : [name], env) !== null;

/** Names a shell resolves for `name` on win32: one per PATHEXT extension
 * (npm installs global bins as `workit.cmd`). Elsewhere just `name`. */
const pathextNames = (name: string, env: NodeJS.ProcessEnv): string[] =>
  process.platform === "win32"
    ? (env.PATHEXT ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter(Boolean)
        .map((ext) => `${name}${ext.toLowerCase()}`)
    : [name];

/** Absolute path of the first executable among `names` on env.PATH, or null. */
const findOnPath = (names: string[], env: NodeJS.ProcessEnv): string | null => {
  const dirs = (env.PATH ?? process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const candidateName of names) {
      const candidate = path.join(dir, candidateName);
      try {
        const st = statSync(candidate);
        if (process.platform !== "win32" && (st.mode & 0o111) === 0) continue;
        return candidate;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
};

const versionOf = (bin: string, env: NodeJS.ProcessEnv, timeout?: number): string | null => {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", env, timeout });
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
  const sdk =
    opencodePkg?.dependencies?.["@opencode/plugin"] ??
    opencodePkg?.devDependencies?.["@opencode/plugin"];
  const sdkVersion = typeof sdk === "string" ? (sdk.match(/^\d+(?:\.\d+){0,2}/) ?? [])[0] : null;
  if (sdkVersion && !semverAtLeast(sdkVersion, SUPPORT_MATRIX.opencode.minimum)) {
    problems.push(
      `@opencode/plugin ${sdk} is older than the supported minimum ${SUPPORT_MATRIX.opencode.minimum}`,
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

/** Repair text for an OpenCode 1.x host: Workit 3 ships only the V2
 * `setup()` plugin entry, so a 1.x host needs the 2.x plugin line. */
export const OPENCODE_V1_FIX = `OpenCode < ${SUPPORT_MATRIX.opencode.minimum} cannot load Workit 3 (V2 plugin API only): upgrade OpenCode to ${SUPPORT_MATRIX.opencode.minimum}+, or stay on Workit 2.x by pinning "@brainervirus/workit-opencode@2" in the opencode.json "plugin" array`;

/**
 * The installed OpenCode CLI must speak the V2 plugin API (Workit 3 retired
 * the V1 `server()` entry). Bounded probe; an absent CLI is not an error.
 */
const checkOpencodeVersion = (res: Resolved): DoctorCheck => {
  const minimum = SUPPORT_MATRIX.opencode.minimum;
  if (!commandOnPath("opencode", res.env))
    return {
      id: "opencode_version",
      status: "pass",
      detail: "opencode CLI not on PATH — skipping version check",
    };
  // OpenCode writes a log under its data dir even for --version: point its XDG
  // dirs at a throwaway directory so the doctor never writes into the home.
  const scratch = mkdtempSync(path.join(os.tmpdir(), "workit-doctor-opencode-"));
  let raw: string | null;
  try {
    raw = versionOf(
      "opencode",
      {
        ...res.env,
        XDG_DATA_HOME: path.join(scratch, "data"),
        XDG_STATE_HOME: path.join(scratch, "state"),
        XDG_CACHE_HOME: path.join(scratch, "cache"),
      },
      5_000,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const installed = raw ? ((raw.match(/\d+\.\d+\.\d+/) ?? [])[0] ?? null) : null;
  if (installed === null)
    return {
      id: "opencode_version",
      status: "warn",
      detail: `could not read the installed opencode version — Workit needs OpenCode ${minimum}+`,
      fix: OPENCODE_V1_FIX,
    };
  if (semverAtLeast(installed, minimum))
    return {
      id: "opencode_version",
      status: "pass",
      detail: `opencode ${installed} supports the V2 plugin API (minimum ${minimum})`,
    };
  return {
    id: "opencode_version",
    status: "fail",
    detail: `opencode ${installed} is older than the supported minimum ${minimum}`,
    fix: OPENCODE_V1_FIX,
  };
};

// The Codex CLI is a qualification host, not a runtime dependency: evidence
// covers exactly SUPPORT_MATRIX.codex.cli. A drifted install keeps working,
// but warns so a fresh install never silently outruns the qualification pin.
const checkCodexPin = (res: Resolved): DoctorCheck => {
  const qualified = SUPPORT_MATRIX.codex.cli;
  if (!commandOnPath("codex", res.env))
    return {
      id: "codex_pin",
      status: "pass",
      detail: "codex CLI not on PATH — skipping pin check",
    };
  const raw = versionOf("codex", res.env);
  const installed = raw ? ((raw.match(/\d+\.\d+\.\d+/) ?? [])[0] ?? null) : null;
  if (installed === null)
    return {
      id: "codex_pin",
      status: "warn",
      detail: `could not parse the installed codex version — cannot confirm the qualified ${qualified}`,
      fix: `Reinstall the qualified Codex CLI ${qualified} or record fresh qualification evidence`,
    };
  if (installed === qualified)
    return {
      id: "codex_pin",
      status: "pass",
      detail: `codex CLI ${installed} matches the qualified pin`,
    };
  return {
    id: "codex_pin",
    status: "warn",
    detail: `codex CLI ${installed} differs from the qualified ${qualified}`,
    fix: `Reinstall the qualified Codex CLI ${qualified} or record fresh qualification evidence`,
  };
};

// Codex plugin install ---------------------------------------------------------
// Verified against codex-cli 0.160.1 on scratch homes: `codex plugin add`
// records `[plugins."<plugin>@<marketplace>"] enabled = true` in
// `$CODEX_HOME/config.toml` and installs under
// `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>`.

/** The `[table]` key/values of a TOML file Codex writes; enough for the tables read here. */
const readTomlTables = (file: string): Map<string, Record<string, string | boolean>> => {
  const tables = new Map<string, Record<string, string | boolean>>();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return tables;
  }
  const unquote = (raw: string): string => {
    const s = raw.trim();
    if (s.startsWith('"')) {
      try {
        return JSON.parse(s) as string;
      } catch {
        return s.slice(1, -1);
      }
    }
    return s.startsWith("'") ? s.slice(1, -1) : s;
  };
  const SEGMENT = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(?:\.|$)/y;
  let current: Record<string, string | boolean> = {};
  tables.set("", current);
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      const parts: string[] = [];
      SEGMENT.lastIndex = 0;
      let match: RegExpExecArray | null;
      while (SEGMENT.lastIndex < header[1].length && (match = SEGMENT.exec(header[1])))
        parts.push(unquote(match[1]));
      const key = parts.join("\0");
      current = tables.get(key) ?? {};
      tables.set(key, current);
      continue;
    }
    const pair = /^\s*("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!pair) continue;
    const value = pair[2].replace(/\s+#[^"']*$/, "");
    current[unquote(pair[1])] =
      value === "true" ? true : value === "false" ? false : unquote(value);
  }
  return tables;
};

type CodexWorkitInstall = {
  id: string;
  marketplace: string;
  root: string | null;
  version: string | null;
  configFile: string;
};

const codexHomeOf = (res: Resolved): string =>
  res.codexHome ?? (res.env.CODEX_HOME || path.join(res.home, ".codex"));

/** Enabled `workit@<marketplace>` plugins and their newest cached install. */
const codexWorkitInstalls = (res: Resolved): CodexWorkitInstall[] => {
  const codexHome = codexHomeOf(res);
  const configFile = path.join(codexHome, "config.toml");
  const installs: CodexWorkitInstall[] = [];
  for (const [key, table] of readTomlTables(configFile)) {
    const [kind, id, ...rest] = key.split("\0");
    if (
      kind !== "plugins" ||
      rest.length > 0 ||
      !id?.startsWith("workit@") ||
      table.enabled === false
    )
      continue;
    const marketplace = id.slice("workit@".length);
    const dir = path.join(codexHome, "plugins", "cache", marketplace, "workit");
    let versions: string[] = [];
    try {
      versions = readdirSync(dir).filter((v) => existsSync(path.join(dir, v, ".codex-plugin")));
    } catch {
      versions = [];
    }
    const version = versions.reduce<string | null>(
      (best, v) => (best && semverAtLeast(best, v) ? best : v),
      null,
    );
    installs.push({
      id,
      marketplace,
      root: version ? path.join(dir, version) : null,
      version,
      configFile,
    });
  }
  return installs;
};

const snakeEvent = (event: string): string =>
  event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/**
 * The hash codex-cli 0.160.1 records as `trusted_hash` for one command hook:
 * sha256 of the compact, key-sorted JSON `{event_name, hooks: [{async,
 * command, timeout, type}], matcher?}` with Codex's defaults (async false,
 * timeout 600). Derived and checked against `hooks/list` from `codex
 * app-server` for every workit hook. Null for a handler shape it was not
 * checked against: the doctor then only checks that a trust entry exists.
 */
const codexHookHash = (event: string, matcher: unknown, handler: Record<string, unknown>) => {
  if (
    handler.type !== "command" ||
    typeof handler.command !== "string" ||
    Object.keys(handler).some((k) => !["type", "command", "timeout", "async"].includes(k))
  )
    return null;
  const hook = {
    async: handler.async ?? false,
    command: handler.command,
    timeout: handler.timeout ?? 600,
    type: "command",
  };
  const body = {
    event_name: snakeEvent(event),
    hooks: [hook],
    ...(typeof matcher === "string" ? { matcher } : {}),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
};

type CodexHookTrust = {
  key: string;
  hash: string | null;
  state: "trusted" | "untrusted" | "modified" | "disabled";
};

const codexHookTrust = (
  install: CodexWorkitInstall,
  tables: Map<string, Record<string, string | boolean>>,
): CodexHookTrust[] | null => {
  const hooks = install.root
    ? readJson(path.join(install.root, "hooks", "hooks.json"))?.hooks
    : null;
  if (!hooks || typeof hooks !== "object") return null;
  const result: CodexHookTrust[] = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group: any, g: number) => {
      const handlers: unknown[] = Array.isArray(group?.hooks) ? group.hooks : [];
      handlers.forEach((handler, h) => {
        const key = `${install.id}:hooks/hooks.json:${snakeEvent(event)}:${g}:${h}`;
        const hash = codexHookHash(
          event,
          group?.matcher,
          (handler ?? {}) as Record<string, unknown>,
        );
        const state = tables.get(["hooks", "state", key].join("\0"));
        const trusted = typeof state?.trusted_hash === "string" ? state.trusted_hash : null;
        result.push({
          key,
          hash,
          state:
            state?.enabled === false
              ? "disabled"
              : trusted === null
                ? "untrusted"
                : hash !== null && trusted !== hash
                  ? "modified"
                  : "trusted",
        });
      });
    });
  }
  return result;
};

/**
 * Codex skips plugin hooks until the user trusts the current definition
 * (developers.openai.com/codex/plugins/build). codex-cli 0.160.1 records trust
 * in config.toml as `[hooks.state."<plugin>:hooks/hooks.json:<event>:<group>:<handler>"]
 * trusted_hash = "sha256:…"`; `/hooks` in the TUI and the startup "Hooks need
 * review" prompt write it. An untrusted, changed or disabled workit hook warns.
 */
const checkCodexHooks = (res: Resolved): DoctorCheck => {
  const installs = codexWorkitInstalls(res);
  if (installs.length === 0)
    return {
      id: "codex_hooks",
      status: "pass",
      detail: "no Workit Codex plugin enabled — skipping",
    };
  const tables = readTomlTables(installs[0].configFile);
  const problems: string[] = [];
  const toTrust: CodexHookTrust[] = [];
  let reinstall: string | undefined;
  let total = 0;
  for (const install of installs) {
    const trust = codexHookTrust(install, tables);
    if (!trust) {
      problems.push(`${install.id}: no installed hooks/hooks.json`);
      reinstall ??= `codex plugin remove ${install.id} && codex plugin add ${install.id}`;
      continue;
    }
    total += trust.length;
    for (const state of ["untrusted", "modified", "disabled"] as const) {
      const hit = trust.filter((t) => t.state === state);
      if (hit.length > 0)
        problems.push(
          `${install.id}: ${hit.length} of ${trust.length} hooks ${state === "modified" ? "changed since trusted" : state} (${hit.map((t) => t.key.split(":")[2]).join(", ")})`,
        );
    }
    toTrust.push(...trust.filter((t) => t.state !== "trusted"));
  }
  if (problems.length === 0)
    return {
      id: "codex_hooks",
      status: "pass",
      detail: `${total} Workit Codex plugin hooks trusted (${installs.map((i) => `${i.id} ${i.version ?? "?"}`).join(", ")})`,
    };
  const settings = toTrust
    .filter((t) => t.state !== "disabled" && t.hash)
    .map((t) => `[hooks.state."${t.key}"]\ntrusted_hash = "${t.hash}"`);
  const disabled = toTrust.some((t) => t.state === "disabled");
  const fix =
    reinstall ??
    [
      `Start \`codex\`, run \`/hooks\` and ${disabled ? "enable and " : ""}trust the workit hooks (or pick "Trust all and continue" at the startup hook review)`,
      settings.length > 0 ? `or add to ${installs[0].configFile}:\n${settings.join("\n")}` : null,
    ]
      .filter(Boolean)
      .join("; ");
  return {
    id: "codex_hooks",
    status: "warn",
    detail: `Codex skips untrusted plugin hooks — ${problems.join("; ")}`,
    fix,
  };
};

/** First line of a Workit-generated Codex agent (workit-codex scripts/agents.ts). */
const CODEX_AGENT_MARKER = "# Generated by Workit";

/**
 * codex-cli 0.160.1 plugins cannot register agents, so the Workit plugin's MCP
 * launcher copies its agents/*.toml into `$CODEX_HOME/agents/`, where Codex
 * reads custom agents at session start. Missing or outdated copies warn.
 */
const checkCodexAgents = (res: Resolved): DoctorCheck => {
  const installs = codexWorkitInstalls(res);
  if (installs.length === 0)
    return {
      id: "codex_agents",
      status: "pass",
      detail: "no Workit Codex plugin enabled — skipping",
    };
  const agentsDir = path.join(codexHomeOf(res), "agents");
  const problems: string[] = [];
  const fixes: string[] = [];
  const installed: string[] = [];
  for (const install of installs) {
    const source = install.root ? path.join(install.root, "agents") : null;
    const files =
      source && existsSync(source)
        ? readdirSync(source)
            .filter((f) => f.endsWith(".toml"))
            .toSorted()
        : [];
    if (files.length === 0) {
      problems.push(`${install.id} ${install.version ?? "?"} bundles no agents`);
      fixes.push(`codex plugin remove ${install.id} && codex plugin add ${install.id}`);
      continue;
    }
    const install_fix = `node ${JSON.stringify(path.join(install.root!, "dist", "launch-mcp.js"))} --install-agents, then start a new Codex session`;
    let stale = false;
    for (const file of files) {
      const dest = path.join(agentsDir, file);
      const want = readFileSync(path.join(source!, file), "utf8");
      let have: string | null = null;
      try {
        have = readFileSync(dest, "utf8");
      } catch {
        have = null;
      }
      if (have === want) {
        installed.push(file.replace(/\.toml$/, ""));
        continue;
      }
      if (have !== null && !have.startsWith(CODEX_AGENT_MARKER)) {
        problems.push(`${dest} is a user agent that shadows ${install.id}'s ${file}`);
        fixes.push(`rename or remove ${dest}, then run ${install_fix}`);
        continue;
      }
      problems.push(`${dest} ${have === null ? "missing" : "outdated"}`);
      stale = true;
    }
    if (stale) fixes.push(install_fix);
  }
  if (problems.length === 0)
    return {
      id: "codex_agents",
      status: "pass",
      detail: `Codex agents ${installed.join(", ")} installed in ${agentsDir}`,
    };
  return {
    id: "codex_agents",
    status: "warn",
    detail: problems.join("; "),
    fix: [...new Set(fixes)].join("; "),
  };
};

// Pi package -----------------------------------------------------------------
// Verified against @earendil-works/pi-coding-agent 0.85.1 (docs/packages.md,
// docs/settings.md, dist/core/package-manager.js): `pi install` records the
// source in `packages` of `<agentDir>/settings.json` (or `.pi/settings.json`
// with -l; the project entry wins), npm sources install to
// `<agentDir>/npm/node_modules/<name>` (`.pi/npm/...` for a project), local
// paths resolve against the settings file's directory, and an object entry's
// `extensions` patterns filter what loads (`!x` excludes, `+x`/`-x` force).

const PI_PACKAGE = "@brainervirus/workit-pi";
const PI_EXTENSION = "dist/workit.js";

type PiEntry = {
  scope: "user" | "project";
  settingsFile: string;
  source: string;
  filter: unknown;
  root: string;
  npm: { pinned: boolean } | null;
};

const piAgentDirOf = (res: Resolved): string => {
  if (res.piAgentDir) return res.piAgentDir;
  const env = res.env.PI_CODING_AGENT_DIR;
  if (env) return env === "~" ? res.home : env.replace(/^~(?=\/|\\)/, res.home);
  return path.join(res.home, ".pi", "agent");
};

const npmSpecName = (spec: string): { name: string; pinned: boolean } => {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at > 0 ? { name: spec.slice(0, at), pinned: true } : { name: spec, pinned: false };
};

const findPiEntry = (res: Resolved, agentDir: string): PiEntry | null => {
  const scopes = [
    {
      scope: "project" as const,
      settingsFile: path.join(res.cwd, ".pi", "settings.json"),
      base: path.join(res.cwd, ".pi"),
    },
    { scope: "user" as const, settingsFile: path.join(agentDir, "settings.json"), base: agentDir },
  ];
  for (const { scope, settingsFile, base } of scopes) {
    const packages = readJson(settingsFile)?.packages;
    if (!Array.isArray(packages)) continue;
    for (const entry of packages) {
      const source =
        typeof entry === "string" ? entry : typeof entry?.source === "string" ? entry.source : null;
      if (!source) continue;
      const filter = typeof entry === "object" ? entry : null;
      if (source.startsWith("npm:")) {
        const spec = npmSpecName(source.slice(4).trim());
        if (spec.name !== PI_PACKAGE) continue;
        const root = path.join(base, "npm", "node_modules", ...PI_PACKAGE.split("/"));
        return { scope, settingsFile, source, filter, root, npm: { pinned: spec.pinned } };
      }
      if (/^(git:|https?:|ssh:|git@)/.test(source)) continue;
      const local = path.resolve(base, source.replace(/^~(?=\/|\\)/, res.home));
      if (readJson(path.join(local, "package.json"))?.name === PI_PACKAGE)
        return { scope, settingsFile, source, filter, root: local, npm: null };
    }
  }
  return null;
};

const globToRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .replace(/^\.\//, "")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .split(/\*\*\/?/)
      .map((part) => part.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))
      .join(".*")}$`,
  );

/** Whether an entry's `extensions` filter keeps `file` (pi's applyPatterns, on one path). */
const piFilterKeeps = (patterns: unknown, file: string): boolean => {
  if (!Array.isArray(patterns)) return true;
  const list = patterns.filter((p): p is string => typeof p === "string");
  // `[]` disables every extension of the package.
  if (list.length === 0) return false;
  const name = path.posix.basename(file);
  const matches = (p: string) => {
    const re = globToRegExp(p);
    return re.test(file) || re.test(name);
  };
  const exact = (p: string) => p.replace(/^\.\//, "") === file;
  const includes = list.filter((p) => !/^[!+-]/.test(p));
  let kept = includes.length === 0 || includes.some(matches);
  if (list.some((p) => p.startsWith("!") && matches(p.slice(1)))) kept = false;
  if (list.some((p) => p.startsWith("+") && exact(p.slice(1)))) kept = true;
  if (list.some((p) => p.startsWith("-") && exact(p.slice(1)))) kept = false;
  return kept;
};

/**
 * Pi runs the Workit extension only when the package is listed, installed,
 * not filtered out, and ships its entry; it should also be no older than the
 * workit CLI running this check. Skipped when Pi is absent.
 */
const checkPiExtension = (res: Resolved): DoctorCheck & { registryProbed?: boolean } => {
  const agentDir = piAgentDirOf(res);
  if (!existsSync(agentDir) && !commandOnPath("pi", res.env))
    return { id: "pi_extension", status: "pass", detail: "Pi not installed — skipping" };
  const installCmd = (scope: PiEntry["scope"] | "user", spec = `npm:${PI_PACKAGE}`) =>
    `pi install ${spec}${scope === "project" ? " -l" : ""}`;
  const entry = findPiEntry(res, agentDir);
  if (!entry)
    return {
      id: "pi_extension",
      status: "warn",
      detail: `Workit Pi extension missing: no ${PI_PACKAGE} entry in ${path.join(agentDir, "settings.json")} or ${path.join(res.cwd, ".pi", "settings.json")}`,
      fix: installCmd("user"),
    };
  const where = `${entry.source} (${entry.scope}, ${entry.settingsFile})`;
  const rebuild = `cd ${JSON.stringify(entry.root)} && bun run build`;
  const pkg = readJson(path.join(entry.root, "package.json"));
  if (!pkg)
    return {
      id: "pi_extension",
      status: "warn",
      detail: `Workit Pi extension missing: ${where} is listed but not installed at ${entry.root}`,
      fix: entry.npm
        ? installCmd(entry.scope, entry.source)
        : `restore ${entry.root}, then ${rebuild}`,
    };
  const declared = Array.isArray(pkg.pi?.extensions)
    ? pkg.pi.extensions.some(
        (e: unknown) => typeof e === "string" && e.replace(/^\.\//, "") === PI_EXTENSION,
      )
    : false;
  if (!declared || !existsSync(path.join(entry.root, PI_EXTENSION)))
    return {
      id: "pi_extension",
      status: "warn",
      detail: `Workit Pi extension not loading: ${entry.root} ${declared ? `has no ${PI_EXTENSION}` : `does not declare ${PI_EXTENSION} in its pi manifest`}`,
      // npm leaves an installed same-version package as is: remove it first.
      fix: entry.npm
        ? `pi remove ${entry.source}${entry.scope === "project" ? " -l" : ""} && ${installCmd(entry.scope, entry.source)}`
        : rebuild,
    };
  const filter = (entry.filter as { extensions?: unknown } | null)?.extensions;
  if (!piFilterKeeps(filter, PI_EXTENSION))
    return {
      id: "pi_extension",
      status: "warn",
      detail: `Workit Pi extension not loading: the ${PI_PACKAGE} entry in ${entry.settingsFile} filters out ${PI_EXTENSION} (extensions: ${JSON.stringify(filter)})`,
      fix: `remove the "extensions" filter from the ${PI_PACKAGE} entry in ${entry.settingsFile}, or enable the extension with \`pi config${entry.scope === "project" ? " -l" : ""}\``,
    };
  const version = typeof pkg.version === "string" ? pkg.version : null;
  const cli = cliPkg.version;
  if (version && versionBehind(version, cli)) {
    // Pi packages publish only when their payload changes: older than the CLI
    // is stale only if a newer one exists (or the registry cannot say).
    const latest = entry.npm ? registryLatestVersion(res, PI_PACKAGE) : null;
    const registryProbed = latest !== null && !res.env.WORKIT_DOCTOR_STALE_REGISTRY_VERSION;
    if (!latest || versionBehind(version, latest)) {
      const fix = !entry.npm
        ? `git -C ${JSON.stringify(entry.root)} pull && ${rebuild}`
        : entry.npm.pinned
          ? installCmd(entry.scope, `npm:${PI_PACKAGE}@${latest ?? cli}`)
          : `pi update npm:${PI_PACKAGE}`;
      return {
        id: "pi_extension",
        status: "warn",
        detail: `Workit Pi extension stale: ${PI_PACKAGE} ${version} from ${where} is older than workit ${cli}${latest ? ` (published ${latest})` : ""}`,
        fix,
        registryProbed,
      };
    }
    return {
      id: "pi_extension",
      status: "pass",
      detail: `Workit Pi extension ${version} from ${where} is the newest published (workit ${cli})`,
      registryProbed,
    };
  }
  return {
    id: "pi_extension",
    status: "pass",
    detail: `Workit Pi extension ${version ?? "?"} from ${where} loads ${PI_EXTENSION}`,
  };
};

const assetPathsFor = (host: DoctorHost, dev: string): string[] => {
  const pkg = path.join(dev, "packages", `workit-${host}`);
  switch (host) {
    case "opencode": {
      // A source checkout has no generated assets/skills copy (git-ignored);
      // the plugin then reads the canonical core skills, so check those.
      const packaged = path.join(pkg, "assets", "skills");
      const root = existsSync(packaged)
        ? packaged
        : path.join(dev, "packages", "workit-core", "skills");
      return WORKIT_METHOD_SKILLS.map((skill) => path.join(root, skill, "SKILL.md"));
    }
    case "cursor":
      return [
        path.join(pkg, "assets", "templates", "workit-contract.md"),
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
    const cursorError = validateCursorSkills(res.cursorPluginDir, WORKIT_METHOD_SKILLS);
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
  // Exact positional tokens — a substring match would accept `@latest-alpha`
  // or `workit-cursor-mcp-foo`, and any extra/missing token would weaken the
  // freshness guarantee (`--prefer-online` and the npm release-age workaround
  // are mandatory).
  const canonical = cursorMcpServerEntry("").args;
  if (executable === "npx" || executable === "npx.exe" || executable === "npx.cmd") {
    if (args.length !== canonical.length || args.some((a, i) => a !== canonical[i]))
      return "invalid";
    return { kind: "npx" };
  }
  if (executable !== "node" && executable !== "node.exe") return "invalid";
  return {
    kind: "node",
    runtime: command,
    entry: path.isAbsolute(args[0]) ? args[0] : path.resolve(path.dirname(res.cursorMcp), args[0]),
  };
};

// The canonical session-start hook runs the plugin's pinned launcher as a
// single command string (Cursor's documented hook format). The doctor
// validates its shape exactly — no substring matching.
const canonicalCursorHook = cursorHooksEntry().command;
// A local install writes the absolute launcher path instead of the variable.
const isCanonicalCursorHook = (command: string, res: Resolved): boolean =>
  command === canonicalCursorHook || command === cursorHooksEntry(res.cursorPluginDir).command;

// Returns the registered hook command, null when absent, or "invalid".
const registeredCursorHook = (res: Resolved): string | null => {
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

// The local-dist install points the session-start hook at the plugin's own
// built dist (`node <pluginDir>/dist/cursor-session-start.js`) so Cursor runs
// the checkout's code. Accept that form — validated against the real dist entry
// — alongside the canonical launcher, mirroring the MCP launcher's node form.
const validLocalDistHook = (command: string, res: Resolved): boolean => {
  const m = /^node\s+(.+)$/.exec(command.trim());
  if (!m) return false;
  const entry = m[1].trim();
  if (!path.isAbsolute(entry)) return false;
  if (
    path.resolve(entry) !==
    path.resolve(path.join(res.cursorPluginDir, "dist", "cursor-session-start.js"))
  ) {
    return false;
  }
  return validNodeEntry(entry, "node", res.env);
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
    } else if (
      hook !== null &&
      !isCanonicalCursorHook(hook, res) &&
      !validLocalDistHook(hook, res)
    ) {
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
  return {
    id: "launcher",
    status: "pass",
    detail: `${res.host} launcher/hook entries present`,
  };
};

// Ask the installed plugin's own hook launcher (hooks/launch.mjs --probe)
// which runtime Cursor would run (its bundled dist, a global bin, or npx pinned
// to the plugin's version) and time one no-op hook through it, node startup
// included, as Cursor pays it. The npx probe runs with --offline, so the
// doctor never downloads: a cold npx cache reports as such instead.
const CURSOR_HOOK_FIX = "Run `workit init` and select Cursor to install the bundled hook";

const checkCursorHook = (res: Resolved): DoctorCheck => {
  if (!hostsFor(res.host).includes("cursor"))
    return { id: "cursor_hook", status: "pass", detail: "cursor hook not inspected on this host" };
  if (!existsSync(res.cursorPluginDir))
    return {
      id: "cursor_hook",
      status: "pass",
      detail: "no Cursor plugin install — hook launcher not inspected",
    };
  const launcher = path.join(res.cursorPluginDir, "hooks", "launch.mjs");
  if (!existsSync(launcher))
    return {
      id: "cursor_hook",
      status: "warn",
      detail: `cursor hook launcher mode: missing — ${launcher} is absent (an install from before the pinned launcher)`,
      fix: CURSOR_HOOK_FIX,
    };
  // The registered commands must run the launcher; anything else (a legacy
  // npx @latest entry, a hand edit) is what stale_install repairs.
  const hooksFile = path.join(res.cursorPluginDir, "hooks", "hooks-cursor.json");
  const registered = readJson(hooksFile);
  const sessionCommand = registered?.hooks?.sessionStart?.[0]?.command;
  const offLauncher = [
    ...(typeof sessionCommand === "string" &&
    !isCanonicalCursorHook(sessionCommand, res) &&
    !validLocalDistHook(sessionCommand, res)
      ? ["sessionStart"]
      : []),
    ...(registered ? cursorHookDrift(registered, res.cursorPluginDir) : ["hooks file"]),
  ];
  if (offLauncher.length > 0)
    return {
      id: "cursor_hook",
      status: "warn",
      detail: `cursor hook launcher mode: stale — ${hooksFile} does not run the launcher for ${offLauncher.join(", ")} (see stale_install)`,
      fix: "Re-run install-cursor-plugin.sh (or `workit init` with Cursor) to rewrite the hook entries",
    };
  const started = performance.now();
  const probe = spawnSync("node", [launcher, "--probe", "workit-cursor-hook"], {
    encoding: "utf8",
    env: { ...res.env, WORKIT_CURSOR_HOOK_NPX_OFFLINE: "1" },
    timeout: 40_000,
    windowsHide: true,
  });
  const ms = Math.round(performance.now() - started);
  let report: { mode?: unknown; source?: unknown; version?: unknown; error?: unknown } = {};
  try {
    report = JSON.parse(probe.stdout || "{}");
  } catch {
    /* reported below as a failed probe */
  }
  const mode = typeof report.mode === "string" ? report.mode : null;
  if (mode === "missing")
    return {
      id: "cursor_hook",
      status: "warn",
      detail:
        "cursor hook launcher mode: missing — no bundled hook, no workit-cursor-hook on PATH, no npx; Cursor hooks fail open (no Workit enforcement)",
      fix: CURSOR_HOOK_FIX,
    };
  // npx-pinned names its version in the source already.
  const version =
    mode === "local" && typeof report.version === "string" ? `, v${report.version}` : "";
  const label = `cursor hook launcher mode: ${mode ?? "unknown"} (${String(report.source ?? launcher)}${version})`;
  const error =
    typeof report.error === "string"
      ? report.error.replace(/^\[workit\] Cursor hook unavailable: /, "")
      : mode === null
        ? (probe.error?.message ?? `launcher exited ${probe.status ?? probe.signal}`)
        : null;
  if (error)
    return {
      id: "cursor_hook",
      status: "warn",
      detail: `${label}; probe failed after ${ms} ms (${error})${mode === "npx-pinned" ? " — the pinned package is not in the npx cache yet" : ""}; Cursor hooks fail open until it runs`,
      fix: CURSOR_HOOK_FIX,
    };
  if (mode === "npx-pinned")
    return {
      id: "cursor_hook",
      status: "warn",
      detail: `${label}; probe ${ms} ms — every Cursor shell command and edit spawns npx`,
      fix: `${CURSOR_HOOK_FIX} (faster, no npm at hook time)`,
    };
  const silent = silentCursorHooks(res);
  if (silent)
    return {
      id: "cursor_hook",
      status: "warn",
      detail: `${label}; probe ${ms} ms; ${silent}`,
      fix: "Open a Cursor agent chat, then re-run `workit doctor`; if this persists, re-run `workit init` with Cursor (it writes absolute hook paths)",
    };
  return { id: "cursor_hook", status: "pass", detail: `${label}; probe ${ms} ms` };
};

// The Cursor MCP server stamps cursor-session-last-start when Cursor starts
// it; the hook launcher stamps cursor-hook-last-run on every hook. A session
// older than the grace period with no hook since means Cursor is not running
// the plugin's hooks (for example `${CURSOR_PLUGIN_ROOT}` left unexpanded):
// hooks fail open, so nothing else would show it.
const SILENT_HOOK_GRACE_MS = 2 * 60_000;
const mtimeMs = (file: string): number | null => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
};
const silentCursorHooks = (res: Resolved): string | null => {
  const session = mtimeMs(path.join(res.cursorHeartbeatDir, "cursor-session-last-start"));
  if (session === null || Date.now() - session < SILENT_HOOK_GRACE_MS) return null;
  const hook = mtimeMs(path.join(res.cursorHeartbeatDir, "cursor-hook-last-run"));
  if (hook !== null && hook >= session) return null;
  return `Cursor started the Workit MCP server at ${new Date(session).toISOString()} but no Workit hook has run since${hook === null ? " (none ever)" : ""} — if the agent ran in that window, Cursor is not running the plugin hooks and Workit enforcement is off`;
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
  return {
    id: "utility",
    status: "pass",
    detail: "git (and flock where required) on PATH",
  };
};

/** file:// pins into package-manager ephemeral caches (pnpm dlx, npx). */
const isFragileCachePin = (entry: string): boolean => {
  const n = entry.replaceAll("\\", "/").toLowerCase();
  if (!n.startsWith("file:")) return false;
  return isEphemeralCachePath(entry);
};

const staleEntry = (entry: string): "ok" | "stale" | "missing-file" | "fragile-cache" => {
  if (!entry) return "stale";
  if (entry.includes("git+file")) return "stale";
  if (isFragileCachePin(entry)) return "fragile-cache";
  if (entry.startsWith("file:")) {
    const target = entry.replace(/^file:\/\//, "").replace(/^file:/, "");
    return existsSync(target) ? "ok" : "missing-file";
  }
  // Registry package names (e.g. @brainervirus/workit-opencode) are the
  // published pin shape — OpenCode resolves them; not labelled stale.
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
    return {
      id: "stale_pin",
      status: "pass",
      detail: "no opencode config — not registered",
    };
  }
  const cfg = readJson(res.opencodeConfig);
  const entries = pluginEntries(cfg);
  if (entries.length === 0) {
    return {
      id: "stale_pin",
      status: "fail",
      detail: "no workit plugin registered in the opencode config",
      fix: 'Run `workit init` and select OpenCode — pin "@brainervirus/workit-opencode"',
    };
  }
  const first = staleEntry(entries[0]);
  if (first === "stale") {
    return {
      id: "stale_pin",
      status: "fail",
      detail: `stale workit pin: ${entries[0]}`,
      fix: "Run `workit init` (or install-opencode-plugin.sh for a checkout) — replace git+file pins",
    };
  }
  if (first === "fragile-cache") {
    return {
      id: "stale_pin",
      status: "fail",
      detail: `workit pin points at a package-manager cache path: ${entries[0]}`,
      fix: 'Run `workit init` and select OpenCode — pin should be "@brainervirus/workit-opencode"',
    };
  }
  if (first === "missing-file") {
    return {
      id: "stale_pin",
      status: "fail",
      detail: `workit pin points at a missing file: ${entries[0]}`,
      fix: "Run `workit init` (or restore the checkout and re-run install-opencode-plugin.sh)",
    };
  }
  return { id: "stale_pin", status: "pass", detail: "opencode pin resolves" };
};

// Cursor plugin stale-install detection (CA-01/CA-04). Compares the installed
// `~/.cursor/plugins/local/workit` against the current runtime source of truth
// (`CURSOR_RUNTIME_PACKAGE` + the canonical entry builders from registration.ts,
// D-02) and surfaces a structured `stale_install` finding with the exact repair
// step. A stale install means the plugin's sessionStart hook and MCP entry run
// an ancient runtime that no longer auto-registers the workflow features.
//
// Three independent staleness signals are read from the installed plugin dir:
//  1. Legacy selectors (offline evidence, checked first): the plugin's own
//     mcp.json (`--package=...workit-cursor@<exact>` pins other than the
//     canonical `@latest`) and hooks-cursor.json sessionStart command.
//  2. Installed version behind the current source release (offline): the dev
//     checkout's workit-cursor version (or the doctor's own package version)
//     is the release train the doctor ships with.
//  3. Local-dist installs behind the published runtime (needs the registry):
//     the probe is the sole network read in the doctor. A SUCCEEDED probe with
//     the installed version genuinely behind the published runtime is a hard
//     `stale_install` fail (the installer self-heals on it); an unreachable
//     registry fails open (CA-04) as a `registry_unreachable` warning, never a
//     false `stale_install` and never a hard doctor failure. Canonical
//     `@latest` installs skip the probe entirely: the selector resolves fresh
//     at launch, so the installed package.json version is metadata, not a
//     freshness signal.
// OpenCode npm pins (`@brainervirus/workit-opencode` / `@…@latest`) are different:
// OpenCode freezes the first resolved version under
// `~/.cache/opencode/packages/@brainervirus/workit-opencode@latest` and does not
// re-resolve on later launches. Doctor compares that cache to the published
// package (same CA-04 fail-open seam) and tells the user to delete the cache
// directory so OpenCode can resolve `@latest` again. Exact `@version` pins and
// `file://` checkout pins skip the comparison.
// Test seams (no spawns on the canonical path): WORKIT_DOCTOR_STALE_REGISTRY_VERSION
// short-circuits the probe with the resolved latest version; the optional
// WORKIT_DOCTOR_STALE_REGISTRY_CMD replaces the `npm view` binary (a
// nonexistent path deterministically exercises the fail-open path).
const pluginMcpSelectors = (res: Resolved): string[] | null => {
  const p = path.join(res.cursorPluginDir, "mcp.json");
  if (!existsSync(p)) return null;
  const cfg = readJson(p);
  const server = cfg?.mcpServers?.workit;
  if (!server || typeof server !== "object" || Array.isArray(server)) return null;
  const args = server.args;
  if (!Array.isArray(args)) return null;
  return args.map(String).filter((a) => a.startsWith("--package="));
};

const isFloatingOpenCodeNpmPin = (entry: string): boolean => {
  const s = entry.trim();
  return s === OPENCODE_NPM_PIN || s === `${OPENCODE_NPM_PIN}@latest`;
};

const registryLatestVersion = (
  res: Resolved,
  pkgName: string = CURSOR_RUNTIME_PACKAGE,
): string | null => {
  const seam = res.env.WORKIT_DOCTOR_STALE_REGISTRY_VERSION;
  if (typeof seam === "string" && seam) {
    return /^\d+(?:\.\d+){1,2}$/.test(seam) ? seam : null;
  }
  const cmd =
    res.env.WORKIT_DOCTOR_STALE_REGISTRY_CMD ?? (commandOnPath("npm", res.env) ? "npm" : null);
  if (!cmd) return null;
  try {
    const r = spawnSync(cmd, ["view", pkgName, "version"], {
      encoding: "utf8",
      timeout: 20_000,
      env: res.env,
    });
    const v = (r.stdout ?? "").trim().split(/\s+/)[0];
    return r.status === 0 && /^\d+(?:\.\d+){1,2}$/.test(v) ? v : null;
  } catch {
    return null;
  }
};

const installedPluginVersion = (res: Resolved): string | null => {
  const pkg = readJson(path.join(res.cursorPluginDir, "package.json"));
  return typeof pkg?.version === "string" && pkg.version ? pkg.version : null;
};

const installedOpenCodeCacheVersion = (res: Resolved): string | null => {
  const pkg = readJson(
    path.join(
      res.opencodePackageCacheDir,
      "node_modules",
      "@brainervirus",
      "workit-opencode",
      "package.json",
    ),
  );
  return typeof pkg?.version === "string" && pkg.version ? pkg.version : null;
};

/** OpenCode freezes the first `@latest` resolve in its package cache — detect lag. */
const checkOpenCodePackageCache = (res: Resolved): DoctorCheck & { registryProbed?: boolean } => {
  if (!existsSync(res.opencodeConfig)) {
    return {
      id: "stale_install",
      status: "pass",
      detail: "no opencode config — package cache not inspected",
    };
  }
  const entries = pluginEntries(readJson(res.opencodeConfig));
  if (entries.length === 0) {
    return {
      id: "stale_install",
      status: "pass",
      detail: "no workit opencode pin — package cache not inspected",
    };
  }
  const pin = entries[0];
  if (pin.startsWith("file:") || pin.startsWith("git+file:")) {
    return {
      id: "stale_install",
      status: "pass",
      detail: "opencode checkout pin — package cache not used for npm resolution",
    };
  }
  if (!isFloatingOpenCodeNpmPin(pin)) {
    return {
      id: "stale_install",
      status: "pass",
      detail: `opencode pin ${pin} is an exact version — not compared to registry latest`,
    };
  }
  const installed = installedOpenCodeCacheVersion(res);
  if (installed === null) {
    return {
      id: "stale_install",
      status: "pass",
      detail: "opencode @latest package cache empty — OpenCode will resolve on next launch",
    };
  }
  const expected = registryLatestVersion(res, OPENCODE_NPM_PIN);
  if (expected === null) {
    return {
      id: "registry_unreachable",
      status: "warn",
      registryProbed: true,
      detail:
        "registry_unreachable: cannot compare OpenCode @latest cache against published workit-opencode",
      fix: `Retry when npm is reachable, or remove ${res.opencodePackageCacheDir} and restart OpenCode to re-resolve`,
    };
  }
  if (!semverAtLeast(installed, expected)) {
    return {
      id: "stale_install",
      status: "fail",
      registryProbed: true,
      detail: `stale_install: OpenCode @latest cache has workit-opencode ${installed} behind published ${expected}`,
      fix: `Remove ${res.opencodePackageCacheDir} and restart OpenCode — it re-resolves @latest on the next launch`,
    };
  }
  return {
    id: "stale_install",
    status: "pass",
    registryProbed: true,
    detail: `OpenCode @latest cache workit-opencode ${installed} matches published ${expected}`,
  };
};

const checkStaleInstall = (res: Resolved): DoctorCheck & { registryProbed?: boolean } => {
  if (res.host === "opencode") {
    return checkOpenCodePackageCache(res);
  }
  if (res.host !== "cursor" && res.host !== "cli") {
    return {
      id: "stale_install",
      status: "pass",
      detail: "cursor plugin not inspected on this host",
    };
  }
  // Symlink installs into pnpm dlx / _npx caches break when the cache is cleared.
  // MCP launchers may still be canonical; the plugin dir itself must be real.
  if (existsSync(res.cursorPluginDir) && lstatSync(res.cursorPluginDir).isSymbolicLink()) {
    let target = "";
    try {
      target = readlinkSync(res.cursorPluginDir);
    } catch {
      target = "(unreadable)";
    }
    const fragile = isEphemeralCachePath(target);
    return {
      id: "stale_install",
      status: "fail",
      detail: fragile
        ? `stale_install: cursor plugin dir is a symlink into a package-manager cache (${target})`
        : `stale_install: cursor plugin dir is a symlink (${target}) — expected a real directory copy`,
      fix: "Run `workit init` and select Cursor — install must copy into ~/.cursor/plugins/local/workit",
    };
  }
  const canonicalMcp = cursorMcpServerEntry("").args.find((a) => a.startsWith("--package="));
  const mcpSelectors = pluginMcpSelectors(res);
  const legacyPin = (mcpSelectors ?? []).find(
    (s) => s !== canonicalMcp && s.includes("@brainervirus/workit-cursor@"),
  );
  if (legacyPin) {
    return {
      id: "stale_install",
      status: "fail",
      detail: `stale_install: plugin mcp.json pins a legacy selector ${legacyPin} (canonical: ${canonicalMcp})`,
      fix: "Re-run install-cursor-plugin.sh — it rewrites the workit MCP entry to the canonical @latest selector",
    };
  }
  const hooksFile = path.join(res.cursorPluginDir, "hooks", "hooks-cursor.json");
  const hookCmd =
    (readJson(hooksFile)?.hooks?.sessionStart?.[0]?.command as string | undefined) ?? null;
  const canonicalHook = canonicalCursorHook;
  const staleHook =
    hookCmd !== null &&
    !isCanonicalCursorHook(hookCmd, res) &&
    !hookCmd.startsWith("node ") &&
    hookCmd.includes("@brainervirus/workit-cursor@");
  if (staleHook) {
    return {
      id: "stale_install",
      status: "fail",
      detail: `stale_install: sessionStart hook runs a legacy selector (canonical: ${canonicalHook})`,
      fix: "Re-run install-cursor-plugin.sh — it rewrites the sessionStart hook to the canonical pinned launcher",
    };
  }
  // Enforcement-event drift: a present-but-divergent preToolUse matcher (or
  // beforeShellExecution command) silently narrows what the hook intercepts.
  // Absent events are filled by the installer merge, so only divergence fails.
  const hookDrift = existsSync(hooksFile)
    ? cursorHookDrift(readJson(hooksFile), res.cursorPluginDir)
    : [];
  if (hookDrift.length > 0) {
    return {
      id: "stale_install",
      status: "fail",
      detail: `stale_install: cursor hook drift on ${hookDrift.join(", ")} (differs from the canonical hook entries)`,
      fix: "Re-run install-cursor-plugin.sh — it rewrites the workit hook entries to canonical",
    };
  }
  const installed = installedPluginVersion(res);
  const source = res.dev
    ? ((readJson(path.join(res.dev, "packages/workit-cursor/package.json"))?.version as
        | string
        | undefined) ?? null)
    : ((readJson(path.join(packageRoot(), "package.json"))?.version as string | undefined) ?? null);
  // A local-dist install (node entry) runs the installed dir's own dist, so its
  // version is comparable against the current runtime (and the published one
  // below). Canonical @latest installs resolve fresh at launch — the installed
  // package.json version is metadata, not a freshness signal (CA-04), so they
  // skip both version comparisons and never fail stale_install on metadata.
  const localDist =
    mcpSelectors === null &&
    hookCmd !== null &&
    !isCanonicalCursorHook(hookCmd, res) &&
    hookCmd.startsWith("node ");
  if (localDist && installed !== null && source !== null && !semverAtLeast(installed, source)) {
    return {
      id: "stale_install",
      status: "fail",
      detail: `stale_install: installed workit-cursor ${installed} is behind the current runtime ${source}`,
      fix: "Re-run install-cursor-plugin.sh — it refreshes the plugin directory and rewrites the workit MCP/hook entries",
    };
  }
  // Same version, different bytes: the install was hand-edited or built from
  // a dirty tree. Version strings cannot see that; the bundle hash can. The
  // dev dist is byte-deterministic, so a mismatch heals with reinstall.
  if (localDist && installed !== null && source !== null && res.dev) {
    const entry = /^node\s+(.+)$/.exec((hookCmd ?? "").trim())?.[1]?.trim() ?? "";
    const sourceBundle =
      entry && path.isAbsolute(entry)
        ? path.join(res.dev, "packages", "workit-cursor", "dist", path.basename(entry))
        : "";
    if (entry && sourceBundle) {
      const installedHash = bundleHashOfFile(entry);
      const sourceHash = bundleHashOfFile(sourceBundle);
      if (installedHash !== null && sourceHash !== null && installedHash !== sourceHash) {
        return {
          id: "stale_install",
          status: "fail",
          detail: `stale_install: installed workit-cursor ${installed} runs different bytes than the current runtime build (${path.basename(entry)} hash mismatch)`,
          fix: "Re-run install-cursor-plugin.sh — it refreshes the plugin directory with the current build",
        };
      }
    }
  }
  if (installed !== null && localDist) {
    const expected = registryLatestVersion(res);
    if (expected === null) {
      return {
        id: "registry_unreachable",
        status: "warn",
        registryProbed: true,
        detail:
          "registry_unreachable: cannot compare installed workit-cursor against the published runtime",
        fix: "Retry when the npm registry is reachable, or re-run install-cursor-plugin.sh to refresh the install",
      };
    }
    if (!semverAtLeast(installed, expected)) {
      // The probe SUCCEEDED and the installed version is genuinely behind the
      // published runtime: report a hard fail so `doctor-check.ts cursor --stale`
      // exits 2 and the installer self-heals the local-dist install.
      return {
        id: "stale_install",
        status: "fail",
        registryProbed: true,
        detail: `stale_install: local-dist workit-cursor ${installed} is behind the published runtime ${expected}`,
        fix: "Re-run install-cursor-plugin.sh — it refreshes the plugin directory with the current build",
      };
    }
    const cursorOk = {
      id: "stale_install" as const,
      status: "pass" as const,
      registryProbed: true,
      detail: `installed local-dist workit-cursor ${installed} matches the published runtime ${expected}`,
    };
    if (res.host === "cli") {
      const oc = checkOpenCodePackageCache(res);
      if (oc.status !== "pass") return oc;
    }
    return cursorOk;
  }
  const cursorOk = {
    id: "stale_install" as const,
    status: "pass" as const,
    detail:
      installed === null
        ? "installed workit-cursor selectors are canonical"
        : `installed workit-cursor ${installed} on canonical selectors (hooks run this version through the pinned launcher; MCP resolves @latest at launch)`,
  };
  if (res.host === "cli") {
    const oc = checkOpenCodePackageCache(res);
    if (oc.status !== "pass") return oc;
  }
  return cursorOk;
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
    return {
      id: "duplicate_registration",
      status: "pass",
      detail: "no duplicate registrations",
    };
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
    return {
      id: "malformed_config",
      status: "pass",
      detail: "config files parse",
    };
  return {
    id: "malformed_config",
    status: "fail",
    detail: `malformed config: ${bad.join(", ")}`,
    fix: `Repair the malformed config in ${bad[0]}`,
  };
};

/** The effective branch preset, marked when the repository's branches chose it. */
const branchPresetLine = (res: Resolved, workspace: WorkspaceConfig | null): string[] => {
  try {
    const resolved = resolveWorkspacePolicy(
      readConfigFromDir(res.configDir),
      workspace,
      undefined,
      () => repoBranchPreset(res.cwd),
    );
    if (resolved.status === "invalid") return [];
    const { preset, detected } = resolved.branchPolicy;
    return [`preset: ${detected ? `detected (${preset})` : preset}`];
  } catch {
    return [];
  }
};

const checkWorkspaceMismatch = (res: Resolved): DoctorCheck => {
  const result = readWorkspacesResult(res.configDir);
  const file = result.path;
  if (result.status === "missing" || (result.status === "valid" && result.entries.length === 0))
    return {
      id: "workspace_mismatch",
      status: "pass",
      detail: ["no workspaces configured", ...branchPresetLine(res, null)].join("; "),
    };
  if (result.status === "malformed" || result.status === "invalid")
    return {
      id: "workspace_mismatch",
      status: "fail",
      detail: result.error ?? `${file} has invalid workspace configuration`,
      fix: `Repair workspace configuration in ${file}`,
    };
  let match;
  try {
    match = resolveWorkspaceFrom(
      res.cwd,
      res.configDir,
      res.env.WORKFLOW_WORKSPACE_NAME?.trim() || undefined,
    );
  } catch (error) {
    return {
      id: "workspace_mismatch",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix: `Choose a matching workspace with WORKFLOW_WORKSPACE_NAME or repair ${file}`,
    };
  }
  if (match) {
    const matched = `current directory matches workspace "${match.name}"`;
    // Release tracks: the configured lines and the one this checkout resolves
    // to. Reader issues or an undetermined track warn; a critical field fails.
    const tracks = releaseTracksReport(res.cwd);
    const lines = describeReleaseTracks(tracks);
    const detail = [matched, ...branchPresetLine(res, match), ...lines].join("; ");
    if (tracks.error)
      return {
        id: "workspace_mismatch",
        status: "fail",
        detail,
        fix: `Repair releaseTracks in ${file} (or upgrade Workit for a critical field)`,
      };
    if (tracks.warnings.length)
      return {
        id: "workspace_mismatch",
        status: "warn",
        detail,
        fix: `Fix the reported releaseTracks fields in ${file}, or pass --track <name> where the track is not determined`,
      };
    return { id: "workspace_mismatch", status: "pass", detail };
  }
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

  if (tokenPaths.length === 0) {
    return {
      id: "credential_metadata",
      status: "pass",
      detail: "no credentials configured",
    };
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

// Provider CLI and SSH identities are public usernames; Workit never reads a VCS token file.
export type IdentitySurface = { surface: string; login: string | null };

export type IdentityProbes = {
  origin: (cwd: string) => string | null;
  ghLogin: (env: NodeJS.ProcessEnv) => string | null;
  glabLogin?: (env: NodeJS.ProcessEnv) => string | null;
  sshLogin: (host: string) => string | null;
};

export const githubHostFromRemote = (remote: string): string | null => {
  const rest = (remote || "").trim();
  if (!rest) return null;
  const scp = /^[^@/]+@([^:]+):/.exec(rest);
  if (scp) return scp[1].toLowerCase();
  try {
    const url = new URL(rest.includes("://") ? rest : `https://${rest}`);
    return url.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
};

const identityProvider = (
  host: string,
  config: Record<string, any> | null,
  workspaceProvider?: unknown,
): "github" | "gitlab" | null =>
  workspaceProvider === "github" || workspaceProvider === "gitlab"
    ? workspaceProvider
    : host === "github.com"
      ? "github"
      : host === "gitlab.com"
        ? "gitlab"
        : config?.provider === "github" || config?.provider === "gitlab"
          ? config.provider
          : config?.github
            ? "github"
            : config?.gitlab
              ? "gitlab"
              : null;

const providerIdentityFinding = (
  provider: "github" | "gitlab",
  surfaces: IdentitySurface[],
): DoctorCheck => {
  const id: "github_identity" | "gitlab_identity" = `${provider}_identity`;
  const label = provider === "github" ? "GitHub" : "GitLab";
  const resolved = surfaces.filter(
    (entry): entry is { surface: string; login: string } => typeof entry.login === "string",
  );
  const distinct = [...new Set(resolved.map((entry) => entry.login.toLowerCase()))];
  if (distinct.length < 2) {
    return {
      id,
      status: "pass",
      detail:
        resolved.length === 0
          ? `no ${label} identities configured`
          : `single ${label} identity across configured surfaces`,
    };
  }
  return {
    id,
    status: "warn",
    detail: `${label} identities disagree across configured surfaces: ${resolved
      .map((entry) => `${entry.surface} reports "${entry.login}"`)
      .join("; ")}. Operations may land under the wrong account.`,
    fix:
      provider === "github"
        ? "Align the effective gh account and SSH identity via gh auth switch/login and your Git configuration"
        : "Align the effective glab account and SSH identity via glab auth login and your Git configuration",
  };
};

export const githubIdentityFinding = (surfaces: IdentitySurface[]): DoctorCheck =>
  providerIdentityFinding("github", surfaces);

export const gitlabIdentityFinding = (surfaces: IdentitySurface[]): DoctorCheck =>
  providerIdentityFinding("gitlab", surfaces);

const workspaceProviderForIdentity = (
  cwd: string,
  configDir: string,
  env: NodeJS.ProcessEnv,
): { provider?: unknown; error?: string } => {
  try {
    return {
      provider: resolveWorkspaceFrom(
        cwd,
        configDir,
        env.WORKFLOW_WORKSPACE_NAME?.trim() || undefined,
      )?.vcs?.provider,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

const defaultIdentityProbes = (env: NodeJS.ProcessEnv): IdentityProbes => ({
  origin: (cwd) => {
    try {
      const out = spawnSync("git", ["remote", "get-url", "origin"], {
        cwd,
        encoding: "utf8",
        env,
      });
      return out.status === 0 ? (out.stdout ?? "").trim() || null : null;
    } catch {
      return null;
    }
  },
  ghLogin: (e) => {
    try {
      const out = spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", env: e });
      const login = (out.stdout ?? "").trim();
      return out.status === 0 && login ? login : null;
    } catch {
      return null;
    }
  },
  glabLogin: (e) => {
    try {
      const out = spawnSync("glab", ["api", "user", "--jq", ".username"], {
        encoding: "utf8",
        env: e,
      });
      const login = (out.stdout ?? "").trim();
      return out.status === 0 && login ? login : null;
    } catch {
      return null;
    }
  },
  sshLogin: (host) => {
    try {
      const out = spawnSync(
        "ssh",
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-T", `git@${host}`],
        {
          encoding: "utf8",
          env,
        },
      );
      const text = `${out.stdout ?? ""}${out.stderr ?? ""}`;
      const match = /^(?:Hi |Welcome to GitLab, @)([^!]+)!/m.exec(text);
      return match ? match[1].trim() || null : null;
    } catch {
      return null;
    }
  },
});

export const checkGithubIdentity = (
  res: Pick<Resolved, "cwd" | "configDir" | "env">,
  probes: IdentityProbes = defaultIdentityProbes(res.env),
): DoctorCheck => {
  const remoteHost = githubHostFromRemote(probes.origin(res.cwd) ?? "");
  if (!remoteHost)
    return { id: "github_identity", status: "pass", detail: "no GitHub remote configured" };
  const vcsJson = readJson(res.env.WORKFLOW_VCS_CONFIG ?? path.join(res.configDir, "vcs.json"));
  const workspace = workspaceProviderForIdentity(res.cwd, res.configDir, res.env);
  if (workspace.error)
    return {
      id: "github_identity",
      status: "fail",
      detail: workspace.error,
      fix: "Repair workspace configuration or choose a matching workspace",
    };
  const provider = identityProvider(remoteHost, vcsJson, workspace.provider);
  if (provider !== "github")
    return { id: "github_identity", status: "pass", detail: "no GitHub remote configured" };
  const cliHost = String(vcsJson?.github?.host ?? "github.com").toLowerCase();
  const cliLogin = probes.ghLogin({ ...res.env, GH_HOST: cliHost });
  if (!cliLogin)
    return {
      id: "github_identity",
      status: "fail",
      detail: "gh CLI is not authenticated",
      fix: "Run gh auth login",
    };
  const surfaces: IdentitySurface[] = [{ surface: "gh CLI", login: cliLogin }];
  surfaces.push({ surface: "SSH", login: probes.sshLogin(remoteHost) });
  return githubIdentityFinding(surfaces);
};

export const checkGitLabIdentity = (
  res: Pick<Resolved, "cwd" | "configDir" | "env">,
  probes: IdentityProbes = defaultIdentityProbes(res.env),
): DoctorCheck => {
  const remoteHost = githubHostFromRemote(probes.origin(res.cwd) ?? "");
  if (!remoteHost)
    return { id: "gitlab_identity", status: "pass", detail: "no GitLab remote configured" };
  const vcsJson = readJson(res.env.WORKFLOW_VCS_CONFIG ?? path.join(res.configDir, "vcs.json"));
  const workspace = workspaceProviderForIdentity(res.cwd, res.configDir, res.env);
  if (workspace.error)
    return {
      id: "gitlab_identity",
      status: "fail",
      detail: workspace.error,
      fix: "Repair workspace configuration or choose a matching workspace",
    };
  const provider = identityProvider(remoteHost, vcsJson, workspace.provider);
  if (provider !== "gitlab")
    return { id: "gitlab_identity", status: "pass", detail: "no GitLab remote configured" };
  const cliHost = String(vcsJson?.gitlab?.host ?? "gitlab.com").toLowerCase();
  const cliLogin = probes.glabLogin?.({ ...res.env, GITLAB_HOST: cliHost }) ?? null;
  if (!cliLogin)
    return {
      id: "gitlab_identity",
      status: "fail",
      detail: "glab CLI is not authenticated",
      fix: "Run glab auth login",
    };
  return gitlabIdentityFinding([
    { surface: "glab CLI", login: cliLogin },
    { surface: "SSH", login: probes.sshLogin(remoteHost) },
  ]);
};

const checkLogWritable = (res: Resolved): DoctorCheck => {
  const logsDir = path.join(res.stateDir, "logs");
  // Fixed-name probe: even a killed process leaves at most one bounded file that
  // the next run overwrites; the finally removes it on any thrown path.
  const probe = path.join(logsDir, "doctor-probe.tmp");
  try {
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    writeFileSync(probe, '{"probe":true}\n', { mode: 0o600 });
    return {
      id: "log_writable",
      status: "pass",
      detail: "log directory writable",
    };
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

// The checkout's `.workit/metadata.lock`. Writes reclaim a stale lock by
// themselves, so a stale lock is a warning with an explicit cleanup command.
const BLOCKING_LOCK_WARN_MS = 30_000;
const checkWorkspaceLock = (res: Resolved): DoctorCheck => {
  const lock = inspectMetadataLock(res.workspaceRoot);
  const fix = "workit doctor --fix-lock";
  if (lock.guard === "abandoned")
    return {
      id: "workspace_lock",
      status: "warn",
      detail: `abandoned lock reclaim guard at ${lock.path}.reclaim`,
      fix,
    };
  if (lock.state === "absent")
    return { id: "workspace_lock", status: "pass", detail: "no metadata lock held" };
  if (lock.state === "stale")
    return {
      id: "workspace_lock",
      status: "warn",
      detail: `stale metadata lock at ${lock.path}: ${lock.reason}`,
      fix,
    };
  // An unverifiable owner (other host, pid namespace, or an older Workit's
  // lock) that has blocked writes this long needs an explicit decision.
  if (lock.state === "unknown" && (lock.ageMs ?? 0) > BLOCKING_LOCK_WARN_MS)
    return {
      id: "workspace_lock",
      status: "warn",
      detail: `metadata lock at ${lock.path} has blocked writes for ${Math.round((lock.ageMs ?? 0) / 1000)}s and its owner cannot be verified: ${lock.reason}`,
      fix: "workit doctor --fix-lock --force --yes",
    };
  return {
    id: "workspace_lock",
    status: "pass",
    detail: `metadata lock ${lock.reason} (writes retry, then report busy)`,
  };
};

const CLAUDE_PLUGIN_PACKAGE = "@brainervirus/workit-claude-code";

const versionBehind = (version: string, latest: string): boolean =>
  version !== latest && semverAtLeast(latest, version);

/**
 * Claude Code installs the marketplace plugin as a snapshot of the published
 * package (auto-update is off by default), so an install can lag the release.
 * It warns only when a newer plugin version is actually published: a plugin
 * older than this CLI is normal when no plugin payload changed since (the
 * plugin is republished only when its own or its bundled sources change).
 * The plugin keeps working; the fix is one native update. A `--plugin-dir`
 * local pin is per-session, never recorded, and never checked here.
 */
const checkClaudePlugin = (res: Resolved): DoctorCheck & { registryProbed?: boolean } => {
  // Only installs Claude loads here: user scope, plus this project's.
  const installs = claudeWorkitInstalls(res.home, res.env, res.cwd);
  if (installs.length === 0)
    return {
      id: "claude_plugin",
      status: "pass",
      detail: "no Workit Claude Code plugin install recorded — skipping",
    };
  const fix = (install: ClaudeWorkitInstall) =>
    `claude plugin marketplace update ${CLAUDE_MARKETPLACE_NAME} && ${
      install.projectPath ? `cd ${JSON.stringify(install.projectPath)} && ` : ""
    }claude plugin update ${install.id}${install.scope === "user" ? "" : ` --scope ${install.scope}`}`;
  const latest = registryLatestVersion(res, CLAUDE_PLUGIN_PACKAGE);
  const problems: string[] = [];
  let repair: string | undefined;
  for (const install of installs) {
    const label = `${install.id} ${install.version ?? "(unknown version)"}${install.scope === "user" ? "" : ` (${install.scope} scope)`}`;
    if (latest && install.version && versionBehind(install.version, latest)) {
      problems.push(`stale_install: ${label} is behind published ${latest}`);
      repair ??= fix(install);
    }
  }
  const registryProbed = latest !== null && !res.env.WORKIT_DOCTOR_STALE_REGISTRY_VERSION;
  if (problems.length === 0)
    return {
      id: "claude_plugin",
      status: "pass",
      detail: `Claude Code plugin ${installs.map((i) => `${i.id} ${i.version ?? "?"}`).join(", ")} is current`,
      registryProbed,
    };
  return {
    id: "claude_plugin",
    status: "warn",
    detail: problems.join("; "),
    fix: repair,
    registryProbed,
  };
};

const CLI_PACKAGE = "@brainervirus/workit-cli";
const SEMVER = /\d+\.\d+\.\d+/;

// One probe per binary identity per process: a long-lived caller re-running
// the doctor does not respawn an unchanged binary, and a replaced one re-probes.
const WORKIT_PROBE_TIMEOUT_MS = 10_000;
type WorkitProbe = { version: string | null; timedOut: boolean };
const workitVersions = new Map<string, WorkitProbe>();
const workitVersionAt = (bin: string, env: NodeJS.ProcessEnv): WorkitProbe => {
  let key: string;
  try {
    const st = statSync(bin);
    key = `${bin}:${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return { version: null, timedOut: false };
  }
  const cached = workitVersions.get(key);
  if (cached) return cached;
  // win32 refuses to spawn a .cmd/.bat without a shell (CVE-2024-27980).
  const viaShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(bin);
  const r = viaShell
    ? spawnSync(`"${bin}" --version`, {
        encoding: "utf8",
        env,
        timeout: WORKIT_PROBE_TIMEOUT_MS,
        shell: true,
      })
    : spawnSync(bin, ["--version"], { encoding: "utf8", env, timeout: WORKIT_PROBE_TIMEOUT_MS });
  const timedOut = r.error !== undefined && "code" in r.error && r.error.code === "ETIMEDOUT";
  const version = r.status === 0 ? ((r.stdout ?? "").match(SEMVER)?.[0] ?? null) : null;
  const probe = { version: timedOut ? null : version, timedOut };
  workitVersions.set(key, probe);
  return probe;
};

/**
 * Agents and hooks shell out to `workit`, so the binary on PATH must run, and
 * should not be older than the host plugins that call it. Advisory only: a
 * missing or older CLI warns with the install command and never changes the
 * exit code. Plugins republish only when their payload changes, so a CLI newer
 * than a plugin is normal and passes.
 */
const checkWorkitOnPath = (res: Resolved): DoctorCheck => {
  const plugins = [
    ...claudeWorkitInstalls(res.home, res.env, res.cwd).map((i) => ({
      label: `Claude Code plugin ${i.id}`,
      version: i.version,
    })),
    { label: "Cursor plugin", version: installedPluginVersion(res) },
    { label: "OpenCode plugin", version: installedOpenCodeCacheVersion(res) },
  ].filter((p): p is { label: string; version: string } => p.version !== null);
  const newest = plugins.reduce<{ label: string; version: string } | null>(
    (best, p) => (best && semverAtLeast(best.version, p.version) ? best : p),
    null,
  );
  const target = newest?.version ?? "latest";
  const fix = `npm i -g ${CLI_PACKAGE}@${target} (or run it without a global install: npx -y ${CLI_PACKAGE}@${target} <command>)`;
  const bin = findOnPath(pathextNames("workit", res.env), res.env);
  if (!bin) {
    return { id: "workit_on_path", status: "warn", detail: "no workit on PATH", fix };
  }
  const { version, timedOut } = workitVersionAt(bin, res.env);
  if (!version) {
    return {
      id: "workit_on_path",
      status: "warn",
      detail: timedOut
        ? `${bin} does not run (\`workit --version\` timed out after ${WORKIT_PROBE_TIMEOUT_MS / 1000}s)`
        : `${bin} does not run (\`workit --version\` failed)`,
      fix,
    };
  }
  if (newest && versionBehind(version, newest.version)) {
    return {
      id: "workit_on_path",
      status: "warn",
      detail: `workit ${version} at ${bin} is older than the ${newest.label} ${newest.version}`,
      fix,
    };
  }
  return {
    id: "workit_on_path",
    status: "pass",
    detail: `workit ${version} at ${bin}${newest ? ` (newest host plugin ${newest.version})` : ""}`,
  };
};

const RUN_CHECKS: Array<(res: Resolved) => DoctorCheck> = [
  checkRuntime,
  checkVersions,
  checkCodexPin,
  checkCodexHooks,
  checkCodexAgents,
  checkPiExtension,
  checkOpencodeVersion,
  checkClaudePlugin,
  checkWorkitOnPath,
  checkAssets,
  checkLauncher,
  checkCursorHook,
  checkUtility,
  checkStalePin,
  checkStaleInstall,
  checkDuplicateRegistration,
  checkMalformedConfig,
  checkWorkspaceMismatch,
  checkWorkspaceLock,
  checkCredentialMetadata,
  checkGithubIdentity,
  checkGitLabIdentity,
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
  "stale_install",
  "duplicate_registration",
  "malformed_config",
]);

export const runDoctor = (options: DoctorOptions = {}): DoctorReport => {
  const res = resolve(options);
  const raw = RUN_CHECKS.map((fn) => fn(res));
  const checks = res.installer
    ? raw.map((c) =>
        c.status === "fail" && !INSTALLER_REQUIRED.has(c.id)
          ? {
              ...c,
              status: "warn" as const,
              detail: `${c.detail} (not enforced by installer)`,
            }
          : c,
      )
    : raw;

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const passed = checks.filter((c) => c.status === "pass").length;
  const exitCode = failed > 0 ? 1 : 0;
  const offline = !raw.some((c) => "registryProbed" in c && c.registryProbed);
  const report: DoctorReport = {
    ok: failed === 0,
    exitCode,
    offline,
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
    offline,
    failed: checks.filter((c) => c.status === "fail").map((c) => c.id),
    total: checks.length,
  });

  return report;
};
