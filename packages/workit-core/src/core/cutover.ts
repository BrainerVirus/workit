import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  unlinkSync,
  constants as fsConstants,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { failure, success, type Digest, type Id, type Result } from "./task-contract";
import {
  applyConversionConfig,
  previewConversion,
  type ConversionPreview,
} from "./config-conversion";
import {
  CURSOR_RUNTIME_PACKAGE,
  cursorHooksEntry,
  cursorMcpServerEntry,
  isWorkitPlugin,
  mergeCursorMcp,
  mergeCursorSettings,
  mergeOpenCodeConfig,
} from "./registration";
import { WORKIT_METHOD_SKILLS, WORKIT_SKILL_ALIASES } from "./skill-manifests";
import { writeFileAtomic, writeFileExclusive } from "./safe-write";
import { LEGACY_CURSOR_ASSET_DIGESTS } from "./legacy-ownership";

export type CutoverHost = "opencode" | "cursor" | "codex" | "pi";

export type SessionObservation = {
  host: CutoverHost | "opencode" | "cursor";
  handle: string;
  state: "stopped" | "active" | "unknown";
};

export type CutoverInventoryEntry = {
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  category:
    | "configuration"
    | "recovery"
    | "project-state"
    | "project-history"
    | "host-configuration"
    | "integration";
  disposition: "preserve" | "convert" | "unknown";
  bytes: number;
  digest: Digest | null;
  ownershipEvidence: string | null;
};

export type CutoverInventory = {
  complete: boolean;
  entries: CutoverInventoryEntry[];
  files: number;
  bytes: number;
  bytesByCategory: Partial<Record<CutoverInventoryEntry["category"], number>>;
  issues: string[];
  revision: Digest;
};

export type CutoverPlan = {
  id: Id;
  archiveDir: string | null;
  managedFiles: { path: string; beforeDigest: Digest | null; afterDigest: Digest }[];
  inventory: CutoverInventory;
  sessions: SessionObservation[];
  unresolved: { key: string; reason: string }[];
  conversion: ConversionPreview;
  hosts: CutoverHost[];
  blocked: string[];
};

export type CutoverReceipt = {
  backupId: Id;
  archiveDir: string;
  planId: Id;
  generation: "legacy" | "v1";
  hosts: CutoverHost[];
  managedFiles: { path: string; installedDigest: Digest }[];
  partial: boolean;
  notes: string[];
};

type CutoverJournal = {
  schemaVersion: 1;
  backupId: Id;
  archiveDir: string;
  planId: Id;
  hosts: CutoverHost[];
  resolutions: Record<string, string>;
  conversionNeeded: boolean;
  phase: "applying" | "interrupted" | "partial" | "complete";
  completedSteps: string[];
  appliedHosts: CutoverHost[];
  currentStep: string | null;
  error: string | null;
  startedAt: string;
  notes: string[];
};

export type CutoverDecision = {
  approve: true;
  hosts: CutoverHost[];
  resolutions?: Record<string, string>;
};

export type RollbackPreview = {
  backupId: Id;
  restorable: {
    path: string;
    currentDigest: Digest;
    installedDigest: Digest;
    restore: "backup" | "remove";
  }[];
  conflicts: { path: string; currentDigest: Digest | null; installedDigest: Digest }[];
  preserved: string[];
  issues: string[];
};

export type CutoverPaths = {
  home?: string;
  configDir?: string;
  stateDir?: string;
  archiveDir?: string;
  dev?: string | null;
  workspace?: string;
  opencodeConfig?: string;
  cursorSettings?: string;
  cursorMcp?: string;
  cursorPluginDir?: string;
  piConfig?: string;
  piSettings?: string;
  sessions?: SessionObservation[];
  env?: NodeJS.ProcessEnv;
};

export type GenerationState = {
  target: "legacy" | "v1";
  cutover?: { backupId: Id; planId: Id; at: string };
};

const GENERATION_FILE = "generation.json";
const CUTOVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const validCutoverId = (value: string): boolean => CUTOVER_ID.test(value);

const resolvePaths = (options: CutoverPaths = {}) => {
  const home = options.home ?? options.env?.HOME ?? os.homedir();
  const configDir =
    options.configDir ??
    options.env?.WORKFLOW_TOOLKIT_CONFIG ??
    path.join(home, ".config", "workit");
  const stateDir =
    options.stateDir ??
    options.env?.WORKFLOW_TOOLKIT_STATE ??
    path.join(home, ".local", "state", "workit");
  const piAgentDir = options.env?.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent");
  return {
    home,
    configDir,
    stateDir,
    dev: options.dev ?? options.env?.WORKFLOW_TOOLKIT_DEV ?? null,
    workspace: options.workspace ?? process.cwd(),
    opencodeConfig:
      options.opencodeConfig ?? path.join(home, ".config", "opencode", "opencode.json"),
    cursorSettings: options.cursorSettings ?? path.join(home, ".cursor", "settings.json"),
    cursorMcp: options.cursorMcp ?? path.join(home, ".cursor", "mcp.json"),
    cursorPluginDir:
      options.cursorPluginDir ?? path.join(home, ".cursor", "plugins", "local", "workit"),
    piConfig: options.piConfig ?? path.join(home, ".pi", "config.json"),
    piSettings: options.piSettings ?? path.join(piAgentDir, "settings.json"),
    sessions: options.sessions ?? [],
  };
};

const MAX_CUTOVER_INVENTORY_ENTRIES = 50_000;
const MAX_CUTOVER_INVENTORY_DEPTH = 64;

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const lstatOrNull = (file: string) => {
  try {
    return lstatSync(file);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
};

const noSymlinkAncestor = (file: string): boolean => {
  let current = path.resolve(file);
  for (;;) {
    const stat = lstatOrNull(current);
    if (stat?.isSymbolicLink()) return false;
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
};

const readDirNamesBounded = (
  dir: string,
  limit: number,
): { names: string[]; truncated: boolean } => {
  const handle = opendirSync(dir);
  const names: string[] = [];
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry) return { names: names.toSorted(), truncated: false };
      if (names.length === limit) return { names: names.toSorted(), truncated: true };
      names.push(entry.name);
    }
  } finally {
    handle.closeSync();
  }
};

export const digestFile = (file: string): Digest | null => {
  if (!noSymlinkAncestor(path.dirname(file))) return null;
  const stat = lstatOrNull(file);
  if (!stat?.isFile() || stat.isSymbolicLink()) return null;
  let fd: number | undefined;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, offset);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
      offset += read;
    }
    return hash.digest("hex");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

export const readGenerationState = (configDir: string): GenerationState => {
  const file = path.join(configDir, GENERATION_FILE);
  if (!existsSync(file)) return { target: "legacy" };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed?.target === "v1") return parsed as GenerationState;
  } catch {
    /* keep legacy default */
  }
  return { target: "legacy" };
};

export const writeGenerationState = (configDir: string, state: GenerationState): void => {
  writeFileAtomic(path.join(configDir, GENERATION_FILE), JSON.stringify(state, null, 2) + "\n");
};

