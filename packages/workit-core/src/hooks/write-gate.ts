// The before-write gate (S17). With no writer lease, a branch task's unmet
// before-write requirements (an open product choice, a missing plan) deny
// working-tree edits where the host has a pre-write hook, naming the exact
// unblock. History moves (commit, merge, rebase, stash pop) are not edits.
// Reads only the task index, one task snapshot and the ledger; never
// migrates, never captures a candidate, and fails open on any state error.
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileSignature, TaskStore } from "../core/task-store";
import { latestJudgment, writeBlockers, type WriteBlocker } from "../core/policy/derive";
import { applicableDecision } from "../core/task-evaluation";
import {
  claimLiveSession,
  liveConflict,
  type LiveConflict,
  type LiveDeps,
  type LiveOwner,
} from "../core/live-session";
import { workspaceLiveSessionGuard } from "../core/workspaces";
import { ledgerPath } from "../ledger";
import type { HookDecision } from "./protocol";
import { segmentsOf, type ShellDialect } from "./shell-words";

const NONE: HookDecision = { kind: "none" };

const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

/**
 * The real path of `file`: the nearest existing ancestor resolved through
 * symlinks (macOS /var → /private/var), then the not-yet-existing rest.
 */
const canonical = (file: string): string => {
  let rest = "";
  for (let dir = path.resolve(file); ; dir = path.dirname(dir)) {
    try {
      return path.join(realpathSync(dir), rest);
    } catch {
      if (path.dirname(dir) === dir) return path.resolve(file);
      rest = rest ? path.join(path.basename(dir), rest) : path.basename(dir);
    }
  }
};

/**
 * Writes the gate never blocks: files outside the checkout (e.g. /tmp),
 * Markdown (*.md, *.mdx), the top-level `docs/` tree, any `plans/` directory,
 * and the plan files the task's judgment cites.
 */
const exempt = (cwd: string, root: string, file: string, plans: ReadonlySet<string>): boolean => {
  const fold = (value: string) => (CASE_INSENSITIVE ? value.toLowerCase() : value);
  const relative = path.relative(fold(canonical(root)), fold(canonical(path.resolve(cwd, file))));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return true;
  const posix = relative.split(path.sep).join("/");
  const segments = posix.split("/");
  return (
    /\.mdx?$/i.test(posix) ||
    segments[0] === "docs" ||
    segments.includes("plans") ||
    [...plans].some((plan) => fold(plan) === posix)
  );
};

const PREFIXES = new Set(["sudo", "command", "env", "nohup", "time", "exec", "xargs"]);
const operands = (words: string[]) => words.filter((item) => !item.startsWith("-"));

