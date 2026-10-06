// The before-write gate (S17). With no writer lease, a branch task's unmet
// before-write requirements (an open product choice, a missing plan) deny
// working-tree edits where the host has a pre-write hook, naming the exact
// unblock. History moves (commit, merge, rebase, stash pop) are not edits.
// Reads only the task index, one task snapshot and the ledger; never
// migrates, never captures a candidate, and fails open on any state error.
import path from "node:path";
import { fileSignature, TaskStore } from "../core/task-store";
import { latestJudgment, writeBlockers, type WriteBlocker } from "../core/policy/derive";
import { applicableDecision } from "../core/task-evaluation";
import { ledgerPath } from "../ledger";
import type { HookDecision } from "./protocol";

const NONE: HookDecision = { kind: "none" };

/**
 * Writes the gate never blocks: files outside the checkout (e.g. /tmp),
 * Markdown (*.md, *.mdx), the top-level `docs/` tree, any `plans/` directory,
 * and the plan files the task's judgment cites.
 */
const exempt = (cwd: string, root: string, file: string, plans: ReadonlySet<string>): boolean => {
  const relative = path.relative(root, path.resolve(cwd, file));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return true;
  const posix = relative.split(path.sep).join("/");
  const segments = posix.split("/");
  return (
    /\.mdx?$/i.test(posix) ||
    segments[0] === "docs" ||
    segments.includes("plans") ||
    plans.has(posix)
  );
};

type Segment = { words: string[]; redirects: string[] };

/** A small shell tokenizer: quoted words, operators, redirects and heredoc bodies. */
const segmentsOf = (command: string): Segment[] => {
  const segments: Segment[] = [];
  let current: Segment = { words: [], redirects: [] };
  let word = "";
  let inWord = false;
  let pending: "redirect" | "input" | "heredoc" | null = null;
  const heredocs: string[] = [];
  const flushWord = () => {
    if (!inWord) return;
    if (pending === "redirect") {
      if (!word.startsWith("&")) current.redirects.push(word);
    } else if (pending === "heredoc") heredocs.push(word.replace(/^-/, ""));
    else if (pending !== "input") current.words.push(word);
    pending = null;
    word = "";
    inWord = false;
  };
  const flushSegment = () => {
    flushWord();
    if (current.words.length || current.redirects.length) segments.push(current);
    current = { words: [], redirects: [] };
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === "'" || char === '"') {
      const end = command.indexOf(char, index + 1);
      word += command.slice(index + 1, end < 0 ? undefined : end);
      inWord = true;
      index = end < 0 ? command.length : end;
    } else if (char === "\\" && index + 1 < command.length) {
      word += command[++index];
      inWord = true;
    } else if (char === "\n") {
      flushSegment();
      // Skip heredoc bodies up to each delimiter line.
      while (heredocs.length) {
        const delimiter = heredocs.shift()!;
        const lines = command.slice(index + 1).split("\n");
        const at = lines.findIndex((line) => line.trim() === delimiter);
        const skipped = (at < 0 ? lines : lines.slice(0, at + 1)).join("\n").length + 1;
        index += skipped;
      }
    } else if (/\s/.test(char)) flushWord();
    else if (";&|()".includes(char)) {
      if (char === "&" && command[index + 1] === ">") continue;
      flushSegment();
    } else if (char === ">") {
      // `2>`, `&>`: the fd digit is not a word.
      if (inWord && /^\d$/.test(word)) {
        word = "";
        inWord = false;
      } else flushWord();
      if (command[index + 1] === ">") index++;
      if (command[index + 1] === "&") {
        index++;
        word = "&";
        inWord = true;
      }
      pending = "redirect";
    } else if (char === "<") {
      flushWord();
      if (command[index + 1] === "<") {
        index++;
        if (command[index + 1] === "<") index++;
        pending = "heredoc";
      } else pending = "input";
    } else {
      word += char;
      inWord = true;
    }
  }
  flushSegment();
  return segments;
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

/**
 * Deny a working-tree edit while the branch task has unmet before-write
 * requirements. `paths` are the files the tool writes, or null when unknown
 * (shell); an edit touching only exempt files is always allowed.
 */
export function writeGate(cwd: string, paths: readonly string[] | null): HookDecision {
  try {
    const gate = gateFor(cwd);
    if (!gate || gate.blockers.length === 0) return NONE;
    if (paths && paths.every((file) => exempt(cwd, gate.root, file, gate.plans))) return NONE;
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
