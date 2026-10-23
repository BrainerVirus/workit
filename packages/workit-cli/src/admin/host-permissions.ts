// Managed host permissions (issue #297, decision mvk5q3io). Plugins cannot
// ship permission rules, so `workit setup` (and `workit upgrade`, for a block
// already there) writes a Workit-owned, reversible block into each host's own
// config after one consent that shows the exact diff:
//   - Claude Code: enumerated `Bash(workit <verb> *)` allows, `ask` rules for
//     Workit's bypass flags, one `autoMode.environment` and one
//     `autoMode.allow` line, and `env.CLAUDE_CODE_SHELL` (zsh users only);
//   - Codex: `rules/workit.rules`, a file Workit owns;
//   - Cursor: enumerated `Shell(workit <verb>)` in `~/.cursor/cli-config.json`.
// OpenCode needs no write (its plugin turns an ask into an allow) and Pi has
// no permission layer. Never: `workit check -- …`, `workit lock run -- …`,
// `workit grant …`, or any verb outside WORKIT_ALLOWED_VERBS.
//
// The merges are pure (input record in, record and added entries out), the
// entries Workit added are recorded in its state dir so uninstall removes
// exactly those, and apply refuses a file that changed since the preview.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateDir as workitStateDir } from "@brainervirus/workit-core/src/core/heavy-words";
import { writeFileAtomic } from "@brainervirus/workit-core/src/core/safe-write";
import { WORKIT_ALLOWED_VERBS } from "@brainervirus/workit-core/src/hooks/delivery-verbs";
import { claudeConfigDir } from "./host-install";

export type PermissionHost = "claude-code" | "codex" | "cursor";
const PERMISSION_HOSTS: ReadonlySet<string> = new Set<PermissionHost>([
  "claude-code",
  "codex",
  "cursor",
]);

export const CLAUDE_ALLOW: readonly string[] = [
  ...WORKIT_ALLOWED_VERBS.map((verb) => `Bash(workit ${verb} *)`),
  "Bash(workit --version)",
];
// Ask beats allow, so a bypass flag still reaches the user (also in auto mode).
export const CLAUDE_ASK: readonly string[] = [
  "Bash(workit * --unverified*)",
  "Bash(workit * --overwrite-unintegrated*)",
];
const AUTO_MODE_ENVIRONMENT =
  "Org-specific CLIs: workit — the user's delivery CLI. Its push, pr merge, release and PR-thread verbs run only under per-workspace grants and non-author verdicts the user configured in ~/.config/workit, outside the agent's reach.";
const AUTO_MODE_ALLOW =
  "Workit-gated delivery: `workit pr merge`, `workit git push --force-with-lease` on the session's own branch, `workit release` and `workit pr reply/resolve` on the session's repo are authorized by the user's standing Workit grants; not Merge Without Review, Git Destructive or External System Writes. Does NOT cover `--unverified`, `--admin` or any bypass flag.";
const DEFAULTS = "$defaults";

export const CURSOR_ALLOW: readonly string[] = [
  ...WORKIT_ALLOWED_VERBS.map((verb) => `Shell(workit ${verb})`),
  "Shell(workit --version)",
];

const CODEX_HEADER =
  "# Workit-owned: written by `workit setup`, removed by `workit uninstall`.\n" +
  "# Workit's own grants, verdict gates and branch policy decide these verbs.\n" +
  "# Run them as `workit <verb> --cwd <dir>`: a rule cannot match a directory before the verb.\n";