const listSkillNames = (root: string): string[] => {
  const dir = path.join(root, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
};

export type HostGeneration = "legacy" | "v1" | "none" | "mixed";

export const classifyHostGeneration = (
  host: CutoverHost,
  paths: ReturnType<typeof resolvePaths>,
): HostGeneration => {
  if (host === "cursor") {
    const skills = listSkillNames(paths.cursorPluginDir);
    const legacy =
      skills.some((s) => s.startsWith("wk-")) ||
      existsSync(path.join(paths.cursorPluginDir, "vendor", "superpowers"));
    const v1 = WORKIT_METHOD_SKILLS.every((s) => skills.includes(s));
    if (legacy && v1) return "mixed";
    if (v1) return "v1";
    if (legacy) return "legacy";
    return "none";
  }
  if (host === "opencode") {
    if (!existsSync(paths.opencodeConfig)) return "none";
    try {
      const cfg = JSON.parse(readFileSync(paths.opencodeConfig, "utf8"));
      const plugins = Array.isArray(cfg.plugin) ? cfg.plugin : cfg.plugin ? [cfg.plugin] : [];
      const workitPins = plugins.filter((p: unknown) => isWorkitPlugin(p));
      const canonicalV1Pin = `file://${paths.dev}/packages/workit-opencode/dist/plugin.js`;
      const v1 = workitPins.some((p: unknown) => String(p) === canonicalV1Pin);
      const legacy = workitPins.some((p: unknown) => String(p) !== canonicalV1Pin);
      if (legacy && v1) return "mixed";
      if (v1) return "v1";
      if (legacy) return "legacy";
      return "none";
    } catch {
      return "none";
    }
  }
  if (host === "codex") {
    const codexDir = path.join(paths.home, ".codex");
    const plugin = path.join(codexDir, "plugins", "workit");
    if (!existsSync(plugin)) return "none";
    return existsSync(path.join(plugin, ".codex-plugin")) ? "v1" : "legacy";
  }
  if (host === "pi") {
    const extension = paths.dev && path.resolve(paths.dev, "packages/workit-pi/dist/workit.js");
    const packageDir = paths.dev && path.resolve(paths.dev, "packages/workit-pi");
    if (!existsSync(paths.piConfig) && !existsSync(paths.piSettings)) return "none";
    try {
      const config = existsSync(paths.piConfig)
        ? JSON.parse(readFileSync(paths.piConfig, "utf8"))
        : {};
      const settings = existsSync(paths.piSettings)
        ? JSON.parse(readFileSync(paths.piSettings, "utf8"))
        : {};
      const ext = config?.extensions ?? config?.pi?.extensions ?? [];
      const packages = settings?.packages ?? [];
      const has =
        (typeof extension === "string" &&
          Array.isArray(ext) &&
          ext.some(
            (entry: unknown) => typeof entry === "string" && path.resolve(entry) === extension,
          )) ||
        (typeof packageDir === "string" &&
          Array.isArray(packages) &&
          packages.some(
            (entry: unknown) => typeof entry === "string" && path.resolve(entry) === packageDir,
          ));
      return has ? "v1" : "none";
    } catch {
      return "none";
    }
  }
  return "none";
};

export const detectSourceLinkedOpenCode = (opencodeConfig: string): boolean => {
  if (!existsSync(opencodeConfig)) return false;
  try {
    const cfg = JSON.parse(readFileSync(opencodeConfig, "utf8"));
    const plugins = Array.isArray(cfg.plugin) ? cfg.plugin : cfg.plugin ? [cfg.plugin] : [];
    return plugins.some((p: unknown) => {
      const s = String(p);
      return s.startsWith("file://") && s.includes("/packages/workit-opencode/");
    });
  } catch {
    return false;
  }
};

export const detectCursorLatest = (cursorMcp: string): boolean => {
  if (!existsSync(cursorMcp)) return false;
  try {
    const cfg = JSON.parse(readFileSync(cursorMcp, "utf8"));
    const server = cfg?.mcpServers?.workit;
    if (!server || server.command !== "npx" || !Array.isArray(server.args)) return false;
    return (
      server.args[0] === "-y" &&
      server.args[1] === "--prefer-online" &&
      server.args[2] === "--min-release-age=0" &&
      server.args[3] === `--package=${CURSOR_RUNTIME_PACKAGE}` &&
      server.args[4] === "workit-cursor-mcp"
    );
  } catch {
    return false;
  }
};

const legacyFlowFiles = (workspace: string): string[] => {
  const docs = path.join(workspace, "docs");
  if (!existsSync(docs)) return [];
  const out: string[] = [];
  for (const slug of readdirSync(docs)) {
    const file = path.join(docs, slug, "sdd", "flow.json");
    if (existsSync(file)) out.push(file);
  }
  return out;
};

const managedCutoverFiles = (paths: ReturnType<typeof resolvePaths>): string[] => [
  path.join(paths.configDir, "config.json"),
  path.join(paths.configDir, "youtrack.json"),
  path.join(paths.configDir, "vcs.json"),
  path.join(paths.configDir, "workspaces.json"),
  path.join(paths.configDir, "cutover-choices.json"),
  paths.opencodeConfig,
  paths.cursorSettings,
  paths.cursorMcp,
  paths.piConfig,
  paths.piSettings,
  path.join(paths.cursorPluginDir, "hooks", "hooks-cursor.json"),
];

type CutoverScope = {
  path: string;
  category: CutoverInventoryEntry["category"];
  disposition: CutoverInventoryEntry["disposition"];
};

const exactRegistrationEvidence = (
  file: string,
  paths: ReturnType<typeof resolvePaths>,
): string | null => {
  try {
    if (!noSymlinkAncestor(path.dirname(file))) return null;
    const fileStat = lstatOrNull(file);
    if (!fileStat?.isFile() || fileStat.isSymbolicLink()) return null;
    if (file === paths.opencodeConfig) {
      const cfg = JSON.parse(readFileSync(file, "utf8"));
      const plugins = Array.isArray(cfg.plugin) ? cfg.plugin : cfg.plugin ? [cfg.plugin] : [];
      const workit = plugins.filter((plugin: unknown) => isWorkitPlugin(plugin));
      return workit.length > 0 ? "exact Workit plugin entry in OpenCode config" : null;
    }
    if (file === paths.cursorSettings) {
      const cfg = JSON.parse(readFileSync(file, "utf8"));
      const enabled = cfg?.enabled_plugins;
      const pluginEnabled =
        enabled &&
        typeof enabled === "object" &&
        Object.entries(enabled).some(([name, value]) => isWorkitPlugin(name) && value === true);
      const dirs = Array.isArray(cfg?.plugin_dirs) ? cfg.plugin_dirs : [];
      const dirRegistered = dirs.some(
        (dir: unknown) => typeof dir === "string" && path.resolve(dir) === paths.cursorPluginDir,
      );
      return pluginEnabled || dirRegistered
        ? "exact Workit plugin key or directory in Cursor settings"
        : null;
    }
    if (file === paths.cursorMcp) {
      const cfg = JSON.parse(readFileSync(file, "utf8"));
      const servers = cfg?.mcpServers;
      const workit =
        servers &&
        typeof servers === "object" &&
        Object.entries(servers).some(([name, value]) => {
          if (isWorkitPlugin(name)) return true;
          const server = value as { command?: unknown; args?: unknown } | null;
          return (
            server?.command === "npx" &&
            Array.isArray(server.args) &&
            server.args.includes(`--package=${CURSOR_RUNTIME_PACKAGE}`)
          );
        });
      return workit ? "exact Workit MCP server entry in Cursor config" : null;
    }
    if (file === paths.piConfig) {
      const cfg = JSON.parse(readFileSync(file, "utf8"));
      const ext = paths.dev && path.join(paths.dev, "packages/workit-pi/dist/workit.js");
      const skills = paths.dev && path.join(paths.dev, "packages/workit-pi/skills");
      const matches = (value: unknown, target: string | null): boolean =>
        target !== null &&
        typeof value === "string" &&
        path.resolve(value) === path.resolve(target);
      const extensions = cfg?.extensions ?? cfg?.pi?.extensions;
      const skillPaths = cfg?.skills ?? cfg?.pi?.skills;
      if (
        (Array.isArray(extensions) && extensions.some((entry: unknown) => matches(entry, ext))) ||
        (Array.isArray(skillPaths) && skillPaths.some((entry: unknown) => matches(entry, skills)))
      ) {
        return "exact Workit extension or skills path in Pi config";
      }
    }
    if (file === paths.piSettings) {
      const cfg = JSON.parse(readFileSync(file, "utf8"));
      const packageDir = paths.dev && path.join(paths.dev, "packages/workit-pi");
      const matches = (entry: unknown): boolean =>
        typeof packageDir === "string" &&
        typeof entry === "string" &&
        path.resolve(entry) === path.resolve(packageDir);
      if (Array.isArray(cfg?.packages) && cfg.packages.some(matches)) {
        return "exact Workit package path in Pi settings";
      }
    }
  } catch {
    return null;
  }
  return null;
};

const appendExactPath = (value: unknown, target: string): unknown[] => {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return [
    ...entries.filter(
      (entry) => typeof entry !== "string" || path.resolve(entry) !== path.resolve(target),
    ),
    target,
  ];
};

const mergePiConfig = (current: Record<string, unknown>, dev: string): Record<string, unknown> => {
  const nestedPi =
    current.pi && typeof current.pi === "object" && !Array.isArray(current.pi)
      ? (current.pi as Record<string, unknown>)
      : null;
  const target = nestedPi ?? current;
  const extension = path.join(dev, "packages/workit-pi/dist/workit.js");
  const skills = path.join(dev, "packages/workit-pi/skills");
  return nestedPi
    ? {
        ...current,
        pi: {
          ...nestedPi,
          extensions: appendExactPath(nestedPi.extensions, extension),
          skills: appendExactPath(nestedPi.skills, skills),
        },
      }
    : {
        ...target,
        extensions: appendExactPath(target.extensions, extension),
        skills: appendExactPath(target.skills, skills),
      };
};

const mergePiSettings = (
  current: Record<string, unknown>,
  dev: string,
): Record<string, unknown> => ({
  ...current,
  packages: appendExactPath(current.packages, path.join(dev, "packages/workit-pi")),
});

const legacyFlowInventoryTargets = (workspace: string, issues: Set<string>): string[] => {
  const docs = path.join(workspace, "docs");
  let docsStat: ReturnType<typeof lstatSync> | null;
  try {
    if (!noSymlinkAncestor(path.dirname(docs))) {
      issues.add(`symlinked parent is outside the inventoried scope: ${path.dirname(docs)}`);
      return [];
    }
    docsStat = lstatOrNull(docs);
  } catch (error) {
    issues.add(`cannot inspect project history at ${docs}: ${String(error)}`);
    return [];
  }
  if (!docsStat) return [];
  if (docsStat.isSymbolicLink()) return [docs];
  if (!docsStat.isDirectory()) return [];

  const targets: string[] = [];
  try {
    const { names: slugs, truncated } = readDirNamesBounded(docs, MAX_CUTOVER_INVENTORY_ENTRIES);
    if (truncated) {
      issues.add(`project history inventory exceeds ${MAX_CUTOVER_INVENTORY_ENTRIES} entries`);
    }
    for (const slug of slugs) {
      const slugPath = path.join(docs, slug);
      const slugStat = lstatOrNull(slugPath);
      if (!slugStat) continue;
      if (slugStat.isSymbolicLink()) {
        targets.push(slugPath);
        continue;
      }
      if (!slugStat.isDirectory()) continue;
      const sddPath = path.join(slugPath, "sdd");
      const sddStat = lstatOrNull(sddPath);
      if (!sddStat) continue;
      if (sddStat.isSymbolicLink()) {
        targets.push(sddPath);
        continue;
      }
      if (!sddStat.isDirectory()) continue;
      const flow = path.join(sddPath, "flow.json");
      if (lstatOrNull(flow)) targets.push(flow);
      if (targets.length >= MAX_CUTOVER_INVENTORY_ENTRIES) {
        issues.add(`project history inventory exceeds ${MAX_CUTOVER_INVENTORY_ENTRIES} entries`);
        break;
      }
    }
  } catch (error) {
    issues.add(`cannot enumerate project history at ${docs}: ${String(error)}`);
  }
  return targets;
};

const cutoverInventoryScopes = (
  paths: ReturnType<typeof resolvePaths>,
  issues: Set<string>,
): CutoverScope[] => [
  { path: paths.configDir, category: "configuration", disposition: "preserve" },
  { path: paths.stateDir, category: "recovery", disposition: "preserve" },
  {
    path: path.join(paths.workspace, ".workit"),
    category: "project-state",
    disposition: "preserve",
  },
  ...legacyFlowInventoryTargets(paths.workspace, issues).map((target) => ({
    path: target,
    category: "project-history" as const,
    disposition: "preserve" as const,
  })),
  { path: paths.opencodeConfig, category: "host-configuration", disposition: "unknown" },
  { path: paths.cursorSettings, category: "host-configuration", disposition: "unknown" },
  { path: paths.cursorMcp, category: "host-configuration", disposition: "unknown" },
  {
    path: paths.cursorPluginDir,
    category: "integration",
    disposition: "unknown",
  },
  {
    path: path.join(paths.home, ".codex", "plugins", "workit"),
    category: "integration",
    disposition: "unknown",
  },
  {
    path: paths.piConfig,
    category: "host-configuration",
    disposition: "unknown",
  },
  {
    path: paths.piSettings,
    category: "host-configuration",
    disposition: "unknown",
  },
];

const buildCutoverInventory = (paths: ReturnType<typeof resolvePaths>): CutoverInventory => {
  const entries: CutoverInventoryEntry[] = [];
  const issues = new Set<string>();
  const seen = new Set<string>();
  const cursorPluginRegistered = exactRegistrationEvidence(paths.cursorSettings, paths) !== null;
  const add = (scope: CutoverScope, file: string, depth: number): void => {
    if (entries.length >= MAX_CUTOVER_INVENTORY_ENTRIES) {
      issues.add(`cutover inventory exceeds ${MAX_CUTOVER_INVENTORY_ENTRIES} entries`);
      return;
    }
    if (seen.has(file)) return;
    seen.add(file);

    if (depth === 0) {
      try {
        if (!noSymlinkAncestor(path.dirname(file))) {
          issues.add(`symlinked parent is outside the inventoried scope: ${path.dirname(file)}`);
          return;
        }
      } catch (error) {
        issues.add(`cannot inspect parent for ${file}: ${String(error)}`);
        return;
      }
    }
    let stat: ReturnType<typeof lstatSync> | null;
    try {
      stat = lstatOrNull(file);
    } catch (error) {
      issues.add(`cannot inspect ${file}: ${String(error)}`);
      return;
    }
    if (!stat) return;

    const kind: CutoverInventoryEntry["kind"] = stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : "other";
    let digest: Digest | null = null;
    if (kind === "file") {
      try {
        digest = digestFile(file);
        if (digest === null) issues.add(`file changed during inventory: ${file}`);
      } catch (error) {
        issues.add(`cannot read ${file}: ${String(error)}`);
      }
    } else if (kind === "symlink") {
      issues.add(`symlink not followed during inventory: ${file}`);
    } else if (kind === "other") {
      issues.add(`unsupported filesystem entry during inventory: ${file}`);
    }

    const inCursorPlugin =
      file === paths.cursorPluginDir || file.startsWith(`${paths.cursorPluginDir}${path.sep}`);
    const cursorAssetPath = inCursorPlugin
      ? path.relative(paths.cursorPluginDir, file).split(path.sep).join("/")
      : "";
    const expectedCursorDigest = LEGACY_CURSOR_ASSET_DIGESTS[cursorAssetPath];
    const verifiedCursorAsset =
      kind === "file" && digest !== null && expectedCursorDigest === digest;
    const ownershipEvidence = verifiedCursorAsset
      ? `SHA-256 matches generated Cursor asset from Workit 1.2.1: ${cursorAssetPath}`
      : kind === "file"
        ? exactRegistrationEvidence(file, paths)
        : inCursorPlugin && cursorPluginRegistered
          ? "Cursor settings registers this plugin directory; individual files remain unverified"
          : null;
    const disposition =
      file === path.join(paths.configDir, "config.json")
        ? "convert"
        : verifiedCursorAsset || (ownershipEvidence && scope.category === "host-configuration")
          ? "convert"
          : scope.disposition;
    entries.push({
      path: file,
      kind,
      category: scope.category,
      disposition,
      bytes: kind === "file" ? stat.size : 0,
      digest,
      ownershipEvidence,
    });

    if (kind !== "directory") return;
    if (depth >= MAX_CUTOVER_INVENTORY_DEPTH) {
      issues.add(`inventory depth exceeds ${MAX_CUTOVER_INVENTORY_DEPTH}: ${file}`);
      return;
    }
    try {
      const { names, truncated } = readDirNamesBounded(
        file,
        Math.max(0, MAX_CUTOVER_INVENTORY_ENTRIES - entries.length),
      );
      if (truncated)
        issues.add(`cutover inventory exceeds ${MAX_CUTOVER_INVENTORY_ENTRIES} entries`);
      for (const name of names) add(scope, path.join(file, name), depth + 1);
    } catch (error) {
      issues.add(`cannot enumerate ${file}: ${String(error)}`);
    }
  };

  for (const scope of cutoverInventoryScopes(paths, issues)) add(scope, scope.path, 0);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const bytesByCategory: CutoverInventory["bytesByCategory"] = {};
  let files = 0;
  let bytes = 0;
  const hash = createHash("sha256");
  for (const entry of entries) {
    if (entry.kind === "file") {
      files += 1;
      bytes += entry.bytes;
      bytesByCategory[entry.category] = (bytesByCategory[entry.category] ?? 0) + entry.bytes;
    }
    hash.update(`${entry.path}\0${entry.kind}\0${entry.bytes}\0${entry.digest ?? ""}\n`);
  }
  const issueList = [...issues].toSorted();
  for (const issue of issueList) hash.update(`!${issue}\n`);
  return {
    complete: issueList.length === 0,
    entries,
    files,
    bytes,
    bytesByCategory,
    issues: issueList,
    revision: hash.digest("hex"),
  };
};

const hostMutationTargets = (
  paths: ReturnType<typeof resolvePaths>,
  hosts: CutoverHost[],
): string[] => {
  const targets: string[] = [];
  for (const host of hosts) {
    if (host === "cursor")
      targets.push(
        path.join(paths.cursorPluginDir, "skills"),
        path.join(paths.cursorPluginDir, "commands"),
        path.join(paths.cursorPluginDir, "rules", "workit-contract.mdc"),
      );
    if (host === "codex") targets.push(path.join(paths.home, ".codex", "plugins", "workit"));
    if (host === "pi") targets.push(paths.piConfig, paths.piSettings);
  }
  return targets;
};

const expandBackupTargets = (targets: string[]): { files: string[]; issues: string[] } => {
  const files: string[] = [];
  const issues = new Set<string>();
  for (const target of targets) {
    const walk = (file: string, depth: number): void => {
      if (files.length >= MAX_CUTOVER_INVENTORY_ENTRIES) {
        issues.add(`backup inventory exceeds ${MAX_CUTOVER_INVENTORY_ENTRIES} files`);
        return;
      }
      if (depth === 0 && !noSymlinkAncestor(path.dirname(file))) {
        issues.add(`symlinked parent is outside the backup scope: ${path.dirname(file)}`);
        return;
      }
      let stat: ReturnType<typeof lstatSync> | null;
      try {
        stat = lstatOrNull(file);
      } catch (error) {
        issues.add(`cannot inspect backup target ${file}: ${String(error)}`);
        return;
      }
      if (!stat) return;
      if (stat.isSymbolicLink()) {
        issues.add(`symlink not followed in backup target: ${file}`);
        return;
      }
      if (stat.isDirectory()) {
        if (depth >= MAX_CUTOVER_INVENTORY_DEPTH) {
          issues.add(`backup inventory depth exceeds ${MAX_CUTOVER_INVENTORY_DEPTH}: ${file}`);
          return;
        }
        try {
          const { names, truncated } = readDirNamesBounded(
            file,
            Math.max(0, MAX_CUTOVER_INVENTORY_ENTRIES - files.length),
          );
          if (truncated)
            issues.add(`backup inventory exceeds ${MAX_CUTOVER_INVENTORY_ENTRIES} files`);
          for (const name of names) walk(path.join(file, name), depth + 1);
        } catch (error) {
          issues.add(`cannot enumerate backup target ${file}: ${String(error)}`);
        }
      } else if (stat.isFile()) {
        files.push(file);
      } else {
        issues.add(`unsupported backup entry: ${file}`);
      }
    };
    walk(target, 0);
  }
  return { files, issues: [...issues] };
};

const cutoverBackupTargets = (
  paths: ReturnType<typeof resolvePaths>,
  hosts: CutoverHost[],
): string[] => [...new Set([...managedCutoverFiles(paths), ...hostMutationTargets(paths, hosts)])];

const backupRoot = (archiveDir: string, backupId: Id) => path.join(archiveDir, backupId);

const archiveDestinationError = (
  archiveDir: string,
  paths: ReturnType<typeof resolvePaths>,
): string | null => {
  const resolved = path.resolve(archiveDir);
  const scopes = [paths.configDir, paths.stateDir, paths.workspace].map((p) => path.resolve(p));
  if (
    scopes.some(
      (scope) =>
        resolved === scope ||
        resolved.startsWith(scope + path.sep) ||
        scope.startsWith(resolved + path.sep),
    )
  ) {
    return "archive destination must be separate from config, state, and workspace";
  }
  if (!noSymlinkAncestor(resolved)) return "archive destination has a symlinked ancestor";
  const existing = lstatOrNull(resolved);
  if (existing && !existing.isDirectory()) return "archive destination is not a directory";
  return null;
};

const backupRelPath = (file: string, paths: ReturnType<typeof resolvePaths>): string => {
  if (file.startsWith(paths.configDir + path.sep) || file === paths.configDir) {
    return path.join("config", path.relative(paths.configDir, file));
  }
  return path.join("home", path.relative(paths.home, file));
};

type VerifiedBackupFile = { digest: Digest; storagePath: string };

const readBackupFiles = (
  backupId: Id,
  archiveDir: string,
  paths: ReturnType<typeof resolvePaths>,
): { files: Map<string, VerifiedBackupFile>; issues: string[] } => {
  const root = backupRoot(archiveDir, backupId);
  const manifestPath = path.join(root, "manifest.json");
  const files = new Map<string, VerifiedBackupFile>();
  const issues: string[] = [];
  if (digestFile(manifestPath) === null) {
    return { files, issues: ["backup manifest is missing or unsafe"] };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { files, issues: ["backup manifest is unreadable"] };
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { files, issues: ["backup manifest is malformed"] };
  }

  const data = manifest as Record<string, unknown>;
  const hashed = data.schemaVersion === 1 && data.storage === "sha256-path-v1";
  const legacy = data.schemaVersion === undefined && data.storage === undefined;
  if (data.backupId !== backupId || (!hashed && !legacy) || !Array.isArray(data.files)) {
    return { files, issues: ["backup manifest identity or format is invalid"] };
  }

  for (const item of data.files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push("backup manifest contains an invalid file entry");
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.path !== "string" ||
      !path.isAbsolute(entry.path) ||
      path.resolve(entry.path) !== entry.path
    ) {
      issues.push("backup manifest contains an invalid file path");
      continue;
    }
    const digest = hashed ? entry.digest : entry.installedDigest;
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
      issues.push(`backup digest is invalid: ${entry.path}`);
      continue;
    }
    if (files.has(entry.path)) {
      issues.push(`backup path is duplicated: ${entry.path}`);
      continue;
    }

    const relative = hashed
      ? path.join("files", createHash("sha256").update(entry.path).digest("hex"))
      : backupRelPath(entry.path, paths);
    const storagePath = path.resolve(root, relative);
    const fromRoot = path.relative(path.resolve(root), storagePath);
    if (
      fromRoot === "" ||
      fromRoot === ".." ||
      fromRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(fromRoot)
    ) {
      issues.push(`backup path escapes its directory: ${entry.path}`);
      continue;
    }
    if (digestFile(storagePath) !== digest) {
      issues.push(`backup content failed verification: ${entry.path}`);
      continue;
    }
    files.set(entry.path, { digest: digest, storagePath });
  }
  return { files, issues };
};