/** The files one simple command edits: [] none, null unknown. */
const editsOf = (input: string[]): string[] | null => {
  let words = input;
  while (words.length && (PREFIXES.has(words[0]) || /^\w+=/.test(words[0]))) words = words.slice(1);
  const [verb, ...args] = words;
  const name = (verb?.split(/[\\/]/).at(-1) ?? "").toLowerCase();
  if (!name || name === "workit" || (name === "npx" && args.some((item) => /workit/.test(item))))
    return [];
  switch (name) {
    case "touch":
    case "mkdir":
    case "rm":
    case "rmdir":
    case "tee":
    case "mv":
    case "truncate":
      return operands(args);
    case "cp":
    case "ln":
    case "install": {
      const target = args.indexOf("-t");
      if (target >= 0) return args[target + 1] ? [args[target + 1]] : null;
      const last = operands(args).at(-1);
      return last ? [last] : null;
    }
    case "dd":
      return args.filter((item) => item.startsWith("of=")).map((item) => item.slice(3));
    case "sed":
    case "perl": {
      if (!args.some((item) => /^-[a-zA-Z]*i|^--in-place/.test(item))) return [];
      const scripted = args.some((item) => item === "-e" || item === "-f");
      const files: string[] = [];
      for (let index = 0; index < args.length; index++) {
        if (args[index] === "-e" || args[index] === "-f") index++;
        else if (!args[index].startsWith("-")) files.push(args[index]);
      }
      return scripted ? files : files.slice(1);
    }
    case "patch":
      return null;
    // PowerShell (Claude Code's PowerShell tool): the path parameter, else the first operand.
    case "set-content":
    case "add-content":
    case "out-file":
    case "new-item":
    case "ni":
    case "remove-item":
    case "del":
    case "copy-item":
    case "move-item": {
      const flag = args.findIndex((item) =>
        /^-(?:path|filepath|literalpath|destination)$/i.test(item),
      );
      if (flag >= 0) return args[flag + 1] ? [args[flag + 1]] : null;
      const files = operands(args);
      if (name === "move-item") return files.length ? files : null;
      const file = name === "copy-item" ? files.at(-1) : files[0];
      return file ? [file] : null;
    }
    case "git": {
      const sub = operands(args)[0];
      if (sub === "apply") return null;
      if (sub === "restore" || sub === "mv" || sub === "rm") return operands(args).slice(1);
      if (sub === "checkout" && args.includes("--")) return args.slice(args.indexOf("--") + 1);
      // commit, merge, rebase, stash, cherry-pick… move history, not edits.
      return [];
    }
    default:
      return [];
  }
};

/**
 * Whether a shell command recognizably edits files (redirects, tee, touch,
 * mkdir, cp/mv/rm, `sed -i`/`perl -i`, dd, and working-tree git: apply,
 * restore, checkout --, mv, rm). `targets` lists the files when they are all
 * known, else null. Interpreters and formatters are not detected; Workit's
 * own commands never count.
 */
export const shellWrites = (command: string): { writes: boolean; targets: string[] | null } => {
  const targets: string[] = [];
  let unknown = false;
  for (const segment of segmentsOf(command)) {
    targets.push(
      ...segment.redirects.filter((item) => !/^\/dev\/(?:null|stdout|stderr|tty)$/.test(item)),
    );
    const edits = editsOf(segment.words);
    if (edits === null) unknown = true;
    else targets.push(...edits);
  }
  if (!unknown && targets.length === 0) return { writes: false, targets: null };
  return { writes: true, targets: unknown ? null : targets };
};

type Gate = { blockers: WriteBlocker[]; root: string; plans: Set<string> };
type Cached = Gate & { key: string; planKey: string };
const cache = new Map<string, Cached>();

const planKeyOf = (root: string, plans: Iterable<string>) =>
  [...plans].map((file) => fileSignature(path.resolve(root, file)) ?? "-").join("\0");

/** Unmet, unwaived before-write requirements of the checkout branch's open task. */
const gateFor = (cwd: string): Gate | null => {
  const store = new TaskStore(cwd);
  const listed = store.listTaskIndex();
  if (!listed.ok) return null;
  const key = store.currentKey();
  if (!key.ok) return null;
  const entry = listed.data
    .filter((item) => item.key === key.data.key && item.status !== "closed")
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!entry) return { blockers: [], root: store.root, plans: new Set() };
  const ledger = ledgerPath(store.root);
  const cacheKey = `${entry.id}\0${entry.revision}\0${(ledger.ok && fileSignature(ledger.value)) || "-"}`;
  const hit = cache.get(store.root);
  // A cited plan created or edited since changes the answer (long-lived hosts).
  if (hit && hit.key === cacheKey && hit.planKey === planKeyOf(store.root, hit.plans)) return hit;
  const task = store.readTask(entry.id);
  if (!task.ok) return null;
  const workspace = store.readWorkspace();
  const plans = new Set(
    (latestJudgment(task.data)?.refs ?? []).flatMap((ref) =>
      ref.kind === "file" ? [ref.path] : [],
    ),
  );
  // An approved limitation clears a waivable requirement, as at close.
  const blockers = writeBlockers(task.data, store.root).filter((blocker) => {
    const requirement = task.data.policy?.requirements.find(
      (item) => item.ruleId === blocker.ruleId && item.before === "write",
    );
    return !(
      requirement?.acceptanceAllowed &&
      workspace.ok &&
      workspace.data &&
      applicableDecision(task.data, workspace.data, requirement, store.root).length > 0
    );
  });
  const gate: Cached = {
    blockers,
    root: store.root,
    plans,
    key: cacheKey,
    planKey: planKeyOf(store.root, plans),
  };
  cache.set(store.root, gate);
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return gate;
};

