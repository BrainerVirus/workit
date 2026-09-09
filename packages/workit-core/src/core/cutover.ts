import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { failure, success, type Digest, type Id, type Result } from "./task-contract";
import { previewConversion, type ConversionPreview } from "./config-conversion";
import {
  CURSOR_RUNTIME_PACKAGE,
  cursorHooksEntry,
  cursorMcpServerEntry,
  isWorkitPlugin,
  mergeCursorMcp,
  mergeCursorSettings,
  mergeOpenCodeConfig,
} from "./registration";
import { WORKIT_METHOD_SKILLS } from "./skill-manifests";

export type CutoverHost = "opencode" | "cursor" | "codex" | "pi";

export type SessionObservation = {
  host: CutoverHost | "opencode" | "cursor";
  handle: string;
  state: "stopped" | "active" | "unknown";
};

export type CutoverPlan = {
  id: Id;
  managedFiles: { path: string; beforeDigest: Digest | null; afterDigest: Digest }[];
  sessions: SessionObservation[];
  unresolved: { key: string; reason: string }[];
  conversion: ConversionPreview;
  hosts: CutoverHost[];
  blocked: string[];
};

export type CutoverReceipt = {
  backupId: Id;
  planId: Id;
  generation: "v1";
  hosts: CutoverHost[];
  managedFiles: { path: string; installedDigest: Digest }[];
  partial: boolean;
  notes: string[];
};

export type CutoverDecision = {
  approve: true;
  hosts: CutoverHost[];
  resolutions?: Record<string, string>;
};

export type RollbackPreview = {
  backupId: Id;
  restorable: { path: string; currentDigest: Digest; installedDigest: Digest }[];
  conflicts: { path: string; currentDigest: Digest; installedDigest: Digest }[];
  preserved: string[];
};

export type CutoverPaths = {
  home?: string;
  configDir?: string;
  stateDir?: string;
  dev?: string;
  workspace?: string;
  opencodeConfig?: string;
  cursorSettings?: string;
  cursorMcp?: string;
  cursorPluginDir?: string;
  sessions?: SessionObservation[];
  env?: NodeJS.ProcessEnv;
};

export type GenerationState = {
  target: "legacy" | "v1";
  cutover?: { backupId: Id; planId: Id; at: string };
};

const GENERATION_FILE = "generation.json";

const resolvePaths = (options: CutoverPaths = {}) => {
  const home = options.home ?? options.env?.HOME ?? os.homedir();
  const configDir =
    options.configDir ??
    options.env?.WORKFLOW_TOOLKIT_CONFIG ??
    path.join(home, ".config", "workit");
  const stateDir =
    options.stateDir ?? options.env?.WORKFLOW_TOOLKIT_STATE ?? path.join(home, ".local", "state", "workit");
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
    sessions: options.sessions ?? [],
  };
};

export const digestFile = (file: string): Digest | null => {
  if (!existsSync(file)) return null;
  return createHash("sha256").update(readFileSync(file)).digest("hex");
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
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, GENERATION_FILE), JSON.stringify(state, null, 2) + "\n");
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
      const hasLegacyPin = plugins.some(
        (p: unknown) =>
          String(p).includes("workflow-toolkit") || String(p).includes("/assets/commands/wk-"),
      );
      const hasWorkit = plugins.some((p: unknown) => isWorkitPlugin(p));
      const devAssets =
        paths.dev &&
        existsSync(path.join(paths.dev, "packages/workit-opencode/assets/commands/wk-init.md"));
      const legacy = hasLegacyPin || Boolean(devAssets);
      const v1 = hasWorkit && paths.dev && existsSync(path.join(paths.dev, "packages/workit-opencode/dist/plugin.js"));
      if (legacy && v1) return "mixed";
      if (v1) return "v1";
      if (legacy || hasWorkit) return "legacy";
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
    const piConfig = path.join(paths.home, ".pi", "config.json");
    if (!existsSync(piConfig)) return "none";
    try {
      const cfg = JSON.parse(readFileSync(piConfig, "utf8"));
      const exts = cfg?.extensions ?? cfg?.pi?.extensions ?? [];
      const has = (Array.isArray(exts) ? exts : []).some((e: unknown) => String(e).includes("workit"));
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
      server.args[2] === `--package=${CURSOR_RUNTIME_PACKAGE}` &&
      server.args[3] === "workit-cursor-mcp"
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
  paths.opencodeConfig,
  paths.cursorSettings,
  paths.cursorMcp,
  path.join(paths.cursorPluginDir, "hooks", "hooks-cursor.json"),
];