const writeBackup = (
  backupId: Id,
  archiveDir: string,
  paths: ReturnType<typeof resolvePaths>,
  files: string[],
): void => {
  const root = backupRoot(archiveDir, backupId);
  mkdirSync(root, { recursive: true });
  const manifest: { path: string; digest: Digest }[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const before = digestFile(file);
    if (before === null) throw new Error(`backup source is not a regular file: ${file}`);
    const dest = path.join(
      root,
      "files",
      createHash("sha256").update(path.resolve(file)).digest("hex"),
    );
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(file, dest, { dereference: false, errorOnExist: true });
    if (digestFile(file) !== before || digestFile(dest) !== before) {
      throw new Error(`backup verification failed: ${file}`);
    }
    manifest.push({ path: path.resolve(file), digest: before });
  }
  writeFileAtomic(
    path.join(root, "manifest.json"),
    JSON.stringify(
      { schemaVersion: 1, storage: "sha256-path-v1", backupId, files: manifest },
      null,
      2,
    ) + "\n",
  );
};

const receiptPath = (stateDir: string, backupId: Id) =>
  path.join(stateDir, "cutover", "receipts", `${backupId}.json`);

const writeReceipt = (receipt: CutoverReceipt, stateDir: string): void => {
  writeFileAtomic(receiptPath(stateDir, receipt.backupId), JSON.stringify(receipt, null, 2) + "\n");
};

