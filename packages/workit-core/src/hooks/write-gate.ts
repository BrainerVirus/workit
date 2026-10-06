// The before-write gate (S17). With no writer lease, a branch task's unmet
// before-write requirements (an open product choice, a missing plan) deny
// writes where the host has a pre-write hook, naming the exact unblock.
// Reads only the task index, one task snapshot and the ledger; never
// migrates, never captures a candidate, and fails open on any state error.
import path from "node:path";
import { fileSignature, TaskStore } from "../core/task-store";
import { writeBlockers, type WriteBlocker } from "../core/policy/derive";
import { ledgerPath } from "../ledger";
import type { HookDecision } from "./protocol";

const NONE: HookDecision = { kind: "none" };

/** Plans, specs and notes stay writable so a plan requirement can be met. */
const exempt = (cwd: string, file: string): boolean => {
  const relative = path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join("/");
  if (/\.(md|mdx|markdown|txt|rst|adoc)$/i.test(relative)) return true;
  return relative
    .split("/")
    .some((segment) => ["docs", "doc", "plans", "specs", ".workit"].includes(segment));
};

const stripQuoted = (command: string): string =>
  command.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');

const WRITE_VERB =
  /(?:^|[;&|(]\s*|\bsudo\s+|\bxargs\s+)(?:tee|touch|mkdir|rm|rmdir|mv|cp|truncate|install|ln|patch|dd)\b|\bsed\s+(?:-\w*\s+)*-i|\bperl\s+(?:-\w*\s+)*-\w*i|\bgit\s+(?:apply|am|commit|cherry-pick|merge|rebase|revert|restore|mv|rm|stash\s+(?:pop|apply)|checkout\s+--)\b/;
const REDIRECT = /(?:^|[^<>&0-9])\d?>>?\s*([^\s;&|<>()]+)/g;

/**
 * Whether a shell command recognizably writes files. `targets` lists the
 * redirect targets when redirects are its only writes, else null (unknown).
 * Workit's own commands never count: they record, they do not edit.
 */
export const shellWrites = (command: string): { writes: boolean; targets: string[] | null } => {
  const plain = stripQuoted(command).trim();
  if (/^(?:npx\s+(?:-y\s+)?\S*workit\S*|\S*workit)(?:\s|$)/.test(plain) && !/[;&|]/.test(plain))
    return { writes: false, targets: null };
  const targets = [...plain.matchAll(REDIRECT)]
    .map((match) => match[1])
    .filter((target) => target && !/^\/dev\/(?:null|stdout|stderr|tty)$/.test(target));
  if (WRITE_VERB.test(plain)) return { writes: true, targets: null };
  return targets.length ? { writes: true, targets } : { writes: false, targets: null };
};

type Cached = { key: string; blockers: WriteBlocker[] };
const cache = new Map<string, Cached>();

/** Unmet before-write requirements of the checkout branch's open task, cached by revision and ledger. */
const blockersFor = (cwd: string): { blockers: WriteBlocker[]; root: string } | null => {
  const store = new TaskStore(cwd);
  const listed = store.listTaskIndex();
  if (!listed.ok) return null;
  const key = store.currentKey();
  if (!key.ok) return null;
  const entry = listed.data
    .filter((item) => item.key === key.data.key && item.status !== "closed")
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!entry) return { blockers: [], root: store.root };
  const ledger = ledgerPath(store.root);
  const cacheKey = `${entry.id}\0${entry.revision}\0${(ledger.ok && fileSignature(ledger.value)) || "-"}`;
  const hit = cache.get(store.root);
  if (hit && hit.key === cacheKey) return { blockers: hit.blockers, root: store.root };
  const task = store.readTask(entry.id);
  if (!task.ok) return null;
  const blockers = writeBlockers(task.data, store.root);
  cache.set(store.root, { key: cacheKey, blockers });
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return { blockers, root: store.root };
};

/**
 * Deny a write while the branch task has unmet before-write requirements.
 * `paths` are the files the tool writes, or null when unknown (shell); a
 * write that touches only plans, docs or Markdown is always allowed.
 */
export function writeGate(cwd: string, paths: readonly string[] | null): HookDecision {
  try {
    if (paths && paths.length > 0 && paths.every((file) => exempt(cwd, file))) return NONE;
    const found = blockersFor(cwd);
    if (!found || found.blockers.length === 0) return NONE;
    const reasons = found.blockers.map((item) => `${item.ruleId}: ${item.reason}`).join("; ");
    return {
      kind: "deny",
      reason: `workit before-write gate: ${reasons}. Plans, docs and Markdown stay writable.`,
      unblock: found.blockers[0].reason,
    };
  } catch {
    return NONE;
  }
}