const backupRoot = (stateDir: string, backupId: Id) => path.join(stateDir, "cutover", "backups", backupId);

const backupRelPath = (file: string, paths: ReturnType<typeof resolvePaths>): string => {
  if (file.startsWith(paths.configDir + path.sep) || file === paths.configDir) {
    return path.join("config", path.relative(paths.configDir, file));
  }
  return path.join("home", path.relative(paths.home, file));
};

const writeBackup = (backupId: Id, paths: ReturnType<typeof resolvePaths>, files: string[]): void => {
  const root = backupRoot(paths.stateDir, backupId);
  mkdirSync(root, { recursive: true });
  const manifest: CutoverReceipt["managedFiles"] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const dest = path.join(root, backupRelPath(file, paths));
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(file, dest);
    manifest.push({ path: file, installedDigest: digestFile(file)! });
  }
  writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ backupId, files: manifest }, null, 2) + "\n");
};

const receiptPath = (stateDir: string, backupId: Id) =>
  path.join(stateDir, "cutover", "receipts", `${backupId}.json`);

const writeReceipt = (receipt: CutoverReceipt, stateDir: string): void => {
  mkdirSync(path.dirname(receiptPath(stateDir, receipt.backupId)), { recursive: true });
  writeFileSync(receiptPath(stateDir, receipt.backupId), JSON.stringify(receipt, null, 2) + "\n");
};

const readReceipt = (backupId: Id, stateDir: string): CutoverReceipt | null => {
  const file = receiptPath(stateDir, backupId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CutoverReceipt;
  } catch {
    return null;
  }
};

const plannedAfterDigest = (file: string, host: CutoverHost, paths: ReturnType<typeof resolvePaths>): Digest => {
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
  if (file.endsWith("hooks-cursor.json")) {
    const entry = cursorHooksEntry(paths.cursorPluginDir);
    const base = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, hooks: {} };
    const next = {
      ...base,
      hooks: { ...(base.hooks ?? {}), sessionStart: [{ command: entry.command }] },
    };
    return createHash("sha256").update(JSON.stringify(next)).digest("hex");
  }
  return createHash("sha256").update(readFileSync(file)).digest("hex");
};

export function previewCutover(options: CutoverPaths = {}, hosts: CutoverHost[] = ["opencode", "cursor"]): CutoverPlan {
  const paths = resolvePaths(options);
  const conversion = previewConversion({ configDir: paths.configDir });
  const blocked: string[] = [];
  const unresolved = [...conversion.unresolved];

  for (const host of hosts) {
    const gen = classifyHostGeneration(host, paths);
    if (gen === "mixed") blocked.push(`${host}: mixed legacy and v1 components`);
  }

  for (const session of paths.sessions) {
    if (session.state === "active" || session.state === "unknown") {
      blocked.push(`${session.host} session ${session.handle} is ${session.state}`);
    }
  }

  const managedFiles = managedCutoverFiles(paths).map((filePath) => ({
    path: filePath,
    beforeDigest: digestFile(filePath),
    afterDigest: existsSync(filePath)
      ? plannedAfterDigest(filePath, hosts[0] ?? "cursor", paths)
      : createHash("sha256").update("").digest("hex"),
  }));

  return {
    id: randomUUID(),
    managedFiles,
    sessions: paths.sessions,
    unresolved,
    conversion,
    hosts,
    blocked,
  };
}