/** The Codex rules file: one flat `prefix_rule` per verb (Workit's heavy gate reads flat patterns). */
export const codexRulesText = (): string => {
  const rules = [...WORKIT_ALLOWED_VERBS, "--version"].map((verb) => {
    const examples =
      verb === "git"
        ? `\n    match = [["workit", "git", "push", "--cwd", "/w"]],\n    not_match = [["workit", "check", "--", "git"], ["workit", "--cwd", "/w", "git"]],`
        : "";
    return `prefix_rule(\n    pattern = ["workit", "${verb}"],\n    decision = "allow",\n    justification = "Workit verb: Workit's grants, verdict gates and branch policy decide",${examples}\n)\n`;
  });
  const grant = `prefix_rule(\n    pattern = ["workit", "grant"],\n    decision = "prompt",\n    justification = "Changing Workit grants needs the user",\n)\n`;
  return `${CODEX_HEADER}\n${[...rules, grant].join("\n")}`;
};

// ---------------------------------------------------------------------------
// Pure merges and removals
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** What Workit added to one host's config, so uninstall removes only that. */
export type OwnedEntries = {
  /** Dotted array paths → the entries Workit appended there. */
  lists: Record<string, string[]>;
  /** Dotted paths of objects or arrays Workit created. */
  created: string[];
  /** env keys Workit set, with the value it wrote. */
  env: Record<string, string>;
};

const emptyOwned = (): OwnedEntries => ({ lists: {}, created: [], env: {} });

/** Deep copy of a JSON record, so a merge never aliases its input. */
const clone = <T>(value: T): T => structuredClone(value);

/** The object at `keys`, created when missing (recorded in `owned.created`). */
const objectAt = (root: Json, keys: string[], owned: OwnedEntries): Json | null => {
  let node = root;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (node[key] === undefined) {
      node[key] = {};
      owned.created.push(keys.slice(0, i + 1).join("."));
    }
    const next = node[key];
    if (!isRecord(next)) return null;
    node = next;
  }
  return node;
};

/** Entries to leave out of a merge: per dotted path, the entries an earlier write offered. */
type Skip = Record<string, readonly string[]>;

/** Append the missing `entries` to the array at `dotted`; a new array starts with `seed`. */
const appendList = (
  root: Json,
  dotted: string,
  entries: readonly string[],
  owned: OwnedEntries,
  seed: readonly string[] = [],
  skip: Skip = {},
): string | null => {
  const skipped = new Set(skip[dotted] ?? []);
  const wanted = entries.filter((entry) => !skipped.has(entry));
  if (wanted.length === 0) return null;
  const keys = dotted.split(".");
  const parent = objectAt(root, keys.slice(0, -1), owned);
  const leaf = keys.at(-1)!;
  if (!parent) return `${keys.slice(0, -1).join(".")} is not an object`;
  if (parent[leaf] === undefined) {
    parent[leaf] = [...seed];
    owned.created.push(dotted);
  }
  const list = parent[leaf];
  if (!Array.isArray(list)) return `${dotted} is not a list`;
  const present = new Set<unknown>(list);
  for (const entry of wanted)
    if (!present.has(entry)) {
      list.push(entry);
      present.add(entry);
      (owned.lists[dotted] ??= []).push(entry);
    }
  return null;
};

type HostMerge = { config: Json; owned: OwnedEntries; error?: string };

/**
 * Claude Code user settings with Workit's block. `shell` (a bash path) is set
 * as `env.CLAUDE_CODE_SHELL` only when no value is set; `skip` leaves out the
 * entries an earlier write offered (the upgrade refresh).
 */
function mergeClaudeSettings(settings: Json, shell: string | null, skip: Skip = {}): HostMerge {
  const config = clone(settings);
  const owned = emptyOwned();
  const error =
    appendList(config, "permissions.allow", CLAUDE_ALLOW, owned, [], skip) ??
    appendList(config, "permissions.ask", CLAUDE_ASK, owned, [], skip) ??
    appendList(config, "autoMode.environment", [AUTO_MODE_ENVIRONMENT], owned, [DEFAULTS], skip) ??
    appendList(config, "autoMode.allow", [AUTO_MODE_ALLOW], owned, [DEFAULTS], skip);
  if (error) return { config: settings, owned: emptyOwned(), error };
  if (shell) {
    const env = objectAt(config, ["env"], owned);
    if (!env) return { config: settings, owned: emptyOwned(), error: "env is not an object" };
    if (env.CLAUDE_CODE_SHELL === undefined) {
      env.CLAUDE_CODE_SHELL = shell;
      owned.env.CLAUDE_CODE_SHELL = shell;
    }
  }
  return { config, owned };
}