const cutoverJournalPath = (stateDir: string, backupId: Id): string =>
  path.join(stateDir, "cutover", "journals", `${backupId}.json`);

const writeCutoverJournal = (journal: CutoverJournal, stateDir: string): void => {
  writeFileAtomic(
    cutoverJournalPath(stateDir, journal.backupId),
    JSON.stringify(journal, null, 2) + "\n",
  );
};

const isCutoverHost = (value: unknown): value is CutoverHost =>
  value === "opencode" || value === "cursor" || value === "codex" || value === "pi";

const readCutoverJournal = (backupId: Id, stateDir: string): CutoverJournal | null => {
  if (!validCutoverId(backupId)) return null;
  const file = cutoverJournalPath(stateDir, backupId);
  if (digestFile(file) === null) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<CutoverJournal>;
    const stepNames = new Set([
      "configuration",
      "generation",
      "verification",
      "receipt",
      ...(value.hosts ?? []).map((h) => `host:${h}`),
    ]);
    if (
      value.schemaVersion !== 1 ||
      value.backupId !== backupId ||
      typeof value.archiveDir !== "string" ||
      !path.isAbsolute(value.archiveDir) ||
      path.resolve(value.archiveDir) !== value.archiveDir ||
      typeof value.planId !== "string" ||
      !Array.isArray(value.hosts) ||
      !value.hosts.every(isCutoverHost) ||
      !value.hosts.length ||
      !value.resolutions ||
      typeof value.resolutions !== "object" ||
      Object.values(value.resolutions).some((entry) => typeof entry !== "string") ||
      typeof value.conversionNeeded !== "boolean" ||
      !["applying", "interrupted", "partial", "complete"].includes(value.phase ?? "") ||
      !Array.isArray(value.completedSteps) ||
      value.completedSteps.some((step) => typeof step !== "string" || !stepNames.has(step)) ||
      !Array.isArray(value.appliedHosts) ||
      value.appliedHosts.some((host) => !isCutoverHost(host) || !value.hosts?.includes(host)) ||
      !(
        value.currentStep === null ||
        (typeof value.currentStep === "string" && stepNames.has(value.currentStep))
      ) ||
      !(value.error === null || typeof value.error === "string") ||
      typeof value.startedAt !== "string" ||
      !Array.isArray(value.notes) ||
      value.notes.some((note) => typeof note !== "string")
    )
      return null;
    return value as CutoverJournal;
  } catch {
    return null;
  }
};