const syncV1CursorSkills = (pluginDir: string, dev: string | null) => {
  mkdirSync(path.join(pluginDir, "skills"), { recursive: true });
  for (const skill of WORKIT_METHOD_SKILLS) {
    const src = dev
      ? path.join(dev, "packages/workit-cursor/skills", skill, "SKILL.md")
      : null;
    const destDir = path.join(pluginDir, "skills", skill);
    mkdirSync(destDir, { recursive: true });
    writeFileSync(path.join(destDir, "SKILL.md"), src && existsSync(src) ? readFileSync(src, "utf8") : "# v1\n");
  }
  for (const name of readdirSync(path.join(pluginDir, "skills"))) {
    if (name.startsWith("wk-")) rmSync(path.join(pluginDir, "skills", name), { recursive: true, force: true });
  }
  const vendor = path.join(pluginDir, "vendor");
  if (existsSync(vendor)) rmSync(vendor, { recursive: true, force: true });
};

const applyHostCutover = (
  host: CutoverHost,
  paths: ReturnType<typeof resolvePaths>,
  notes: string[],
): boolean => {
  if (host === "cursor") {
    syncV1CursorSkills(paths.cursorPluginDir, paths.dev);
    const settings = existsSync(paths.cursorSettings)
      ? JSON.parse(readFileSync(paths.cursorSettings, "utf8"))
      : {};
    writeFileSync(
      paths.cursorSettings,
      JSON.stringify(mergeCursorSettings(settings, paths.cursorPluginDir).config, null, 2) + "\n",
    );
    const mcp = existsSync(paths.cursorMcp)
      ? JSON.parse(readFileSync(paths.cursorMcp, "utf8"))
      : { mcpServers: {} };
    writeFileSync(
      paths.cursorMcp,
      JSON.stringify(
        mergeCursorMcp(mcp, "workit", cursorMcpServerEntry(paths.cursorPluginDir)).config,
        null,
        2,
      ) + "\n",
    );
    const hooksPath = path.join(paths.cursorPluginDir, "hooks", "hooks-cursor.json");
    const hooks = existsSync(hooksPath) ? JSON.parse(readFileSync(hooksPath, "utf8")) : { version: 1, hooks: {} };
    const entry = cursorHooksEntry(paths.cursorPluginDir);
    writeFileSync(
      hooksPath,
      JSON.stringify(
        { ...hooks, hooks: { ...(hooks.hooks ?? {}), sessionStart: [{ command: entry.command }] } },
        null,
        2,
      ) + "\n",
    );
    notes.push("cursor: replaced legacy skills with v1 method skills and canonical @latest registration");
    return true;
  }
  if (host === "opencode" && paths.dev) {
    const pin = `file://${paths.dev}/packages/workit-opencode/dist/plugin.js`;
    const distDir = path.join(paths.dev, "packages/workit-opencode/dist");
    mkdirSync(distDir, { recursive: true });
    const dist = path.join(distDir, "plugin.js");
    if (!existsSync(dist)) writeFileSync(dist, "export default {};\n");
    const current = existsSync(paths.opencodeConfig)
      ? JSON.parse(readFileSync(paths.opencodeConfig, "utf8"))
      : {};
    writeFileSync(
      paths.opencodeConfig,
      JSON.stringify(mergeOpenCodeConfig(current, pin).config, null, 2) + "\n",
    );
    notes.push("opencode: repinned to v1 dist entry");
    return true;
  }
  if (host === "codex" && paths.dev) {
    const pluginDir = path.join(paths.home, ".codex", "plugins", "workit");
    mkdirSync(pluginDir, { recursive: true });
    cpSync(path.join(paths.dev, "packages/workit-codex/.codex-plugin"), path.join(pluginDir, ".codex-plugin"), {
      recursive: true,
    });
    notes.push("codex: installed v1 plugin scaffold");
    return true;
  }
  if (host === "pi" && paths.dev) {
    const piConfig = path.join(paths.home, ".pi", "config.json");
    mkdirSync(path.dirname(piConfig), { recursive: true });
    const current = existsSync(piConfig) ? JSON.parse(readFileSync(piConfig, "utf8")) : {};
    const next = {
      ...current,
      extensions: [`${path.join(paths.dev, "packages/workit-pi/dist/workit.js")}`],
      skills: [`${path.join(paths.dev, "packages/workit-pi/skills")}`],
    };
    writeFileSync(piConfig, JSON.stringify(next, null, 2) + "\n");
    notes.push("pi: registered v1 extension and skills");
    return true;
  }
  return false;
};