/** Cursor CLI config with Workit's `Shell(workit <verb>)` allows. */
function mergeCursorCliConfig(config: Json, skip: Skip = {}): HostMerge {
  const next = clone(config);
  const owned = emptyOwned();
  const error = appendList(next, "permissions.allow", CURSOR_ALLOW, owned, [], skip);
  return error ? { config, owned: emptyOwned(), error } : { config: next, owned };
}

/** The canonical entries per list, for a host with no ownership record. */
const CANONICAL: Record<"claude-code" | "cursor", OwnedEntries> = {
  "claude-code": {
    lists: {
      "permissions.allow": [...CLAUDE_ALLOW],
      "permissions.ask": [...CLAUDE_ASK],
      "autoMode.environment": [AUTO_MODE_ENVIRONMENT],
      "autoMode.allow": [AUTO_MODE_ALLOW],
    },
    created: [],
    env: {},
  },
  cursor: { lists: { "permissions.allow": [...CURSOR_ALLOW] }, created: [], env: {} },
};

const valueAt = (root: Json, dotted: string): { parent: Json; key: string } | null => {
  const keys = dotted.split(".");
  let node: unknown = root;
  for (const key of keys.slice(0, -1)) {
    if (!isRecord(node)) return null;
    node = node[key];
  }
  return isRecord(node) ? { parent: node, key: keys.at(-1)! } : null;
};

/** The shape of every entry Workit writes at a dotted path, per host. */
const ENTRY_SHAPES: Record<"claude-code" | "cursor", Record<string, (entry: string) => boolean>> = {
  "claude-code": {
    "permissions.allow": (entry) => entry.startsWith("Bash(workit "),
    "permissions.ask": (entry) => entry.startsWith("Bash(workit "),
    "autoMode.environment": (entry) => entry.startsWith("Org-specific CLIs: workit "),
    "autoMode.allow": (entry) => entry.startsWith("Workit-gated delivery: "),
  },
  cursor: { "permissions.allow": (entry) => entry.startsWith("Shell(workit ") },
};

/** The containers a merge may create, per host. */
const CREATED_PATHS: Record<"claude-code" | "cursor", ReadonlySet<string>> = {
  "claude-code": new Set([
    "permissions",
    "permissions.allow",
    "permissions.ask",
    "autoMode",
    "autoMode.environment",
    "autoMode.allow",
    "env",
  ]),
  cursor: new Set(["permissions", "permissions.allow"]),
};

/** A bash path, as `findBash` writes it. */
const isBashPath = (value: unknown): value is string =>
  typeof value === "string" && path.isAbsolute(value) && path.basename(value) === "bash";

/**
 * An ownership record cut down to what Workit could have written: its own
 * list paths with entries of its own shapes, `CLAUDE_CODE_SHELL` only as a
 * bash path, and its own containers. A stale or edited record never makes
 * uninstall remove a user's entry.
 */
const trustedOwned = (owned: OwnedEntries, host: "claude-code" | "cursor"): OwnedEntries => {
  const shapes = ENTRY_SHAPES[host];
  const lists: Record<string, string[]> = {};
  for (const [dotted, entries] of Object.entries(isRecord(owned.lists) ? owned.lists : {})) {
    const shape = Object.hasOwn(shapes, dotted) ? shapes[dotted] : undefined;
    if (!shape || !Array.isArray(entries)) continue;
    lists[dotted] = entries.filter((entry) => typeof entry === "string" && shape(entry));
  }
  const shell = isRecord(owned.env) ? owned.env.CLAUDE_CODE_SHELL : undefined;
  return {
    lists,
    created: (Array.isArray(owned.created) ? owned.created : []).filter((dotted) =>
      CREATED_PATHS[host].has(dotted),
    ),
    env: host === "claude-code" && isBashPath(shell) ? { CLAUDE_CODE_SHELL: shell } : {},
  };
};