// --- the live-session guard (#274) ------------------------------------------

/** git subcommands that change a checkout's files, index or HEAD. */
const MUTATING_GIT = new Set([
  "add",
  "am",
  "apply",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "merge",
  "mv",
  "pull",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
]);
/** `workit git` verbs that commit or move HEAD in the checkout. */
const MUTATING_WORKIT_GIT = new Set(["commit", "branch", "sync"]);

/** A placeholder file name that stands for its directory (an unknown write, a git command). */
const DIR_TARGET = ".workit-live-target";

/** A one-command override: `WORKIT_LIVE_SESSION=override <command>`. */
const OVERRIDE = "WORKIT_LIVE_SESSION=override";

/**
 * The directory a git command mutates (`-C <dir>` honored, else cwd), or null
 * when it only reads. `workit git commit|branch|sync` count too.
 */
const gitMutationDir = (cwd: string, input: string[]): string | null => {
  let words = input;
  while (words.length && (PREFIXES.has(words[0]) || /^\w+=/.test(words[0]))) words = words.slice(1);
  const name = (words[0]?.split(/[\\/]/).at(-1) ?? "").toLowerCase();
  if (name === "workit" && words[1] === "git")
    return MUTATING_WORKIT_GIT.has(words[2] ?? "") ? cwd : null;
  if (name !== "git") return null;
  let dir = cwd;
  for (let index = 1; index < words.length; index++) {
    const word = words[index];
    if (word === "-C") dir = path.resolve(dir, words[++index] ?? ".");
    else if (word === "-c" || word === "--git-dir" || word === "--work-tree") index++;
    else if (!word.startsWith("-")) {
      if (!MUTATING_GIT.has(word)) return null;
      // `git stash list|show` only reads.
      if (word === "stash" && ["list", "show"].includes(words[index + 1] ?? "")) return null;
      return dir;
    }
  }
  return null;
};

const HOST_LABELS: Readonly<Record<string, string>> = {
  claude_code: "Claude Code",
  opencode: "OpenCode",
  codex_cli: "Codex CLI",
  codex_desktop: "Codex Desktop",
  cursor: "Cursor",
  pi: "Pi",
};

const ageText = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
};

const liveDeny = ({ marker, checkout, ageMs, file }: LiveConflict): HookDecision => {
  const unblock = `Work in your own worktree (\`git worktree add <path> -b <branch>\`, or \`workit fanout worktree create <slice>\`). Only if the user confirms that session is finished: release it with \`rm '${file}'\`, or prefix one command with ${OVERRIDE}.`;
  return {
    kind: "deny",
    reason: `workit live-session guard: ${checkout} belongs to another live agent session, ${HOST_LABELS[marker.host] ?? marker.host} session ${marker.session}${marker.pid === null ? "" : ` (pid ${marker.pid})`}, last active ${ageText(ageMs)} ago. Do not edit a checkout another session is working in; read-only commands stay allowed. ${unblock}`,
    unblock,
  };
};