export const readCutoverReceipt = (backupId: Id, stateDir: string): CutoverReceipt | null => {
  if (!validCutoverId(backupId)) return null;
  const file = receiptPath(stateDir, backupId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CutoverReceipt;
  } catch {
    return null;
  }
};

const plannedAfterDigest = (
  file: string,
  host: CutoverHost,
  paths: ReturnType<typeof resolvePaths>,
): Digest => {
  if (file === paths.opencodeConfig && paths.dev) {
    const pin = `file://${paths.dev}/packages/workit-opencode/dist/plugin.js`;
    const merged = mergeOpenCodeConfig(
      existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {},
      pin,
    );
    return createHash("sha256").update(JSON.stringify(merged.config)).digest("hex");
  }
  if (file === paths.cursorSettings) {
    const merged = mergeCursorSettings(
      existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {},
      paths.cursorPluginDir,
    );
    return createHash("sha256").update(JSON.stringify(merged.config)).digest("hex");
  }
  if (file === paths.cursorMcp) {
    const merged = mergeCursorMcp(
      existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { mcpServers: {} },
      "workit",
      cursorMcpServerEntry(paths.cursorPluginDir),
    );
    return createHash("sha256").update(JSON.stringify(merged.config)).digest("hex");
  }
  if (file === paths.piConfig && paths.dev) {
    const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    const next = mergePiConfig(current, paths.dev);
    return createHash("sha256").update(JSON.stringify(next)).digest("hex");
  }
  if (file === paths.piSettings && paths.dev) {
    const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    const next = mergePiSettings(current, paths.dev);
    return createHash("sha256").update(JSON.stringify(next)).digest("hex");
  }
  if (file.endsWith("hooks-cursor.json")) {
    const entry = cursorHooksEntry(paths.cursorPluginDir);
    const base = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : { version: 1, hooks: {} };
    const next = {
      ...base,
      hooks: { ...base.hooks, sessionStart: [{ command: entry.command }] },
    };
    return createHash("sha256").update(JSON.stringify(next)).digest("hex");
  }
  return createHash("sha256").update(readFileSync(file)).digest("hex");
};

