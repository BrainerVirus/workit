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
// OpenCode needs no allow (its plugin turns an ask into an allow) and Pi has
// no permission layer. Native deny rules for the guarded paths (#820:
// `<state>/issued*`, `<state>/approvals/`, the account config's
// workspaces.json and its seal) ride the same block, so they hold when a hook
// fails to load: Claude Code `Edit(//<abs>)` deny rules (its sandbox also
// denies those paths to Bash), Cursor `Write(<abs>)` deny rules, and OpenCode
// `permission.edit` patterns set to "deny" in its global opencode.json. The
// paths come from the env at setup time; a refresh drops the ones Workit wrote
// for paths that moved. Codex has no path deny (its sandbox's writable roots
// are an allowlist): the doctor reports its sandbox mode instead.
// Every host also allows the lease verbs agents run
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
  lstatSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { SEAL_FILE } from "@workit-dev/core/src/core/grant-seal";
import { stateDir as workitStateDir } from "@workit-dev/core/src/core/heavy-words";
import { testRunWriteRefusal } from "@workit-dev/core/src/core/account-home";
import { writeFileAtomic } from "@workit-dev/core/src/core/safe-write";
import { configDir as workitConfigDir } from "@workit-dev/core/src/core/workit-paths.mjs";
import { WORKIT_ALLOWED_VERBS, WORKIT_USER_ONLY } from "@workit-dev/core/src/hooks/delivery-verbs";
import { configHome } from "../upgrade/skill-roots";
import { claudeConfigDir } from "./host-install";

export type PermissionHost = "claude-code" | "codex" | "cursor" | "opencode";
const PERMISSION_HOSTS: ReadonlySet<string> = new Set<PermissionHost>([
  "claude-code",
  "codex",
  "cursor",
  "opencode",
]);
/** The hosts whose block is merged into a JSON config. */
type JsonHost = Exclude<PermissionHost, "codex">;

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
// still reaches the user (also in auto mode). Each rule is anchored at the verb
// that takes it: a `*` reads quoted text too, so `workit * ledger void*` asked
// on a verdict whose --how only mentions it. A global option before the verb
// is the PreToolUse hook's to ask (it reads words, not text).
export const CLAUDE_ASK: readonly string[] = [
  "Bash(workit pr merge *--unverified*)",
  "Bash(workit stack land *--unverified*)",
  "Bash(workit git push *--overwrite-unintegrated*)",
  ...WORKIT_USER_ONLY.map((words) => `Bash(workit ${words.join(" ")}*)`),
];
/**
 * The mid-command ask globs Workit wrote before they were anchored (#759): a
 * refresh drops each one only where the ownership record says Workit added it.
 */
const RETIRED_CLAUDE_ASK: readonly string[] = [
  "Bash(workit * --unverified*)",
  "Bash(workit * --overwrite-unintegrated*)",
  ...WORKIT_USER_ONLY.map((words) => `Bash(workit * ${words.join(" ")}*)`),
];
const AUTO_MODE_ENVIRONMENT =
  "Org-specific CLIs: workit — the user's delivery CLI. Its push, pr merge, release and PR-thread verbs run only under per-workspace grants and non-author verdicts the user configured in the Workit config dir, outside the agent's reach.";
/** The environment line before it stopped naming ~/.config/workit (wrong on Windows); a refresh replaces it. */
const AUTO_MODE_ENVIRONMENT_V1 =
  "Org-specific CLIs: workit — the user's delivery CLI. Its push, pr merge, release and PR-thread verbs run only under per-workspace grants and non-author verdicts the user configured in ~/.config/workit, outside the agent's reach.";
const AUTO_MODE_ALLOW =
  "Workit-gated delivery: `workit pr merge`, `workit git push --force-with-lease` on the session's own branch, `workit release` and `workit pr reply/resolve` on the session's repo are authorized by the user's standing Workit grants; not Merge Without Review, Git Destructive or External System Writes. Does NOT cover `workit release notes approve`, `workit grant set|raise`, `workit ledger void`, `workit approve`, `workit setup`, `workit uninstall`, `workit install`, `workit workspace seal`, `--unverified`, `--admin` or any bypass flag: the user decides those.";