/** Targets outside `.git` (the markers live there), one per directory. */
const guarded = (targets: readonly string[]): string[] => {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const dir = path.dirname(target);
    if (target.split(/[\\/]/).includes(".git") || seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
};

/**
 * Deny when a target's checkout belongs to another live session and its
 * workspace keeps `liveSessionGuard` on. Fails open.
 */
const liveGate = (owner: LiveOwner, targets: readonly string[], deps?: LiveDeps): HookDecision => {
  try {
    for (const target of guarded(targets)) {
      const conflict = liveConflict(target, owner, deps);
      if (conflict && workspaceLiveSessionGuard(conflict.checkout)) return liveDeny(conflict);
    }
  } catch {
    // Fail open.
  }
  return NONE;
};

const claimAll = (owner: LiveOwner, targets: readonly string[], deps?: LiveDeps): void => {
  for (const target of guarded(targets)) claimLiveSession(target, owner, deps);
};

/** The absolute paths an edit touches: its files, or cwd itself when unknown. */
const liveTargets = (cwd: string, paths: readonly string[] | null): string[] =>
  paths?.length ? paths.map((file) => path.resolve(cwd, file)) : [path.join(cwd, DIR_TARGET)];

/**
 * Deny a working-tree edit while the branch task has unmet before-write
 * requirements. `paths` are the files the tool writes, or null when unknown
 * (a shell write, a patch whose headers cannot be read); unknown or empty
 * targets are gated, and an edit touching only exempt files is always allowed.
 * With `owner` (the hook's session), the live-session guard runs first, and
 * an allowed edit refreshes the owner's marker in each checkout it touches.
 */
export function writeGate(
  cwd: string,
  paths: readonly string[] | null,
  owner?: LiveOwner | null,
  deps?: LiveDeps,
): HookDecision {
  if (!owner) return beforeWriteGate(cwd, paths);
  const targets = liveTargets(cwd, paths);
  const live = liveGate(owner, targets, deps);
  if (live.kind !== "none") return live;
  const decision = beforeWriteGate(cwd, paths);
  if (decision.kind === "none") claimAll(owner, targets, deps);
  return decision;
}

/**
 * The write gates on one shell command: the live-session guard on its writes
 * and mutating git commands (`git commit`, `switch`, `reset`…; `-C` honored;
 * a `WORKIT_LIVE_SESSION=override` prefix skips it), then the before-write
 * gate on its writes. An allowed mutation refreshes the owner's marker.
 */
export function shellGate(
  cwd: string,
  command: string,
  owner: LiveOwner | null,
  dialect: ShellDialect = "posix",
  deps?: LiveDeps,
): HookDecision {
  const writes = shellWrites(command);
  let targets: string[] = [];
  let overridden = false;
  if (owner) {
    try {
      const segments = segmentsOf(command, dialect);
      overridden = segments.some((segment) => segment.words.includes(OVERRIDE));
      const dirs = segments.flatMap((segment) => {
        const dir = gitMutationDir(cwd, segment.words);
        return dir === null ? [] : [path.join(dir, DIR_TARGET)];
      });
      targets = [...(writes.writes ? liveTargets(cwd, writes.targets) : []), ...dirs];
    } catch {
      targets = [];
    }
  }
  if (owner && targets.length && !overridden) {
    const live = liveGate(owner, targets, deps);
    if (live.kind !== "none") return live;
  }
  const decision = writes.writes ? beforeWriteGate(cwd, writes.targets) : NONE;
  if (owner && targets.length && decision.kind === "none") claimAll(owner, targets, deps);
  return decision;
}

function beforeWriteGate(cwd: string, paths: readonly string[] | null): HookDecision {
  try {
    const gate = gateFor(cwd);
    if (!gate || gate.blockers.length === 0) return NONE;
    if (paths?.length && paths.every((file) => exempt(cwd, gate.root, file, gate.plans)))
      return NONE;
    const reasons = gate.blockers.map((item) => `${item.ruleId}: ${item.reason}`).join("; ");
    return {
      kind: "deny",
      reason: `workit before-write gate: ${reasons}. Markdown, docs/, plans/ and files outside the checkout stay writable.`,
      unblock: gate.blockers[0].reason,
    };
  } catch {
    return NONE;
  }
}