export function previewCutover(
  options: CutoverPaths = {},
  hosts: CutoverHost[] = ["opencode", "cursor"],
): CutoverPlan {
  const paths = resolvePaths(options);
  const blocked: string[] = [];
  const archiveDir = options.archiveDir ? path.resolve(options.archiveDir) : null;
  if (archiveDir) {
    const archiveError = archiveDestinationError(archiveDir, paths);
    if (archiveError) blocked.push(archiveError);
  }
  const inventory = buildCutoverInventory(paths);
  let conversion: ConversionPreview = { mappings: [], preserved: [], unresolved: [] };
  if (inventory.complete) {
    try {
      conversion = previewConversion({ configDir: paths.configDir });
    } catch (error) {
      blocked.push(`cannot preview configuration conversion: ${String(error)}`);
    }
  }
  const unresolved = [...conversion.unresolved];

  if (inventory.complete) {
    for (const host of hosts) {
      const gen = classifyHostGeneration(host, paths);
      if (gen === "mixed") blocked.push(`${host}: mixed legacy and v1 components`);
    }
  }

  for (const session of paths.sessions) {
    if (session.state === "active" || session.state === "unknown") {
      blocked.push(`${session.host} session ${session.handle} is ${session.state}`);
    }
  }

  for (const issue of inventory.issues) blocked.push(`inventory: ${issue}`);

  const managedFiles = managedCutoverFiles(paths).map((filePath) => {
    if (!noSymlinkAncestor(path.dirname(filePath))) {
      blocked.push(`symlinked parent is outside the inventoried scope: ${path.dirname(filePath)}`);
      return {
        path: filePath,
        beforeDigest: null,
        afterDigest: createHash("sha256").update("").digest("hex"),
      };
    }
    const stat = lstatOrNull(filePath);
    if (stat && !stat.isFile()) {
      blocked.push(`managed path is not a regular file: ${filePath}`);
      return {
        path: filePath,
        beforeDigest: null,
        afterDigest: createHash("sha256").update("").digest("hex"),
      };
    }
    const beforeDigest = digestFile(filePath);
    try {
      return {
        path: filePath,
        beforeDigest,
        afterDigest:
          beforeDigest === null
            ? createHash("sha256").update("").digest("hex")
            : plannedAfterDigest(filePath, hosts[0] ?? "cursor", paths),
      };
    } catch (error) {
      blocked.push(`cannot plan managed file ${filePath}: ${String(error)}`);
      return {
        path: filePath,
        beforeDigest,
        afterDigest: beforeDigest ?? createHash("sha256").update("").digest("hex"),
      };
    }
  });

  return {
    id: randomUUID(),
    archiveDir,
    managedFiles,
    inventory,
    sessions: paths.sessions,
    unresolved,
    conversion,
    hosts,
    blocked,
  };
}

const syncV1CursorSkills = (pluginDir: string, dev: string | null, notes: string[]) => {
  const syncGeneratedFile = (relative: string, file: string, content: string): void => {
    if (!noSymlinkAncestor(path.dirname(file))) throw new Error(`symlinked parent: ${file}`);
    const stat = lstatOrNull(file);
    if (stat?.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${file}`);
    if (stat && !stat.isFile()) throw new Error(`refusing to replace non-file: ${file}`);
    const desiredDigest = createHash("sha256").update(content).digest("hex");
    if (!stat) {
      writeFileExclusive(file, content);
      return;
    }
    const currentDigest = digestFile(file);
    if (currentDigest === desiredDigest) return;
    if (currentDigest === LEGACY_CURSOR_ASSET_DIGESTS[relative]) {
      writeFileAtomic(file, content);
      notes.push(`cursor: refreshed verified generated asset ${relative}`);
    } else {
      notes.push(`cursor: preserved modified or unknown asset ${relative}`);
    }
  };
  mkdirSync(path.join(pluginDir, "skills"), { recursive: true });
  for (const skill of WORKIT_METHOD_SKILLS) {
    const src = dev ? path.join(dev, "packages/workit-cursor/skills", skill, "SKILL.md") : null;
    const destDir = path.join(pluginDir, "skills", skill);
    mkdirSync(destDir, { recursive: true });
    syncGeneratedFile(
      `skills/${skill}/SKILL.md`,
      path.join(destDir, "SKILL.md"),
      src && existsSync(src) ? readFileSync(src, "utf8") : "# v1\n",
    );
  }
  // Bare slash aliases ship next to skills so installs match the repo.
  mkdirSync(path.join(pluginDir, "commands"), { recursive: true });
  for (const alias of Object.keys(WORKIT_SKILL_ALIASES)) {
    const src = dev ? path.join(dev, "packages/workit-cursor/commands", `${alias}.md`) : null;
    syncGeneratedFile(
      `commands/${alias}.md`,
      path.join(pluginDir, "commands", `${alias}.md`),
      src && existsSync(src) ? readFileSync(src, "utf8") : `# /${alias}\n`,
    );
  }
  const ruleSource = dev && path.join(dev, "packages/workit-cursor/rules/workit-contract.mdc");
  if (ruleSource && existsSync(ruleSource)) {
    mkdirSync(path.join(pluginDir, "rules"), { recursive: true });
    syncGeneratedFile(
      "rules/workit-contract.mdc",
      path.join(pluginDir, "rules", "workit-contract.mdc"),
      readFileSync(ruleSource, "utf8"),
    );
  }
};