/** The auto-mode line from #615 until the whole-verb user-only calls; a refresh replaces it and uninstall still removes it. */
const AUTO_MODE_ALLOW_V2 =
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
      `prefix_rule(\n    pattern = ${JSON.stringify(["workit", ...words])},\n    decision = "prompt",\n    justification = "Only the user runs this Workit call (an approval, a grant change, host setup or a seal)",\n)\n`,
  );
  return `${CODEX_HEADER}\n${[...rules, ...lease, grant, ...userOnly].join("\n")}`;
};

// ---------------------------------------------------------------------------
// Native deny rules for the guarded paths (#820)
// ---------------------------------------------------------------------------

/** Where each JSON host keeps its path deny rules: a list, or OpenCode's pattern map. */
const DENY_AT: Record<JsonHost, string> = {
  "claude-code": "permissions.deny",
  cursor: "permissions.deny",
  opencode: "permission.edit",
};

/** The dirs whose files only Workit or the user writes, each as written and through its links. */
type GuardedDirs = { state: string[]; config: string[] };

/** `dir` through its links: the deepest existing ancestor resolved, the rest kept (cursor-agent resolves a write target so). */
const realDir = (dir: string): string => {
  const rest: string[] = [];
  for (let probe = dir; ; probe = path.dirname(probe)) {
    try {
      return path.join(realpathSync(probe), ...rest.toReversed());
    } catch {
      if (path.dirname(probe) === probe) return dir;
      rest.push(path.basename(probe));
    }
  }
};

const spellings = (dir: string): string[] =>
  [...new Set([path.resolve(dir), realDir(path.resolve(dir))])].map((s) => s.replaceAll("\\", "/"));

/**
 * The state dir (`issued*`, `approvals/`) and the account config dir
 * (workspaces.json and its seal; the default config dir of the setup's home,
 * as the grants are read) these options resolve to.
 */
const guardedDirs = (options: PermissionPaths = {}): GuardedDirs => {
  const { home, stateDir } = resolvePaths(options);
  return {
    state: spellings(stateDir),
    config: spellings(workitConfigDir({ HOME: home })),
  };
};

/** The entries under the state dir per host: Claude Code reads gitignore patterns, Cursor and OpenCode a `*` that crosses `/`. */
const STATE_NAMES: Record<JsonHost, readonly string[]> = {
  "claude-code": ["issued*", "issued*/**", "approvals", "approvals/**"],
  cursor: ["issued*", "approvals", "approvals/*"],
  opencode: ["issued*", "approvals", "approvals/*"],
};
const CONFIG_NAMES = ["workspaces.json", SEAL_FILE];

/**
 * A dir as a literal in a Claude Code rule: gitignore glob characters
 * backslash-escaped, then each parenthesis as `[(]`/`[)]`, the spelling claude
 * 2.1.323's rule check suggests (an unbalanced one is ambiguous).
 */
const claudeLiteral = (dir: string): string =>
  dir.replace(/[*?[\]]/gu, "\\$&").replace(/[()]/gu, "[$&]");

/**
 * One host's deny entries for `dirs`: `Edit(//<abs>)` (Claude Code),
 * `Write(<abs>)` (Cursor), a bare pattern (OpenCode). Cursor and OpenCode
 * escape every regex character but their own wildcards, so a dir is written
 * as is; a `*` or `?` in it only widens the rule.
 */
const nativeDenyEntries = (host: JsonHost, dirs: GuardedDirs): string[] => {
  const rule = (dir: string, name: string): string => {
    if (host === "claude-code") return `Edit(//${claudeLiteral(dir).replace(/^\/+/u, "")}/${name})`;
    return host === "cursor" ? `Write(${dir}/${name})` : `${dir}/${name}`;
  };
  return [
    ...dirs.state.flatMap((dir) => STATE_NAMES[host].map((name) => rule(dir, name))),
    ...dirs.config.flatMap((dir) => CONFIG_NAMES.map((name) => rule(dir, name))),
  ];
};

/** The shape of a native deny entry Workit writes, for any guarded dir: what uninstall may trust a record for. */
const NATIVE_SHAPE: Record<JsonHost, RegExp> = {
  "claude-code":
    /^Edit\(\/\/.+\/(?:issued\*(?:\/\*\*)?|approvals(?:\/\*\*)?|workspaces\.json(?:\.seal)?)\)$/u,
  cursor: /^Write\(.+\/(?:issued\*|approvals(?:\/\*)?|workspaces\.json(?:\.seal)?)\)$/u,
  opencode: /^.+\/(?:issued\*|approvals(?:\/\*)?|workspaces\.json(?:\.seal)?)$/u,
};

