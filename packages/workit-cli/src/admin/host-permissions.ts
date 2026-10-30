// Managed host permissions (issue #297, decision mvk5q3io). Plugins cannot
// ship permission rules, so `workit setup` (and `workit upgrade`, for a block
// already there) writes a Workit-owned, reversible block into each host's own
// config after one consent that shows the exact diff:
//   - Claude Code: enumerated `Bash(workit <verb> *)` allows (and the lease
//     verbs below), `ask` rules for
//     Workit's bypass flags, one `autoMode.environment` and one
//     `autoMode.allow` line, and `env.CLAUDE_CODE_SHELL` (zsh users only);
//   - Codex: `rules/workit.rules`, a file Workit owns;
//   - Cursor: enumerated `Shell(workit <verb>)` in `~/.cursor/cli-config.json`.
// OpenCode needs no write (its plugin turns an ask into an allow) and Pi has
// no permission layer. Every host also allows the lease verbs agents run
// (#429): `workit check <name>` for the standard check names (a prefix rule
// cannot exclude `workit check -- <cmd>`, so the names are listed and the CLI
// refuses `workit check <name> -- <cmd>`) and `workit lock status|wait`.
// Never: `workit check -- …`, `workit lock run -- …`, `workit grant …`, or any
// verb outside WORKIT_ALLOWED_VERBS. The user-only calls (WORKIT_USER_ONLY,
// #615) are asked (Claude Code, Codex) or denied (Cursor) on top of that.
//
// The merges are pure (input record in, record and added entries out), the
// entries Workit added are recorded in its state dir so uninstall removes
// exactly those, and apply refuses a file that changed since the preview.
import {
  copyFileSync,
  existsSync,
  readdirSync,
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
import {
  WORKIT_ALLOWED_VERBS,
  WORKIT_USER_ONLY,
} from "@brainervirus/workit-core/src/hooks/delivery-verbs";
import { claudeConfigDir } from "./host-install";

export type PermissionHost = "claude-code" | "codex" | "cursor";
const PERMISSION_HOSTS: ReadonlySet<string> = new Set<PermissionHost>([
  "claude-code",
  "codex",
  "cursor",
]);

/** Lease verbs for hosts whose rules match a prefix: standard check names, read-only lock verbs. */
const CHECK_NAMES = ["test", "lint", "typecheck", "build", "format", "docs"] as const;
const LOCK_VERBS = ["status", "wait"] as const;
const LEASE_PREFIXES: readonly (readonly string[])[] = [
  ...CHECK_NAMES.map((name) => ["check", name]),
  ...LOCK_VERBS.map((verb) => ["lock", verb]),
];

export const CLAUDE_ALLOW: readonly string[] = [
  ...WORKIT_ALLOWED_VERBS.map((verb) => `Bash(workit ${verb} *)`),
  ...LEASE_PREFIXES.map((rest) => `Bash(workit ${rest.join(" ")} *)`),
  "Bash(workit --version)",
];
// Ask beats allow, so a bypass flag or a user-only call (WORKIT_USER_ONLY, #615)
// still reaches the user (also in auto mode). The `workit * …` form covers a
// `--cwd <dir>` before the verb.
export const CLAUDE_ASK: readonly string[] = [
  "Bash(workit * --unverified*)",
  "Bash(workit * --overwrite-unintegrated*)",
  ...WORKIT_USER_ONLY.flatMap((words) => [
    `Bash(workit ${words.join(" ")}*)`,
    `Bash(workit * ${words.join(" ")}*)`,
  ]),
];
const AUTO_MODE_ENVIRONMENT =
  "Org-specific CLIs: workit — the user's delivery CLI. Its push, pr merge, release and PR-thread verbs run only under per-workspace grants and non-author verdicts the user configured in ~/.config/workit, outside the agent's reach.";
const AUTO_MODE_ALLOW =
  "Workit-gated delivery: `workit pr merge`, `workit git push --force-with-lease` on the session's own branch, `workit release` and `workit pr reply/resolve` on the session's repo are authorized by the user's standing Workit grants; not Merge Without Review, Git Destructive or External System Writes. Does NOT cover `workit release notes approve`, `workit grant set|raise`, `--unverified`, `--admin` or any bypass flag: the user decides those.";
/** The auto-mode line before #615; a refresh replaces it and uninstall still removes it. */
const AUTO_MODE_ALLOW_V1 =
  "Workit-gated delivery: `workit pr merge`, `workit git push --force-with-lease` on the session's own branch, `workit release` and `workit pr reply/resolve` on the session's repo are authorized by the user's standing Workit grants; not Merge Without Review, Git Destructive or External System Writes. Does NOT cover `--unverified`, `--admin` or any bypass flag.";
const DEFAULTS = "$defaults";

export const CURSOR_ALLOW: readonly string[] = [
  ...WORKIT_ALLOWED_VERBS.map((verb) => `Shell(workit ${verb})`),
  ...LEASE_PREFIXES.map((rest) => `Shell(workit ${rest.join(" ")})`),
  "Shell(workit --version)",
];
/** Cursor has no prompt rule, so the user-only calls are denied (the user runs them in a terminal). */
export const CURSOR_DENY: readonly string[] = WORKIT_USER_ONLY.map(
  (words) => `Shell(workit ${words.join(" ")})`,
);

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
  const lease = LEASE_PREFIXES.map(
    (rest) =>
      `prefix_rule(\n    pattern = ${JSON.stringify(["workit", ...rest])},\n    decision = "allow",\n    justification = "Workit heavy-check lease: runs the repo's configured check, or reads the lease",\n)\n`,
  );
  const grant = `prefix_rule(\n    pattern = ["workit", "grant"],\n    decision = "prompt",\n    justification = "Changing Workit grants needs the user",\n)\n`;
  const userOnly = WORKIT_USER_ONLY.map(
    (words) =>
      `prefix_rule(\n    pattern = ${JSON.stringify(["workit", ...words])},\n    decision = "prompt",\n    justification = "Only the user runs this Workit call (approval or grant change)",\n)\n`,
  );
  return `${CODEX_HEADER}\n${[...rules, ...lease, grant, ...userOnly].join("\n")}`;
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

/** Remove the entries a past Workit version offered that this one replaced (#615). */
const dropPrior = (config: Json, host: "claude-code" | "cursor"): void => {
  for (const [dotted, prior] of Object.entries(PRIOR_ENTRIES[host])) {
    const at = valueAt(config, dotted);
    const list = at?.parent[at.key];
    if (at && Array.isArray(list))
      at.parent[at.key] = list.filter((entry) => !prior.includes(entry as string));
  }
};

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
  dropPrior(config, "claude-code");
  if (shell) {
    const env = objectAt(config, ["env"], owned);
    if (!env)
      return {
        config: settings,
        owned: emptyOwned(),
        error: "env is not an object",
      };
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
  const error =
    appendList(next, "permissions.allow", CURSOR_ALLOW, owned, [], skip) ??
    appendList(next, "permissions.deny", CURSOR_DENY, owned, [], skip);
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
  cursor: {
    lists: {
      "permissions.allow": [...CURSOR_ALLOW],
      "permissions.deny": [...CURSOR_DENY],
    },
    created: [],
    env: {},
  },
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

/**
 * Entries earlier Workit versions offered that this one no longer does, per
 * host and dotted path. Add an entry here when it leaves the canonical lists,
 * so uninstall still removes it, and a merge drops them from the list it writes.
 */
const PRIOR_ENTRIES: Record<"claude-code" | "cursor", Record<string, readonly string[]>> = {
  "claude-code": { "autoMode.allow": [AUTO_MODE_ALLOW_V1] },
  cursor: {},
};

/** Every entry any shipped Workit version offered at `dotted`: the one set uninstall may remove. */
const offeredAt = (host: "claude-code" | "cursor", dotted: string): ReadonlySet<string> =>
  new Set([...(CANONICAL[host].lists[dotted] ?? []), ...(PRIOR_ENTRIES[host][dotted] ?? [])]);

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
  cursor: new Set(["permissions", "permissions.allow", "permissions.deny"]),
};

/** Where `findBash` looks first, so a Workit-written `CLAUDE_CODE_SHELL` is one of these or the PATH hit. */
const FIXED_BASH = new Set(["/usr/bin/bash", "/bin/bash"]);

/** Could Workit have written `value` as `CLAUDE_CODE_SHELL`: a fixed system bash or what `findBash` finds now? */
const isWorkitBash = (value: unknown, env: NodeJS.ProcessEnv): value is string =>
  typeof value === "string" && (FIXED_BASH.has(value) || value === findBash(env));

/**
 * An ownership record cut down to what Workit could have written: its own
 * list paths with the exact entries a shipped version offered, only the
 * `CLAUDE_CODE_SHELL` value `findBash` yields, and its own containers. A
 * stale or edited record never makes uninstall remove a user's entry.
 */
const trustedOwned = (
  owned: OwnedEntries,
  host: "claude-code" | "cursor",
  env: NodeJS.ProcessEnv,
): OwnedEntries => {
  const lists: Record<string, string[]> = {};
  for (const [dotted, entries] of Object.entries(isRecord(owned.lists) ? owned.lists : {})) {
    const offered = offeredAt(host, dotted);
    if (!Array.isArray(entries) || offered.size === 0) continue;
    lists[dotted] = entries.filter((entry) => typeof entry === "string" && offered.has(entry));
  }
  const shell = isRecord(owned.env) ? owned.env.CLAUDE_CODE_SHELL : undefined;
  return {
    lists,
    created: (Array.isArray(owned.created) ? owned.created : []).filter((dotted) =>
      CREATED_PATHS[host].has(dotted),
    ),
    env: host === "claude-code" && isWorkitBash(shell, env) ? { CLAUDE_CODE_SHELL: shell } : {},
  };
};

/** The canonical entries plus the prior ones, for removal without a record. */
const withPrior = (host: "claude-code" | "cursor"): OwnedEntries => ({
  ...CANONICAL[host],
  lists: unionLists(CANONICAL[host].lists, PRIOR_ENTRIES[host]),
});

/**
 * The inverse of a merge: drop the entries `owned` names, the env values it
 * set (when unchanged), and the containers it created once they hold nothing
 * but their seed. Without a record, the canonical entries are dropped; with
 * one, only the entries a shipped version offered (`trustedOwned`).
 */
export function removeOwnedEntries(
  config: Json,
  owned: OwnedEntries | null,
  host: "claude-code" | "cursor",
  shellEnv: NodeJS.ProcessEnv = process.env,
): { next: Json; changed: boolean } {
  const next = clone(config);
  const record = owned ? trustedOwned(owned, host, shellEnv) : withPrior(host);
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

export type PermissionPaths = {
  home?: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
};

type ResolvedPaths = { home: string; env: NodeJS.ProcessEnv; stateDir: string };

const resolvePaths = (options: PermissionPaths): ResolvedPaths => {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? os.homedir();
  return {
    home,
    env,
    stateDir: options.stateDir ?? workitStateDir({ ...env, HOME: home }),
  };
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
      : {
          state: "drift",
          detail: `${target.file} differs from this Workit version's rules`,
        };
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

// ---------------------------------------------------------------------------
// Doctor: do the host's rules cover the verbs the grants authorize? (#419)
// ---------------------------------------------------------------------------

/** The commands agents run for a grant; with no host rule each one prompts or is denied in auto mode. */
const GRANT_COMMANDS: Record<string, readonly string[]> = {
  push: ["workit git push"],
  pr: ["workit pr create"],
  merge: ["workit pr merge"],
};
/** Always asked of a host, grant or not: the heavy-check lease an agent runs on every change. */
const LEASE_COMMANDS: readonly string[] = LEASE_PREFIXES.map((rest) => `workit ${rest.join(" ")}`);

/** The commands the granted kinds (`push`, `pr`, `merge`) and the lease verbs need a rule for. */
export const grantedCommands = (kinds: readonly string[]): string[] => [
  ...kinds.flatMap((kind) => GRANT_COMMANDS[kind] ?? []),
  ...LEASE_COMMANDS,
];

// Claude Code's documented matcher: `*` matches any text; a trailing ` *` also matches the bare command.
const claudeRuleMatches = (rule: string, command: string): boolean => {
  const body = /^Bash\((.*)\)$/u.exec(rule)?.[1];
  if (rule === "Bash" || body === "*" || body === "") return true;
  if (body === undefined) return false;
  // Legacy prefix syntax `Bash(workit:*)`: the command, or the prefix then a word boundary.
  if (body.endsWith(":*") && !body.slice(0, -2).includes("*")) {
    const prefix = body.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  const escaped = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  const pattern = body.endsWith(" *") ? escaped.replace(/ \.\*$/u, "(?: .*)?") : escaped;
  return new RegExp(`^${pattern}$`, "u").test(command);
};

// cursor-agent `matchesShell`: the pattern itself, or the pattern then a space.
const cursorRuleMatches = (rule: string, command: string): boolean => {
  const full = /^Shell\((.*)\)$/u.exec(rule)?.[1];
  return full !== undefined && (command === full || command.startsWith(`${full} `));
};

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const readRecord = (file: string): Json | null => {
  const text = readText(file);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

/** Allowed `prefix_rule` patterns of every `*.rules` file in a Codex rules directory. */
const codexAllowPatterns = (dir: string): string[][] => {
  const patterns: string[][] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".rules"));
  } catch {
    return patterns;
  }
  for (const name of names)
    for (const m of (readText(path.join(dir, name)) ?? "").matchAll(
      /pattern\s*=\s*(\[[^\]]*\])\s*,\s*decision\s*=\s*"allow"/gu,
    ))
      try {
        const words: unknown = JSON.parse(m[1]);
        if (Array.isArray(words)) patterns.push(words.map(String));
      } catch {
        // A pattern this parser cannot read is not counted as covering anything.
      }
  return patterns;
};

export type PermissionCoverage =
  | { state: "no-host" }
  | { state: "ok" }
  | { state: "missing"; file: string; missing: string[] };

/**
 * Which of `commands` no allow rule of `host` covers. Claude Code reads the
 * user settings and this project's `.claude/settings(.local).json`, and also
 * wants an `autoMode.allow` line naming Workit when a delivery verb
 * (push, pr, merge) is among them: auto mode denies an unlisted delivery verb
 * even when an allow rule exists. Codex reads every `rules/*.rules`; Cursor
 * the user CLI config and this project's `.cursor/cli.json`.
 */
export function permissionCoverage(
  host: PermissionHost,
  commands: readonly string[],
  options: PermissionPaths & { cwd?: string } = {},
): PermissionCoverage {
  const target = permissionTarget(host, options);
  if (!existsSync(target.hostDir)) return { state: "no-host" };
  const cwd = options.cwd ?? process.cwd();
  let missing: string[];
  if (host === "codex") {
    const patterns = codexAllowPatterns(path.dirname(target.file));
    missing = commands.filter((command) => {
      const words = command.split(" ");
      return !patterns.some((p) => p.every((word, i) => words[i] === word));
    });
  } else if (host === "cursor") {
    const rules = [target.file, path.join(cwd, ".cursor", "cli.json")].flatMap((file) =>
      stringList(valueFrom(readRecord(file), "permissions", "allow")),
    );
    missing = commands.filter((command) => !rules.some((rule) => cursorRuleMatches(rule, command)));
  } else {
    const files = [
      target.file,
      path.join(cwd, ".claude", "settings.json"),
      path.join(cwd, ".claude", "settings.local.json"),
    ].map(readRecord);
    const rules = files.flatMap((file) => stringList(valueFrom(file, "permissions", "allow")));
    missing = commands.filter((command) => !rules.some((rule) => claudeRuleMatches(rule, command)));
    const delivery = commands.some((command) => !LEASE_COMMANDS.includes(command));
    const auto = files.flatMap((file) => stringList(valueFrom(file, "autoMode", "allow")));
    if (delivery && !auto.some((line) => /\bworkit\b/iu.test(line)))
      missing.push("autoMode.allow line naming workit");
  }
  return missing.length === 0 ? { state: "ok" } : { state: "missing", file: target.file, missing };
}

const valueFrom = (root: Json | null, ...keys: string[]): unknown => {
  let node: unknown = root;
  for (const key of keys) node = isRecord(node) ? node[key] : undefined;
  return node;
};