const applyHostCutover = (
  host: CutoverHost,
  paths: ReturnType<typeof resolvePaths>,
  notes: string[],
): boolean => {
  if (host === "cursor") {
    syncV1CursorSkills(paths.cursorPluginDir, paths.dev, notes);
    const settings = existsSync(paths.cursorSettings)
      ? JSON.parse(readFileSync(paths.cursorSettings, "utf8"))
      : {};
    writeFileAtomic(
      paths.cursorSettings,
      JSON.stringify(mergeCursorSettings(settings, paths.cursorPluginDir).config, null, 2) + "\n",
    );
    const mcp = existsSync(paths.cursorMcp)
      ? JSON.parse(readFileSync(paths.cursorMcp, "utf8"))
      : { mcpServers: {} };
    writeFileAtomic(
      paths.cursorMcp,
      JSON.stringify(
        mergeCursorMcp(mcp, "workit", cursorMcpServerEntry(paths.cursorPluginDir)).config,
        null,
        2,
      ) + "\n",
    );
    const hooksPath = path.join(paths.cursorPluginDir, "hooks", "hooks-cursor.json");
    const hooks = existsSync(hooksPath)
      ? JSON.parse(readFileSync(hooksPath, "utf8"))
      : { version: 1, hooks: {} };
    const entry = cursorHooksEntry(paths.cursorPluginDir);
    const hookConfig = hooks && typeof hooks === "object" ? hooks : { version: 1, hooks: {} };
    const hookMap =
      hookConfig.hooks && typeof hookConfig.hooks === "object" ? hookConfig.hooks : {};
    const sessionStart = Array.isArray(hookMap.sessionStart) ? hookMap.sessionStart : [];
    const isWorkitSessionStart = (value: unknown): boolean => {
      const command =
        typeof value === "string"
          ? value
          : value && typeof value === "object" && "command" in value
            ? String(value.command)
            : "";
      return (
        command === entry.command ||
        command ===
          `npx -y --prefer-online --min-release-age=0 --package=${CURSOR_RUNTIME_PACKAGE} workit-cursor-session-start`
      );
    };
    writeFileAtomic(
      hooksPath,
      JSON.stringify(
        {
          ...hookConfig,
          hooks: {
            ...hookMap,
            sessionStart: [
              ...sessionStart.filter((item: unknown) => !isWorkitSessionStart(item)),
              entry,
            ],
          },
        },
        null,
        2,
      ) + "\n",
    );
    notes.push(
      "cursor: replaced legacy skills with v1 method skills and canonical @latest registration",
    );
    return true;
  }
  if (host === "opencode" && paths.dev) {
    const pin = `file://${paths.dev}/packages/workit-opencode/dist/plugin.js`;
    const distDir = path.join(paths.dev, "packages/workit-opencode/dist");
    mkdirSync(distDir, { recursive: true });
    const dist = path.join(distDir, "plugin.js");
    if (!existsSync(dist)) writeFileExclusive(dist, "export default {};\n");
    const current = existsSync(paths.opencodeConfig)
      ? JSON.parse(readFileSync(paths.opencodeConfig, "utf8"))
      : {};
    writeFileAtomic(
      paths.opencodeConfig,
      JSON.stringify(mergeOpenCodeConfig(current, pin).config, null, 2) + "\n",
    );
    notes.push("opencode: repinned to v1 dist entry");
    return true;
  }
  if (host === "codex" && paths.dev) {
    const pluginDir = path.join(paths.home, ".codex", "plugins", "workit");
    mkdirSync(pluginDir, { recursive: true });
    cpSync(
      path.join(paths.dev, "packages/workit-codex/.codex-plugin"),
      path.join(pluginDir, ".codex-plugin"),
      {
        recursive: true,
        force: false,
        errorOnExist: false,
        dereference: false,
      },
    );
    notes.push("codex: installed v1 plugin scaffold");
    return true;
  }
  if (host === "pi" && paths.dev) {
    mkdirSync(path.dirname(paths.piConfig), { recursive: true });
    mkdirSync(path.dirname(paths.piSettings), { recursive: true });
    const readConfig = (file: string): Record<string, unknown> => {
      if (!existsSync(file)) return {};
      const value = JSON.parse(readFileSync(file, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    };
    writeFileAtomic(
      paths.piConfig,
      JSON.stringify(mergePiConfig(readConfig(paths.piConfig), paths.dev), null, 2) + "\n",
    );
    writeFileAtomic(
      paths.piSettings,
      JSON.stringify(mergePiSettings(readConfig(paths.piSettings), paths.dev), null, 2) + "\n",
    );
    notes.push(
      "pi: registered v1 package, extension, and skills while preserving unrelated entries",
    );
    return true;
  }
  return false;
};

export function applyCutover(
  plan: CutoverPlan,
  decision: CutoverDecision,
  options: CutoverPaths = {},
): Result<CutoverReceipt> {
  if (!decision.approve) return failure("permission_denied", "cutover not approved");
  if (plan.blocked.length > 0) {
    return failure("requirements_unsatisfied", "cutover blocked", {
      fields: plan.blocked.map((b) => ({ path: b, reason: "blocked" })),
    });
  }
  for (const item of plan.unresolved) {
    if (!decision.resolutions?.[item.key]) {
      return failure("needs_input", `unresolved setting requires a decision: ${item.key}`);
    }
  }

  const paths = resolvePaths(options);
  if (!options.archiveDir || !plan.archiveDir)
    return failure("needs_input", "archive destination is required (--archive-dir)");
  const archiveDir = path.resolve(options.archiveDir);
  if (archiveDir !== plan.archiveDir)
    return failure("revision_conflict", "archive destination changed since preview");
  const archiveError = archiveDestinationError(archiveDir, paths);
  if (archiveError) return failure("requirements_unsatisfied", archiveError);
  if (!plan.inventory?.complete) {
    return failure("requirements_unsatisfied", "cutover inventory is incomplete");
  }
  const currentInventory = buildCutoverInventory(paths);
  if (!currentInventory.complete) {
    return failure("requirements_unsatisfied", "cutover inventory is incomplete", {
      fields: currentInventory.issues.map((issue) => ({ path: issue, reason: "inventory" })),
    });
  }
  if (currentInventory.revision !== plan.inventory.revision) {
    return failure("revision_conflict", "cutover sources changed since preview");
  }
  for (const entry of plan.managedFiles) {
    const current = digestFile(entry.path);
    if (entry.beforeDigest !== null && current !== entry.beforeDigest) {
      return failure("revision_conflict", `managed file changed since preview: ${entry.path}`, {
        path: entry.path,
      });
    }
  }
  for (const session of paths.sessions) {
    if (session.state === "active" || session.state === "unknown") {
      return failure(
        "requirements_unsatisfied",
        `old session still ${session.state}: ${session.handle}`,
      );
    }
  }
  for (const host of decision.hosts) {
    if (classifyHostGeneration(host, paths) === "mixed") {
      return failure("requirements_unsatisfied", `mixed legacy and v1 components on ${host}`);
    }
  }

  const backupId = randomUUID();
  const backupTargets = cutoverBackupTargets(paths, decision.hosts);
  const backupInventory = expandBackupTargets(backupTargets);
  if (backupInventory.issues.length > 0) {
    return failure("requirements_unsatisfied", "cutover backup inventory is incomplete", {
      fields: backupInventory.issues.map((issue) => ({ path: issue, reason: "inventory" })),
    });
  }
  try {
    mkdirSync(archiveDir, { recursive: true });
    writeBackup(backupId, archiveDir, paths, backupInventory.files);
    const journal: CutoverJournal = {
      schemaVersion: 1,
      backupId,
      archiveDir,
      planId: plan.id,
      hosts: [...decision.hosts],
      resolutions: { ...decision.resolutions },
      conversionNeeded: plan.unresolved.length > 0 || plan.conversion.mappings.length > 0,
      phase: "applying",
      completedSteps: [],
      appliedHosts: [],
      currentStep: null,
      error: null,
      startedAt: new Date().toISOString(),
      notes: [],
    };
    writeCutoverJournal(journal, paths.stateDir);
    return runCutoverJournal(journal, paths, plan.conversion);
  } catch (error) {
    return failure("requirements_unsatisfied", `could not stage cutover backup: ${String(error)}`);
  }
}

const runCutoverJournal = (
  journal: CutoverJournal,
  paths: ReturnType<typeof resolvePaths>,
  conversion?: ConversionPreview,
): Result<CutoverReceipt> => {
  const completed = (step: string): boolean => journal.completedSteps.includes(step);
  const fail = (step: string, error: unknown): Result<CutoverReceipt> => {
    journal.phase = "interrupted";
    journal.currentStep = step;
    journal.error = String(error);
    try {
      writeCutoverJournal(journal, paths.stateDir);
    } catch (journalError) {
      return failure(
        "requirements_unsatisfied",
        `cutover interrupted at ${step}; journal write failed: ${String(journalError)}`,
        { path: journal.backupId, operation: step },
      );
    }
    return failure(
      "requirements_unsatisfied",
      `cutover interrupted at ${step}; resume backup ${journal.backupId}`,
      {
        path: journal.backupId,
        operation: step,
        guidance: journal.error,
      },
    );
  };
  const begin = (step: string): void => {
    journal.phase = "applying";
    journal.currentStep = step;
    journal.error = null;
    writeCutoverJournal(journal, paths.stateDir);
  };
  const finish = (step: string): void => {
    if (!completed(step)) journal.completedSteps.push(step);
    journal.currentStep = null;
    journal.error = null;
    writeCutoverJournal(journal, paths.stateDir);
  };

  if (journal.conversionNeeded && !completed("configuration")) {
    try {
      begin("configuration");
      const applied = applyConversionConfig(
        paths.configDir,
        conversion ?? previewConversion({ configDir: paths.configDir }),
        journal.resolutions,
      );
      const note = `config: wrote ${applied.configPath} and recorded choices at ${applied.choicesPath}`;
      if (!journal.notes.includes(note)) journal.notes.push(note);
      finish("configuration");
    } catch (error) {
      return fail("configuration", error);
    }
  }

  for (const host of journal.hosts) {
    const step = `host:${host}`;
    if (completed(step)) continue;
    try {
      begin(step);
      const before = new Set(journal.notes);
      if (!applyHostCutover(host, paths, journal.notes)) {
        journal.phase = "partial";
        journal.currentStep = null;
        journal.error = `${host} requires a local dev installation before activation`;
        writeCutoverJournal(journal, paths.stateDir);
        continue;
      }
      journal.appliedHosts.push(host);
      journal.notes = [...before, ...journal.notes.filter((note) => !before.has(note))];
      finish(step);
    } catch (error) {
      return fail(step, error);
    }
  }

  const partial = journal.appliedHosts.length !== journal.hosts.length;
  if (!partial && !completed("generation")) {
    try {
      begin("generation");
      writeGenerationState(paths.configDir, {
        target: "v1",
        cutover: { backupId: journal.backupId, planId: journal.planId, at: journal.startedAt },
      });
      finish("generation");
    } catch (error) {
      return fail("generation", error);
    }
  }

  const backupTargets = cutoverBackupTargets(paths, journal.hosts);
  const postCutoverInventory = expandBackupTargets(backupTargets);
  if (postCutoverInventory.issues.length > 0) {
    return fail("verification", postCutoverInventory.issues.join("; "));
  }
  const managedFiles: CutoverReceipt["managedFiles"] = [];
  for (const file of postCutoverInventory.files) {
    const installedDigest = digestFile(file);
    if (installedDigest === null) return fail("verification", `cannot verify ${file}`);
    managedFiles.push({ path: file, installedDigest });
  }

  const receipt: CutoverReceipt = {
    backupId: journal.backupId,
    archiveDir: journal.archiveDir,
    planId: journal.planId,
    generation: partial ? "legacy" : "v1",
    hosts: [...journal.appliedHosts],
    managedFiles,
    partial,
    notes: [...journal.notes],
  };
  try {
    begin("receipt");
    writeReceipt(receipt, paths.stateDir);
    journal.phase = partial ? "partial" : "complete";
    journal.currentStep = null;
    journal.error = partial ? journal.error : null;
    finish("receipt");
    return success(null, null, receipt);
  } catch (error) {
    return fail("receipt", error);
  }
};

export function resumeCutover(backupId: Id, options: CutoverPaths = {}): Result<CutoverReceipt> {
  if (!validCutoverId(backupId))
    return failure("not_found", `cutover journal not found: ${backupId}`);
  const paths = resolvePaths(options);
  const journal = readCutoverJournal(backupId, paths.stateDir);
  if (!journal) return failure("not_found", `cutover journal not found: ${backupId}`);
  if (journal.phase === "complete") {
    const receipt = readCutoverReceipt(backupId, paths.stateDir);
    return receipt
      ? success(null, null, receipt)
      : failure("requirements_unsatisfied", `cutover receipt is missing: ${backupId}`);
  }
  return runCutoverJournal(journal, paths);
}

export function previewRollback(backupId: Id, options: CutoverPaths = {}): RollbackPreview {
  const paths = resolvePaths(options);
  if (!validCutoverId(backupId)) {
    return {
      backupId,
      restorable: [],
      conflicts: [],
      preserved: [],
      issues: ["invalid cutover backup id"],
    };
  }
  const receipt = readCutoverReceipt(backupId, paths.stateDir);
  const restorable: RollbackPreview["restorable"] = [];
  const conflicts: RollbackPreview["conflicts"] = [];
  const preserved: string[] = [];
  const issues: string[] = [];

  if (
    !receipt ||
    receipt.backupId !== backupId ||
    typeof receipt.archiveDir !== "string" ||
    !path.isAbsolute(receipt.archiveDir) ||
    path.resolve(receipt.archiveDir) !== receipt.archiveDir
  ) {
    return {
      backupId,
      restorable,
      conflicts,
      preserved,
      issues: ["cutover receipt or archive destination is missing"],
    };
  }
  const archiveError = archiveDestinationError(receipt.archiveDir, paths);
  if (archiveError) {
    return { backupId, restorable, conflicts, preserved, issues: [archiveError] };
  }
  const root = backupRoot(receipt.archiveDir, backupId);

  if (!existsSync(root)) {
    return { backupId, restorable, conflicts, preserved, issues: ["backup directory is missing"] };
  }
  if (!receipt) {
    return {
      backupId,
      restorable,
      conflicts,
      preserved,
      issues: ["cutover receipt is missing or unreadable"],
    };
  }
  const backup = readBackupFiles(backupId, receipt.archiveDir, paths);
  issues.push(...backup.issues);

  const seen = new Set<string>();
  for (const entry of receipt.managedFiles) {
    if (
      !path.isAbsolute(entry.path) ||
      path.resolve(entry.path) !== entry.path ||
      seen.has(entry.path)
    ) {
      issues.push(`receipt contains an invalid or duplicate path: ${entry.path}`);
      continue;
    }
    seen.add(entry.path);
    const current = digestFile(entry.path);
    const original = backup.files.get(entry.path);
    if (current === null) {
      if (original || lstatOrNull(entry.path)) {
        conflicts.push({
          path: entry.path,
          currentDigest: null,
          installedDigest: entry.installedDigest,
        });
      }
      continue;
    }
    if (current === entry.installedDigest) {
      restorable.push({
        path: entry.path,
        currentDigest: current,
        installedDigest: entry.installedDigest,
        restore: original ? "backup" : "remove",
      });
    } else if (original && current === original.digest) {
      // A previous rollback attempt already restored this file.
      continue;
    } else {
      conflicts.push({
        path: entry.path,
        currentDigest: current,
        installedDigest: entry.installedDigest,
      });
    }
  }

  const v1Task = path.join(paths.workspace, ".workit");
  if (existsSync(v1Task)) preserved.push(v1Task);

  return { backupId, restorable, conflicts, preserved, issues };
}

export function applyRollback(
  backupId: Id,
  options: CutoverPaths = {},
): Result<{ restored: string[] }> {
  if (!validCutoverId(backupId)) return failure("not_found", `backup not found: ${backupId}`);
  const paths = resolvePaths(options);
  const preview = previewRollback(backupId, options);
  if (preview.issues.length > 0) {
    return failure("recovery_required", "rollback backup failed integrity checks", {
      path: paths.stateDir,
      guidance: preview.issues.join("; "),
    });
  }
  if (preview.conflicts.length > 0) {
    return failure(
      "revision_conflict",
      "managed files changed after cutover; reconcile before rollback",
      {
        path: preview.conflicts[0]?.path,
      },
    );
  }

  const receipt = readCutoverReceipt(backupId, paths.stateDir);
  if (!receipt) return failure("not_found", `backup not found: ${backupId}`);
  const root = backupRoot(receipt.archiveDir, backupId);
  if (!existsSync(root)) return failure("not_found", `backup not found: ${backupId}`);
  const backup = readBackupFiles(backupId, receipt.archiveDir, paths);
  if (backup.issues.length > 0) {
    return failure("recovery_required", "rollback backup failed integrity checks", {
      path: root,
      guidance: backup.issues.join("; "),
    });
  }

  const restored: string[] = [];
  for (const entry of preview.restorable) {
    if (digestFile(entry.path) !== entry.currentDigest) {
      return failure("revision_conflict", "managed file changed during rollback", {
        path: entry.path,
      });
    }
    if (entry.restore === "remove") {
      unlinkSync(entry.path);
      restored.push(entry.path);
      continue;
    }
    const original = backup.files.get(entry.path);
    if (!original) {
      return failure("recovery_required", "verified rollback content is missing", {
        path: entry.path,
      });
    }
    const content = readFileSync(original.storagePath);
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== original.digest) {
      return failure("recovery_required", "rollback content changed during apply", {
        path: original.storagePath,
      });
    }
    writeFileAtomic(entry.path, content.toString("utf8"));
    if (digestFile(entry.path) !== original.digest) {
      return failure("storage_error", "restored file failed verification", { path: entry.path });
    }
    restored.push(entry.path);
  }

  writeGenerationState(paths.configDir, { target: "legacy" });
  return success(null, null, { restored });
}

export const countLegacyFlowRecords = (workspace: string): number =>
  legacyFlowFiles(workspace).length;

export const legacyFlowRecordDigests = (workspace: string): Digest[] =>
  legacyFlowFiles(workspace).map((f) => digestFile(f)!);

export { previewConversion };