const isJsonHost = (host: string): host is JsonHost => Object.hasOwn(DENY_AT, host);

const isNativeDeny = (host: string, dotted: string, entry: unknown): entry is string =>
  isJsonHost(host) &&
  DENY_AT[host] === dotted &&
  typeof entry === "string" &&
  NATIVE_SHAPE[host].test(entry);

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
const dropPrior = (config: Json, host: JsonHost): void => {
  for (const [dotted, prior] of Object.entries(PRIOR_ENTRIES[host])) {
    const at = valueAt(config, dotted);
    const list = at?.parent[at.key];
    if (at && Array.isArray(list))
      at.parent[at.key] = list.filter((entry) => !prior.includes(entry as string));
  }
};

/** Drop the retired ask globs Workit itself wrote (`ownedAsk`); a user's same entry stays. */
const dropRetired = (config: Json, ownedAsk: readonly string[]): void => {
  const retired = new Set(RETIRED_CLAUDE_ASK.filter((entry) => ownedAsk.includes(entry)));
  const at = valueAt(config, "permissions.ask");
  const list = at?.parent[at.key];
  if (at && retired.size && Array.isArray(list))
    at.parent[at.key] = list.filter((entry) => !retired.has(entry as string));
};

/** The deny entries at `dotted`: a list's strings, or a pattern map's keys set to "deny". */
const denyEntriesAt = (root: Json, dotted: string): string[] => {
  const value = valueFrom(root, ...dotted.split("."));
  if (Array.isArray(value)) return stringList(value);
  return isRecord(value) ? Object.keys(value).filter((key) => value[key] === "deny") : [];
};

/** Drop the native deny entries Workit wrote (`ownedDeny`) for guarded paths that moved; a user's entry stays. */
const dropStaleDeny = (
  config: Json,
  host: JsonHost,
  current: readonly string[],
  ownedDeny: readonly string[],
): void => {
  const dotted = DENY_AT[host];
  const wanted = new Set(current);
  const stale = new Set(
    ownedDeny.filter((entry) => isNativeDeny(host, dotted, entry) && !wanted.has(entry)),
  );
  const at = valueAt(config, dotted);
  const value = at?.parent[at.key];
  if (!at || stale.size === 0) return;
  if (Array.isArray(value))
    at.parent[at.key] = value.filter((entry) => !stale.has(entry as string));
  else if (isRecord(value)) for (const key of stale) if (value[key] === "deny") delete value[key];
};

/** Set each missing pattern of `entries` to "deny" in the pattern map at `dotted` (OpenCode). */
const appendDenyMap = (
  root: Json,
  dotted: string,
  entries: readonly string[],
  owned: OwnedEntries,
  skip: Skip,
): string | null => {
  const skipped = new Set(skip[dotted] ?? []);
  const wanted = entries.filter((entry) => !skipped.has(entry));
  if (wanted.length === 0) return null;
  const keys = dotted.split(".");
  const parent = objectAt(root, keys.slice(0, -1), owned);
  const leaf = keys.at(-1)!;
  if (!parent) return `${keys.slice(0, -1).join(".")} is not an object`;
  if (typeof parent[leaf] === "string")
    return `${dotted} is one action for every path ("${parent[leaf]}"); make it a pattern map to take Workit's deny patterns`;
  if (parent[leaf] === undefined) {
    parent[leaf] = {};
    owned.created.push(dotted);
  }
  const map = parent[leaf];
  if (!isRecord(map)) return `${dotted} is not an object`;
  for (const entry of wanted)
    if (map[entry] === undefined) {
      map[entry] = "deny";
      (owned.lists[dotted] ??= []).push(entry);
    }
  return null;
};

/** What a merge needs besides the config: the native deny entries, the refresh skips, the record. */
type MergeInput = {
  deny: readonly string[];
  skip: Skip;
  previous?: OwnedEntries;
};

/** The strings Workit recorded adding at `dotted` (a tampered record yields none). */
const ownedList = (previous: OwnedEntries | undefined, dotted: string): string[] => {
  const lists: unknown = previous?.lists;
  return isRecord(lists) ? stringList(lists[dotted]) : [];
};