/**
 * The inverse of a merge: drop the entries `owned` names, the env values it
 * set (when unchanged), and the containers it created once they hold nothing
 * but their seed. Without a record, the canonical entries are dropped; with
 * one, only its entries shaped like Workit's (`trustedOwned`).
 */
export function removeOwnedEntries(
  config: Json,
  owned: OwnedEntries | null,
  host: "claude-code" | "cursor",
): { next: Json; changed: boolean } {
  const next = clone(config);
  const record = owned ? trustedOwned(owned, host) : CANONICAL[host];
  let changed = false;
  for (const [dotted, entries] of Object.entries(record.lists)) {
    const at = valueAt(next, dotted);
    const list = at?.parent[at.key];
    if (!at || !Array.isArray(list)) continue;
    const drop = new Set<unknown>(entries);
    const kept = list.filter((entry) => !drop.has(entry));
    if (kept.length !== list.length) {
      at.parent[at.key] = kept;
      changed = true;
    }
  }
  const env = next.env;
  if (isRecord(env))
    for (const [key, value] of Object.entries(record.env))
      if (env[key] === value) {
        delete env[key];
        changed = true;
      }
  const created = record.created.toSorted((a, b) => b.split(".").length - a.split(".").length);
  for (const dotted of created) {
    const at = valueAt(next, dotted);
    const value = at?.parent[at.key];
    if (!at || value === undefined) continue;
    const empty = Array.isArray(value)
      ? value.every((entry) => entry === DEFAULTS)
      : isRecord(value) && Object.keys(value).length === 0;
    if (empty) {
      delete at.parent[at.key];
      changed = true;
    }
  }
  return { next, changed };
}