export function applyCutover(plan: CutoverPlan, decision: CutoverDecision, options: CutoverPaths = {}): Result<CutoverReceipt> {
  if (!decision.approve) return failure("permission_denied", "cutover not approved");
  if (plan.blocked.length > 0) {
    return failure("requirements_unsatisfied", "cutover blocked", { fields: plan.blocked.map((b) => ({ path: b, reason: "blocked" })) });
  }
  for (const item of plan.unresolved) {
    if (!decision.resolutions?.[item.key]) {
      return failure("needs_input", `unresolved setting requires a decision: ${item.key}`);
    }
  }

  const paths = resolvePaths(options);
  for (const entry of plan.managedFiles) {
    const current = digestFile(entry.path);
    if (entry.beforeDigest !== null && current !== entry.beforeDigest) {
      return failure("revision_conflict", `managed file changed since preview: ${entry.path}`, { path: entry.path });
    }
  }
  for (const session of plan.sessions) {
    if (session.state === "active" || session.state === "unknown") {
      return failure("requirements_unsatisfied", `old session still ${session.state}: ${session.handle}`);
    }
  }

  const backupId = randomUUID();
  const files = managedCutoverFiles(paths);
  writeBackup(backupId, paths, files);

  const notes: string[] = [];
  let partial = false;
  const applied: CutoverHost[] = [];
  for (const host of decision.hosts) {
    const ok = applyHostCutover(host, paths, notes);
    if (ok) applied.push(host);
    else partial = true;
  }

  writeGenerationState(paths.configDir, {
    target: "v1",
    cutover: { backupId, planId: plan.id, at: new Date().toISOString() },
  });

  const managedFiles = files
    .filter((f) => existsSync(f))
    .map((f) => ({ path: f, installedDigest: digestFile(f)! }));

  const receipt: CutoverReceipt = {
    backupId,
    planId: plan.id,
    generation: "v1",
    hosts: applied,
    managedFiles,
    partial,
    notes,
  };
  writeReceipt(receipt, paths.stateDir);

  return success(null, null, receipt);
}

export function previewRollback(backupId: Id, options: CutoverPaths = {}): RollbackPreview {
  const paths = resolvePaths(options);
  const root = backupRoot(paths.stateDir, backupId);
  const receipt = readReceipt(backupId, paths.stateDir);
  const restorable: RollbackPreview["restorable"] = [];
  const conflicts: RollbackPreview["conflicts"] = [];
  const preserved: string[] = [];

  if (!existsSync(root) || !receipt) return { backupId, restorable, conflicts, preserved };

  for (const entry of receipt.managedFiles) {
    const current = digestFile(entry.path);
    if (current === null) continue;
    if (current === entry.installedDigest) {
      restorable.push({ path: entry.path, currentDigest: current, installedDigest: entry.installedDigest });
    } else {
      conflicts.push({ path: entry.path, currentDigest: current, installedDigest: entry.installedDigest });
    }
  }

  const v1Task = path.join(paths.workspace, ".workit");
  if (existsSync(v1Task)) preserved.push(v1Task);

  return { backupId, restorable, conflicts, preserved };
}

export function applyRollback(backupId: Id, options: CutoverPaths = {}): Result<{ restored: string[] }> {
  const paths = resolvePaths(options);
  const preview = previewRollback(backupId, options);
  if (preview.conflicts.length > 0) {
    return failure("revision_conflict", "managed files changed after cutover; reconcile before rollback", {
      path: preview.conflicts[0]?.path,
    });
  }

  const root = backupRoot(paths.stateDir, backupId);
  if (!existsSync(root)) return failure("not_found", `backup not found: ${backupId}`);

  const restored: string[] = [];
  for (const entry of preview.restorable) {
    const src = path.join(root, backupRelPath(entry.path, paths));
    if (!existsSync(src)) continue;
    mkdirSync(path.dirname(entry.path), { recursive: true });
    cpSync(src, entry.path);
    restored.push(entry.path);
  }

  writeGenerationState(paths.configDir, { target: "legacy" });
  return success(null, null, { restored });
}

export const countLegacyFlowRecords = (workspace: string): number => legacyFlowFiles(workspace).length;

export const legacyFlowRecordDigests = (workspace: string): Digest[] =>
  legacyFlowFiles(workspace).map((f) => digestFile(f)!);

export { previewConversion };