/**
 * Claude Code user settings with Workit's block. `shell` (a bash path) is set
 * as `env.CLAUDE_CODE_SHELL` only when no value is set; `skip` leaves out the
 * entries an earlier write offered (the upgrade refresh).
 */
function mergeClaudeSettings(settings: Json, shell: string | null, input: MergeInput): HostMerge {
  const { deny, skip, previous } = input;
  const config = clone(settings);
  const owned = emptyOwned();
  dropRetired(config, ownedList(previous, "permissions.ask"));
  dropStaleDeny(config, "claude-code", deny, ownedList(previous, DENY_AT["claude-code"]));
  const error =
    appendList(config, "permissions.allow", CLAUDE_ALLOW, owned, [], skip) ??
    appendList(config, "permissions.ask", CLAUDE_ASK, owned, [], skip) ??
    appendList(config, "permissions.deny", deny, owned, [], skip) ??
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

/** Cursor CLI config with Workit's `Shell(workit <verb>)` allows and its `Write(<abs>)` denies. */
function mergeCursorCliConfig(config: Json, input: MergeInput): HostMerge {
  const { deny, skip, previous } = input;
  const next = clone(config);
  const owned = emptyOwned();
  dropStaleDeny(next, "cursor", deny, ownedList(previous, DENY_AT.cursor));
  const error =
    appendList(next, "permissions.allow", CURSOR_ALLOW, owned, [], skip) ??
    appendList(next, "permissions.deny", [...CURSOR_DENY, ...deny], owned, [], skip);
  return error ? { config, owned: emptyOwned(), error } : { config: next, owned };
}

/** OpenCode's global opencode.json with Workit's `permission.edit` deny patterns. */
function mergeOpenCodeConfig(config: Json, input: MergeInput): HostMerge {
  const { deny, skip, previous } = input;
  const next = clone(config);
  const owned = emptyOwned();
  dropStaleDeny(next, "opencode", deny, ownedList(previous, DENY_AT.opencode));
  const error = appendDenyMap(next, DENY_AT.opencode, deny, owned, skip);
  return error ? { config, owned: emptyOwned(), error } : { config: next, owned };
}

/** The entries per list that need no path, for a host with no ownership record. */
const STATIC_LISTS: Record<JsonHost, Record<string, string[]>> = {
  "claude-code": {
    "permissions.allow": [...CLAUDE_ALLOW],
    "permissions.ask": [...CLAUDE_ASK],
    "autoMode.environment": [AUTO_MODE_ENVIRONMENT],
    "autoMode.allow": [AUTO_MODE_ALLOW],
  },
  cursor: {
    "permissions.allow": [...CURSOR_ALLOW],
    "permissions.deny": [...CURSOR_DENY],
  },
  opencode: {},
};

/** Every entry this version writes for `host`, its native deny entries (`deny`) included. */
const canonicalOwned = (host: JsonHost, deny: readonly string[]): OwnedEntries => ({
  lists: unionLists(STATIC_LISTS[host], { [DENY_AT[host]]: deny }),
  created: [],
  env: {},
});

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
const PRIOR_ENTRIES: Record<JsonHost, Record<string, readonly string[]>> = {
  "claude-code": {
    "autoMode.environment": [AUTO_MODE_ENVIRONMENT_V1],
    "autoMode.allow": [AUTO_MODE_ALLOW_V1, AUTO_MODE_ALLOW_V2],
  },
  cursor: {},
  opencode: {},
};

/** Every path-free entry any shipped Workit version offered at `dotted`. */
const offeredAt = (host: JsonHost, dotted: string): ReadonlySet<string> =>
  new Set([
    ...(STATIC_LISTS[host][dotted] ?? []),
    ...(PRIOR_ENTRIES[host][dotted] ?? []),
    ...(host === "claude-code" && dotted === "permissions.ask" ? RETIRED_CLAUDE_ASK : []),
  ]);

/** The containers a merge may create, per host. */
const CREATED_PATHS: Record<JsonHost, ReadonlySet<string>> = {
  "claude-code": new Set([
    "permissions",
    "permissions.allow",
    "permissions.ask",
    "permissions.deny",
    "autoMode",
    "autoMode.environment",
    "autoMode.allow",
    "env",
  ]),
  cursor: new Set(["permissions", "permissions.allow", "permissions.deny"]),
  opencode: new Set(["permission", "permission.edit"]),
};

/** Where `findBash` looks first, so a Workit-written `CLAUDE_CODE_SHELL` is one of these or the PATH hit. */
const FIXED_BASH = new Set(["/usr/bin/bash", "/bin/bash"]);

/** Could Workit have written `value` as `CLAUDE_CODE_SHELL`: a fixed system bash or what `findBash` finds now? */
const isWorkitBash = (value: unknown, env: NodeJS.ProcessEnv): value is string =>
  typeof value === "string" && (FIXED_BASH.has(value) || value === findBash(env));

/**
 * An ownership record cut down to what Workit could have written: its own
 * list paths with the exact entries a shipped version offered (or a native
 * deny entry's shape, whose path the setup's env decided), only the
 * `CLAUDE_CODE_SHELL` value `findBash` yields, and its own containers. A
 * stale or edited record never makes uninstall remove a user's entry.
 */
const trustedOwned = (
  owned: OwnedEntries,
  host: JsonHost,
  env: NodeJS.ProcessEnv,
): OwnedEntries => {
  const lists: Record<string, string[]> = {};
  for (const [dotted, entries] of Object.entries(isRecord(owned.lists) ? owned.lists : {})) {
    const offered = offeredAt(host, dotted);
    if (!Array.isArray(entries) || (offered.size === 0 && DENY_AT[host] !== dotted)) continue;
    lists[dotted] = entries.filter(
      (entry) =>
        typeof entry === "string" && (offered.has(entry) || isNativeDeny(host, dotted, entry)),
    );
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

/** The canonical entries (native deny ones for `deny`) plus the prior ones, for removal without a record. */
const withPrior = (host: JsonHost, deny: readonly string[]): OwnedEntries => {
  const canonical = canonicalOwned(host, deny);
  return {
    ...canonical,
    lists: unionLists(canonical.lists, PRIOR_ENTRIES[host]),
  };
};

/**
 * The inverse of a merge: drop the entries `owned` names (a pattern map's
 * key only while it still says "deny"), the env values it set (when
 * unchanged), and the containers it created once they hold nothing but their
 * seed. Without a record, the canonical entries are dropped, the native deny
 * ones for the paths `paths` resolves; with one, only the entries a shipped
 * version offered (`trustedOwned`).
 */
export function removeOwnedEntries(
  config: Json,
  owned: OwnedEntries | null,
  host: JsonHost,
  shellEnv: NodeJS.ProcessEnv = process.env,
  paths: PermissionPaths = {},
): { next: Json; changed: boolean } {
  const next = clone(config);
  const record = owned
    ? trustedOwned(owned, host, shellEnv)
    : withPrior(host, nativeDenyEntries(host, guardedDirs({ env: shellEnv, ...paths })));
  let changed = false;
  for (const [dotted, entries] of Object.entries(record.lists)) {
    const at = valueAt(next, dotted);
    const value = at?.parent[at.key];
    if (!at) continue;
    if (Array.isArray(value)) {
      const drop = new Set<unknown>(entries);
      const kept = value.filter((entry) => !drop.has(entry));
      if (kept.length !== value.length) {
        at.parent[at.key] = kept;
        changed = true;
      }
    } else if (isRecord(value) && dotted === DENY_AT[host])
      for (const entry of entries)
        if (value[entry] === "deny") {
          delete value[entry];
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

/** Workit's path-free entries missing from a host config (empty when that block is whole). */
function missingEntries(config: Json, host: JsonHost): string[] {
  const missing: string[] = [];
  for (const [dotted, entries] of Object.entries(STATIC_LISTS[host])) {
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
  /** The OS account's home a test run never writes (test seam; default the account record's). */
  accountHome?: string | null;
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
  if (host === "opencode") {
    const dir = path.join(configHome(home, env), "opencode");
    return { file: path.join(dir, "opencode.json"), hostDir: dir };
  }
  const dir = path.join(home, ".cursor");
  return { file: path.join(dir, "cli-config.json"), hostDir: dir };
};

/** Agent-session markers: `workit setup`, `upgrade`'s permission refresh and `workit uninstall --hosts` refuse on any. */
export const AGENT_SESSION_VARS = [
  "CLAUDECODE",
  "WORKIT_SESSION_ID",
  "CODEX_THREAD_ID",
  "OPENCODE_SESSION_ID",
  "PI_SESSION_ID",
  "CURSOR_AGENT",
] as const;

/** The variable showing this process runs inside an agent session, or null. */
export const agentSessionVar = (env: NodeJS.ProcessEnv): string | null =>
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

/** Where Workit records the permission entries it added. */
export const ownershipFile = (options: PermissionPaths = {}): string =>
  path.join(resolvePaths(options).stateDir, RECORD_FILE);

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
  /** Why nothing may be written (an agent session, a state dir Workit cannot record in). */
  refused?: string;
  /** What the user runs or changes to clear `refused`, when it is not the setup command itself. */
  unblock?: string;
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

/** OpenCode's config when only an `opencode.jsonc` holds it (Workit would drop its comments). */
const onlyJsonc = (file: string): string | null => {
  const jsonc = file.replace(/\.json$/u, ".jsonc");
  return !existsSync(file) && existsSync(jsonc) ? jsonc : null;
};
const JSONC_BLOCKED =
  "holds the OpenCode config (comments Workit would drop); add Workit's permission.edit deny patterns by hand";

/** One JSON host's merge (`bash`: the Claude Code shell to set, or null). */
const mergeFor = (
  host: JsonHost,
  parsed: Json,
  bash: string | null,
  input: MergeInput,
): HostMerge =>
  host === "claude-code"
    ? mergeClaudeSettings(parsed, bash, input)
    : host === "cursor"
      ? mergeCursorCliConfig(parsed, input)
      : mergeOpenCodeConfig(parsed, input);

export function planHostPermissions(options: PlanOptions): PermissionPlan {
  const paths = resolvePaths(options);
  const plan: PermissionPlan = { changes: [], notes: [], blocked: [] };
  const record = readOwnership(paths);
  const hosts = options.refreshOnly
    ? options.hosts.filter((h) => record.hosts[h as PermissionHost])
    : options.hosts;
  const guarded = guardedDirs(paths);
  for (const host of hosts) {
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
    const jsonc = host === "opencode" ? onlyJsonc(target.file) : null;
    if (jsonc) {
      plan.blocked.push(`${jsonc} ${JSONC_BLOCKED}; left untouched`);
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
      const jsonHost = host as JsonHost;
      const deny = nativeDenyEntries(jsonHost, guarded);
      const input: MergeInput = {
        deny,
        skip,
        ...(previous ? { previous: previous.owned } : {}),
      };
      const merged = mergeFor(jsonHost, parsed, bash, input);
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
      offered = canonicalOwned(jsonHost, deny).lists;
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
  else if (plan.changes.length > 0) {
    const refusal = recordRefusal(paths.stateDir);
    if (refusal) Object.assign(plan, refusal);
  }
  return plan;
}

/**
 * Why Workit cannot write its ownership record under `stateDir`: a symlinked
 * dir on the way (`writeFileAtomic` never writes through one). Host files are
 * never written without the record, or uninstall could not remove the entries.
 */
const recordRefusal = (stateDir: string): { refused: string; unblock: string } | null => {
  const file = path.resolve(stateDir, RECORD_FILE);
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    let link = false;
    try {
      link = lstatSync(dir).isSymbolicLink();
    } catch {
      // Missing: created later, not a link.
    }
    if (link) {
      const real = realDir(path.resolve(stateDir));
      return {
        refused: `nothing written: Workit records the entries it adds in ${file}, and ${dir} is a symbolic link, which Workit does not write through (without that record, uninstall could not remove them)`,
        unblock: `point WORKIT_STATE_DIR at the real path (export WORKIT_STATE_DIR=${real}) and run the command again`,
      };
    }
    if (path.dirname(dir) === dir) return null;
  }
};

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
  const failAll = (detail: string): PermissionApplyEntry[] =>
    plan.changes.map((c) => ({ host: c.host, file: c.file, status: "failed", detail }));
  // A test run never writes the real host settings or Workit's state (#859).
  const real = [...plan.changes.map((c) => c.file), paths.stateDir]
    .map((file) => testRunWriteRefusal(file, options.accountHome))
    .find((reason) => reason !== null);
  if (real) return failAll(real);
  const refusal = recordRefusal(paths.stateDir);
  if (refusal) return failAll(`${refusal.refused}; ${refusal.unblock}`);
  const record = readOwnership(paths);
  // The record first, naming every entry about to be written: a host file is
  // never left with entries no record owns. It is rewritten below with only
  // the changes that were written.
  const next = (change: PermissionChange): HostRecord => {
    const previous = record.hosts[change.host];
    return {
      file: change.file,
      owned: forgetDropped(unionOwned(previous?.owned, change.owned), change),
      offered: unionLists(previous?.offered, change.offered),
    };
  };
  const pending = plan.changes.filter((change) => readText(change.file) === change.before);
  if (pending.length > 0)
    try {
      const intent: OwnershipRecord = { version: 1, hosts: { ...record.hosts } };
      for (const change of pending) intent.hosts[change.host] = next(change);
      writeOwnership(intent, paths.stateDir);
    } catch (error) {
      return failAll(
        `nothing written: Workit could not write its ownership record in ${paths.stateDir} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
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
      record.hosts[change.host] = next(change);
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
  if (pending.length > 0)
    try {
      writeOwnership(record, paths.stateDir);
    } catch {
      // The intent record stands: it names a superset of what was written.
    }
  return entries;
}

/**
 * `owned` without the retired ask globs the write dropped, and without the
 * native deny entries the file no longer holds (a moved path's), so a user
 * who adds the same entry later never has it removed as Workit's.
 */
const forgetDropped = (owned: OwnedEntries, change: PermissionChange): OwnedEntries => {
  if (change.host === "codex") return owned;
  let after: unknown;
  try {
    after = JSON.parse(change.after);
  } catch {
    return owned;
  }
  if (!isRecord(after)) return owned;
  const lists = { ...owned.lists };
  const ask = lists["permissions.ask"];
  if (change.host === "claude-code" && ask) {
    const present = new Set(stringList(valueFrom(after, "permissions", "ask")));
    lists["permissions.ask"] = ask.filter(
      (entry) => !RETIRED_CLAUDE_ASK.includes(entry) || present.has(entry),
    );
  }
  const dotted = DENY_AT[change.host];
  const deny = lists[dotted];
  if (deny) {
    const present = new Set(denyEntriesAt(after, dotted));
    lists[dotted] = deny.filter(
      (entry) => !isNativeDeny(change.host, dotted, entry) || present.has(entry),
    );
  }
  return { ...owned, lists };
};

/** Remove Workit's Codex rules file (exact path only). */
export const removeCodexRules = (file: string, options: PermissionPaths = {}): boolean => {
  const expected = permissionTarget("codex", options).file;
  if (path.resolve(file) !== path.resolve(expected) || !existsSync(expected)) return false;
  const refusal = testRunWriteRefusal(expected, options.accountHome);
  if (refusal) throw new Error(refusal);
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
  const total = Object.values(STATIC_LISTS[host]).flat().length;
  if (missing.length === 0) return { state: "ok" };
  if (missing.length === total) return { state: "absent" };
  return {
    state: "drift",
    detail: `${target.file} lacks ${missing.length} Workit entr${missing.length === 1 ? "y" : "ies"} (${missing[0]}${missing.length > 1 ? ", …" : ""})`,
  };
}

export type NativeDenyHost = PermissionHost | "pi";

/**
 * One host's native deny rules for the guarded paths (#820): `present` when
 * every entry for the current paths is there and none for an old path,
 * `stale` when one the ownership record says Workit wrote names a path that
 * moved (what the next setup drops; a rule no record names is the user's), `missing` when an
 * entry is absent; `none` where the host has no path deny (Codex, Pi).
 * `sandbox` is the host's OS sandbox setting where it has one; `risk` says
 * when that sandbox lets agents write a guarded path.
 */
export type NativeDenyHealth = {
  host: NativeDenyHost;
  state: "no-host" | "present" | "missing" | "stale" | "unreadable" | "blocked" | "none";
  file?: string;
  /** `blocked`: why setup cannot write the rules, as its blocked line says. */
  reason?: string;
  missing: string[];
  stale: string[];
  /** The ownership record names this host: the user consented to Workit's block before. */
  recorded: boolean;
  sandbox?: string;
  risk?: string;
};

/** `sandbox_mode` and the `[sandbox_workspace_write]` writable roots of a Codex config.toml (flat reads; no TOML parser). */
const codexSandbox = (text: string): { mode: string | null; roots: string[] } => {
  const top = text.split(/^\s*\[/mu)[0] ?? "";
  const mode = /^\s*sandbox_mode\s*=\s*"([^"]*)"/mu.exec(top)?.[1] ?? null;
  const table = /^\s*\[sandbox_workspace_write\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/mu.exec(
    text,
  )?.[1];
  const list = /^\s*writable_roots\s*=\s*\[([^\]]*)\]/mu.exec(table ?? "")?.[1] ?? "";
  return {
    mode,
    roots: [...list.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/gu)].map((m) => m[1] ?? m[2]),
  };
};

/** Is `dir` (posix form) `root` or inside it? */
const within = (dir: string, root: string): boolean => {
  const base = root.replaceAll("\\", "/").replace(/\/+$/u, "");
  return dir === base || dir.startsWith(`${base}/`);
};

export function nativeDenyHealth(
  host: NativeDenyHost,
  options: PermissionPaths = {},
): NativeDenyHealth {
  const { home } = resolvePaths(options);
  const base = { host, missing: [], stale: [], recorded: false };
  if (host === "pi")
    return existsSync(path.join(home, ".pi"))
      ? { ...base, state: "none" }
      : { ...base, state: "no-host" };
  const target = permissionTarget(host, options);
  if (!existsSync(target.hostDir)) return { ...base, state: "no-host" };
  const guarded = guardedDirs(options);
  if (host === "codex") {
    const config = path.join(target.hostDir, "config.toml");
    const { mode, roots } = codexSandbox(readText(config) ?? "");
    const open = roots.find((root) =>
      [...guarded.state, ...guarded.config].some((dir) => within(dir, root)),
    );
    const risk =
      mode === "danger-full-access"
        ? `sandbox_mode "danger-full-access" in ${config} lets agent commands write the guarded paths`
        : open
          ? `writable_roots in ${config} holds ${open}, which holds a guarded path`
          : undefined;
    return {
      ...base,
      state: "none",
      file: config,
      sandbox: `sandbox_mode ${mode ? `"${mode}"` : "not set (Codex picks one per project trust)"}`,
      ...(risk ? { risk } : {}),
    };
  }
  const recorded = readOwnership(options).hosts[host] !== undefined;
  const jsonc = host === "opencode" ? onlyJsonc(target.file) : null;
  if (jsonc)
    return {
      ...base,
      recorded,
      state: "blocked",
      file: jsonc,
      missing: nativeDenyEntries(host, guarded),
      reason: JSONC_BLOCKED,
    };
  const value = readRecord(target.file);
  const text = readText(target.file);
  if (text !== null && text.trim() !== "" && value === null)
    return { ...base, recorded, state: "unreadable", file: target.file };
  const config = value ?? {};
  const dotted = DENY_AT[host];
  const expected = nativeDenyEntries(host, guarded);
  const wanted = new Set(expected);
  const present = new Set(denyEntriesAt(config, dotted));
  const previous = readOwnership(options).hosts[host]?.owned;
  const owned = new Set(ownedList(previous, dotted));
  // What setup would refuse to merge into (OpenCode's `permission.edit: "allow"`, a list that is not one).
  const blocked = mergeFor(host, config, null, {
    deny: expected,
    skip: {},
    ...(previous ? { previous } : {}),
  }).error;
  const stale = [...present].filter(
    (entry) => isNativeDeny(host, dotted, entry) && !wanted.has(entry) && owned.has(entry),
  );
  const missing = expected.filter((entry) => !present.has(entry));
  const sandbox =
    host === "claude-code"
      ? `sandbox ${valueFrom(config, "sandbox", "enabled") === true ? "on" : "off"}`
      : host === "cursor"
        ? `sandbox.mode ${String(valueFrom(config, "sandbox", "mode") ?? "disabled")}`
        : undefined;
  return {
    host,
    state: stale.length ? "stale" : missing.length ? (blocked ? "blocked" : "missing") : "present",
    file: target.file,
    missing,
    stale,
    recorded,
    ...(blocked && missing.length ? { reason: blocked } : {}),
    ...(sandbox ? { sandbox } : {}),
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