/** Workit entries missing from a host config (empty when the block is whole). */
function missingEntries(config: Json, host: "claude-code" | "cursor"): string[] {
  const missing: string[] = [];
  for (const [dotted, entries] of Object.entries(CANONICAL[host].lists)) {
    const at = valueAt(config, dotted);
    const list = at?.parent[at.key];
    const present = new Set<unknown>(Array.isArray(list) ? list : []);
    for (const entry of entries) if (!present.has(entry)) missing.push(`${dotted}: ${entry}`);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Paths, agent sessions, the ownership record
// ---------------------------------------------------------------------------

export type PermissionPaths = { home?: string; env?: NodeJS.ProcessEnv; stateDir?: string };

type ResolvedPaths = { home: string; env: NodeJS.ProcessEnv; stateDir: string };

const resolvePaths = (options: PermissionPaths): ResolvedPaths => {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? os.homedir();
  return { home, env, stateDir: options.stateDir ?? workitStateDir({ ...env, HOME: home }) };
};

/** The file Workit edits for `host`, and the directory whose presence means the host is there. */
export const permissionTarget = (
  host: PermissionHost,
  options: PermissionPaths = {},
): { file: string; hostDir: string } => {
  const { home, env } = resolvePaths(options);
  if (host === "claude-code") {
    const dir = claudeConfigDir(home, env);
    return { file: path.join(dir, "settings.json"), hostDir: dir };
  }
  if (host === "codex") {
    const dir = env.CODEX_HOME || path.join(home, ".codex");
    return { file: path.join(dir, "rules", "workit.rules"), hostDir: dir };
  }
  const dir = path.join(home, ".cursor");
  return { file: path.join(dir, "cli-config.json"), hostDir: dir };
};

const AGENT_SESSION_VARS = [
  "CLAUDECODE",
  "WORKIT_SESSION_ID",
  "CODEX_THREAD_ID",
  "OPENCODE_SESSION_ID",
  "PI_SESSION_ID",
  "CURSOR_AGENT",
] as const;

/** The variable showing this process runs inside an agent session, or null. */
const agentSessionVar = (env: NodeJS.ProcessEnv): string | null =>
  AGENT_SESSION_VARS.find((name) => (env[name] ?? "") !== "") ?? null;

type HostRecord = {
  file: string;
  owned: OwnedEntries;
  /** Every entry a Workit version offered per dotted path, added or already there. */
  offered?: Record<string, string[]>;
};

type OwnershipRecord = {
  version: 1;
  hosts: Partial<Record<PermissionHost, HostRecord>>;
};

const RECORD_FILE = "host-permissions.json";

export const readOwnership = (options: PermissionPaths = {}): OwnershipRecord => {
  const { stateDir } = resolvePaths(options);
  try {
    const value = JSON.parse(readFileSync(path.join(stateDir, RECORD_FILE), "utf8")) as unknown;
    if (isRecord(value) && isRecord(value.hosts)) return { version: 1, hosts: value.hosts };
  } catch {
    // Missing or unreadable: no record, canonical entries apply.
  }
  return { version: 1, hosts: {} };
};

const writeOwnership = (record: OwnershipRecord, stateDir: string): void => {
  mkdirSync(stateDir, { recursive: true });
  writeFileAtomic(path.join(stateDir, RECORD_FILE), JSON.stringify(record, null, 2) + "\n", 0o600);
};

const unionLists = (
  a: Record<string, string[]> | undefined,
  b: Record<string, readonly string[]>,
): Record<string, string[]> => {
  const lists: Record<string, string[]> = { ...a };
  for (const [key, entries] of Object.entries(b))
    lists[key] = [...new Set([...(lists[key] ?? []), ...entries])];
  return lists;
};

const unionOwned = (a: OwnedEntries | undefined, b: OwnedEntries): OwnedEntries => {
  return {
    lists: unionLists(a?.lists, b.lists),
    created: [...new Set([...(a?.created ?? []), ...b.created])],
    env: { ...a?.env, ...b.env },
  };
};

/** Forget what Workit added for `host` (after uninstall removed it). */
export const forgetOwnership = (host: PermissionHost, options: PermissionPaths = {}): void => {
  const paths = resolvePaths(options);
  const record = readOwnership(paths);
  if (!record.hosts[host]) return;
  delete record.hosts[host];
  writeOwnership(record, paths.stateDir);
};

// ---------------------------------------------------------------------------
// Plan, diff, apply
// ---------------------------------------------------------------------------

export type PermissionChange = {
  host: PermissionHost;
  file: string;
  /** The file's text when previewed (null: absent); apply refuses any other. */
  before: string | null;
  after: string;
  owned: OwnedEntries;
  /** The entries this version offers, recorded so a refresh never re-adds a removed one. */
  offered: Record<string, string[]>;
};

export type PermissionPlan = {
  /** Set inside an agent session: the command the user must run instead. */
  refused?: string;
  changes: PermissionChange[];
  /** One line per host with nothing to write, and why. */
  notes: string[];
  /** Host files Workit cannot merge into (left untouched). */
  blocked: string[];
};

export type PlanOptions = PermissionPaths & {
  hosts: readonly string[];
  /** Set env.CLAUDE_CODE_SHELL for a zsh user (default true). */
  shell?: boolean;
  /** The bash to name (test seam; default the first of /usr/bin/bash, /bin/bash on PATH order). */
  bash?: string | null;
  /**
   * The upgrade refresh: only hosts whose block Workit already wrote, and
   * only entries new in this version (never one the user removed).
   */
  refreshOnly?: boolean;
};

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const findBash = (env: NodeJS.ProcessEnv): string | null => {
  const dirs = ["/usr/bin", "/bin", ...(env.PATH ?? "").split(path.delimiter).filter(Boolean)];
  for (const dir of dirs) {
    const candidate = path.join(dir, "bash");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
};

const setupCommand = (hosts: readonly string[]): string =>
  `workit setup --hosts=${hosts.join(",")}`;

export function planHostPermissions(options: PlanOptions): PermissionPlan {
  const paths = resolvePaths(options);
  const plan: PermissionPlan = { changes: [], notes: [], blocked: [] };
  const record = readOwnership(paths);
  const hosts = options.refreshOnly
    ? options.hosts.filter((h) => record.hosts[h as PermissionHost])
    : options.hosts;
  for (const host of hosts) {
    if (host === "opencode") {
      plan.notes.push("opencode: nothing to write; the Workit plugin allows its delivery verbs");
      continue;
    }
    if (host === "pi") {
      plan.notes.push("pi: nothing to write; Pi has no permission layer");
      continue;
    }
    if (!PERMISSION_HOSTS.has(host)) continue;
    const target = permissionTarget(host as PermissionHost, paths);
    if (!existsSync(target.hostDir)) {
      plan.notes.push(`${host}: not installed (${target.hostDir} is missing); nothing written`);
      continue;
    }
    const before = readText(target.file);
    let after: string;
    let owned: OwnedEntries;
    let offered: Record<string, string[]> = {};
    if (host === "codex") {
      after = codexRulesText();
      owned = emptyOwned();
    } else {
      const previous = record.hosts[host as PermissionHost];
      // A record without `offered` (written before it existed): what Workit added stands in.
      const skip: Skip = options.refreshOnly
        ? (previous?.offered ?? previous?.owned.lists ?? {})
        : {};
      let parsed: unknown = {};
      try {
        parsed = before === null || before.trim() === "" ? {} : JSON.parse(before);
      } catch {
        plan.blocked.push(`${target.file} is not valid JSON; left untouched`);
        continue;
      }
      if (!isRecord(parsed)) {
        plan.blocked.push(`${target.file} is not a JSON object; left untouched`);
        continue;
      }
      const shellWanted =
        host === "claude-code" &&
        options.shell !== false &&
        path.basename(paths.env.SHELL ?? "") === "zsh";
      const bash = shellWanted
        ? options.bash === undefined
          ? findBash(paths.env)
          : options.bash
        : null;
      const merged =
        host === "claude-code"
          ? mergeClaudeSettings(parsed, bash, skip)
          : mergeCursorCliConfig(parsed, skip);
      if (merged.error) {
        plan.blocked.push(`${target.file}: ${merged.error}; left untouched`);
        continue;
      }
      if (JSON.stringify(merged.config) === JSON.stringify(parsed)) {
        plan.notes.push(`${host}: Workit's permission block is already in ${target.file}`);
        continue;
      }
      after = JSON.stringify(merged.config, null, 2) + "\n";
      owned = merged.owned;
      offered = CANONICAL[host as "claude-code" | "cursor"].lists;
    }
    if (before === after) {
      plan.notes.push(`${host}: Workit's permission block is already in ${target.file}`);
      continue;
    }
    plan.changes.push({
      host: host as PermissionHost,
      file: target.file,
      before,
      after,
      owned,
      offered,
    });
  }
  const agent = agentSessionVar(paths.env);
  if (agent && plan.changes.length > 0)
    plan.refused = `refusing to change host permissions from inside an agent session (${agent} is set): they decide what agents may run, so run \`${setupCommand(
      plan.changes.map((c) => c.host),
    )}\` yourself in a terminal`;
  return plan;
}

/** A unified-style line diff of one change (`-` removed, `+` added, two lines of context). */
export function permissionDiff(change: PermissionChange): string {
  const a = (change.before ?? "").split("\n");
  const b = change.after.split("\n");
  if (change.before === null) a.length = 0;
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const lines: Array<{ mark: " " | "-" | "+"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ mark: " ", text: a[i] });
      i += 1;
      j += 1;
    } else if (i < a.length && (j >= b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      lines.push({ mark: "-", text: a[i] });
      i += 1;
    } else {
      lines.push({ mark: "+", text: b[j] });
      j += 1;
    }
  }
  const near = (at: number) =>
    lines.slice(Math.max(0, at - 2), at + 3).some((line) => line.mark !== " ");
  const out = [`--- ${change.file}${change.before === null ? " (new file)" : ""}`];
  let gap = false;
  lines.forEach((line, at) => {
    if (near(at)) {
      if (gap) out.push("  …");
      gap = false;
      out.push(`${line.mark} ${line.text}`);
    } else gap = true;
  });
  return out.join("\n");
}

export type PermissionApplyEntry = {
  host: PermissionHost;
  file: string;
  status: "written" | "failed";
  detail?: string;
};

/** Writes the reviewed changes; a file that changed since the preview is refused. */
export function applyHostPermissions(
  plan: PermissionPlan,
  options: PermissionPaths = {},
): PermissionApplyEntry[] {
  const paths = resolvePaths(options);
  if (plan.refused)
    return plan.changes.map((c) => ({
      host: c.host,
      file: c.file,
      status: "failed",
      detail: plan.refused,
    }));
  const record = readOwnership(paths);
  const entries: PermissionApplyEntry[] = [];
  for (const change of plan.changes) {
    if (readText(change.file) !== change.before) {
      entries.push({
        host: change.host,
        file: change.file,
        status: "failed",
        detail: "the file changed after the preview; run the command again and review the new diff",
      });
      continue;
    }
    try {
      // Write through a symlinked settings file instead of replacing the link.
      const target = change.before === null ? change.file : realpathSync(change.file);
      if (change.before !== null) {
        const backups = path.join(paths.stateDir, "host-permissions-backup");
        mkdirSync(backups, { recursive: true, mode: 0o700 });
        copyFileSync(
          target,
          path.join(
            backups,
            `${new Date().toISOString().replaceAll(":", "-")}-${change.host}-${path.basename(change.file)}`,
          ),
        );
      }
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, change.after);
      const previous = record.hosts[change.host];
      record.hosts[change.host] = {
        file: change.file,
        owned: unionOwned(previous?.owned, change.owned),
        offered: unionLists(previous?.offered, change.offered),
      };
      entries.push({ host: change.host, file: change.file, status: "written" });
    } catch (error) {
      entries.push({
        host: change.host,
        file: change.file,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (entries.some((e) => e.status === "written")) writeOwnership(record, paths.stateDir);
  return entries;
}

/** Remove Workit's Codex rules file (exact path only). */
export const removeCodexRules = (file: string, options: PermissionPaths = {}): boolean => {
  const expected = permissionTarget("codex", options).file;
  if (path.resolve(file) !== path.resolve(expected) || !existsSync(expected)) return false;
  rmSync(expected);
  return true;
};

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

export type PermissionHealth =
  | { state: "no-host" | "absent" | "ok" }
  | { state: "drift" | "unreadable"; detail: string };

/** Is Workit's block for `host` whole, partly there, or absent? */
export function permissionHealth(
  host: PermissionHost,
  options: PermissionPaths = {},
): PermissionHealth {
  const target = permissionTarget(host, options);
  if (!existsSync(target.hostDir)) return { state: "no-host" };
  const text = readText(target.file);
  if (host === "codex") {
    if (text === null) return { state: "absent" };
    return text === codexRulesText()
      ? { state: "ok" }
      : { state: "drift", detail: `${target.file} differs from this Workit version's rules` };
  }
  if (text === null) return { state: "absent" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: "unreadable", detail: `${target.file} is not valid JSON` };
  }
  if (!isRecord(value)) return { state: "unreadable", detail: `${target.file} is not an object` };
  const missing = missingEntries(value, host);
  const total = Object.values(CANONICAL[host].lists).flat().length;
  if (missing.length === 0) return { state: "ok" };
  if (missing.length === total) return { state: "absent" };
  return {
    state: "drift",
    detail: `${target.file} lacks ${missing.length} Workit entr${missing.length === 1 ? "y" : "ies"} (${missing[0]}${missing.length > 1 ? ", …" : ""})`,
  };
}
