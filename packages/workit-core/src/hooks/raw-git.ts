// Raw git/forge commands on an agent's shell (audit B1/B2). Workit's delivery
// rules (merge grant, verdict gate, protected branches, session trailer) live
// in its own verbs, so a raw command skips them. The pre-tool hook:
//   - refuses, inside a Workit workspace, the raw forms that bypass a gate:
//     `gh pr merge`, `glab mr merge`, and `git push` onto a protected branch
//     or the default target (forced or not), naming the workit command;
//   - lets routine raw commands run (`git commit`, a feature-branch push,
//     `gh pr create|view|checks`, `glab mr create|view`) with a short nudge.
// The post-tool hook records a successful raw `git commit` as the session's
// `commit.recorded` row, so the author's own verdict never reads as
// independent. Hosts without a post-tool event record it on the session's
// next shell command instead (a pending marker in the store).
//
// Classification is string parsing only. Git is spawned only to read the new
// commit after a raw commit; the current branch is read from the git dir.
// Every failure answers "no decision": hooks fail open.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBranchPolicyFor } from "../core/branch";
import { resolveRuntimeWorkspaceVcs } from "../core/workspaces";
import { appendHookObserved, readLedger } from "../ledger";
import { resolveStore, resolveTaskKey, type StoreLocation } from "../store/paths";
import type { HookDecision, HookInput } from "./protocol";
import { segmentsOf } from "./shell-words";

const NONE: HookDecision = { kind: "none" };

/** One git/gh/glab invocation: its arguments after global options, and the
 * directory it runs in relative to the hook's cwd (`cd x`, `git -C x`). */
export type RawInvocation = { tool: "git" | "gh" | "glab"; dir: string | null; args: string[] };

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const PREFIXES = new Set(["sudo", "command", "env", "nohup", "time", "exec", "nice"]);
const SCRIPT_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/;
/** git global options that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set([
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
  "--super-prefix",
]);

const joinDir = (base: string | null, next: string): string | null => {
  if (next.includes("$") || next.includes("`")) return base;
  const expanded =
    next === "~" || next.startsWith("~/") ? path.join(os.homedir(), next.slice(1)) : next;
  return base === null || path.isAbsolute(expanded) ? expanded : path.join(base, expanded);
};

/** Drop env assignments, wrappers (`sudo`, `env -i`, `timeout 30`) and their options. */
const stripPrefixes = (input: string[]): string[] => {
  let words = input;
  for (;;) {
    const first = words[0];
    if (first === undefined) return words;
    if (/^\w+=/.test(first)) words = words.slice(1);
    else if (PREFIXES.has(first)) {
      words = words.slice(1);
      while (words[0]?.startsWith("-")) words = words.slice(words[0] === "-u" ? 2 : 1);
    } else if (first === "timeout") {
      words = words.slice(1);
      while (words[0]?.startsWith("-")) words = words.slice(1);
      words = words.slice(1);
    } else return words;
  }
};

/**
 * Every git/gh/glab invocation in a shell command: `&&`/`;`/`|` chains,
 * `cd` before it, `git -C dir`, env prefixes and `bash -c '…'` scripts.
 */
export function rawInvocations(command: string, depth = 0): RawInvocation[] {
  const found: RawInvocation[] = [];
  let dir: string | null = null;
  for (const segment of segmentsOf(command)) {
    const words = stripPrefixes(segment.words);
    const name = (words[0]?.split(/[\\/]/).at(-1) ?? "").toLowerCase();
    if (name === "cd" || name === "pushd") {
      dir = words[1] ? joinDir(dir, words[1]) : null;
      continue;
    }
    if (SHELLS.has(name) && depth < 3) {
      const flag = words.findIndex((word, index) => index > 0 && SCRIPT_FLAG.test(word));
      const script = flag > 0 ? words[flag + 1] : undefined;
      if (script)
        for (const inner of rawInvocations(script, depth + 1))
          found.push({ ...inner, dir: inner.dir === null ? dir : joinDir(dir, inner.dir) });
      continue;
    }
    if (name === "gh" || name === "glab") {
      found.push({ tool: name, dir, args: words.slice(1) });
      continue;
    }
    if (name !== "git") continue;
    let here = dir;
    let index = 1;
    for (; index < words.length; index++) {
      const word = words[index];
      if (word === "-C") here = words[index + 1] ? joinDir(here, words[++index]) : here;
      else if (GIT_VALUE_OPTIONS.has(word)) index++;
      else if (!word.startsWith("-")) break;
    }
    found.push({ tool: "git", dir: here, args: words.slice(index) });
  }
  return found;
}

/** What one raw invocation means for workit. */
export type RawAction =
  | { kind: "commit"; amend: boolean }
  | {
      kind: "push";
      /** Branches named by the refspecs; `null` stands for the current branch. */
      targets: Array<string | null>;
      /** Forced without a lease (`--force`, `-f`, `+refspec`). */
      blindForce: boolean;
      remote: string | null;
    }
  | { kind: "merge"; forge: "gh" | "glab" }
  | { kind: "pr-create"; forge: "gh" | "glab" }
  | { kind: "pr-read"; forge: "gh" | "glab" };

/** git push options that take the next word as their value. */
const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);

const pushAction = (args: string[]): RawAction => {
  let force = false;
  let lease = false;
  let wholesale = false;
  const positionals: string[] = [];
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (PUSH_VALUE_OPTIONS.has(arg)) index++;
    else if (arg === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg)) force = true;
    else if (arg.startsWith("--force-with-lease") || arg === "--force-if-includes") lease = true;
    else if (["--all", "--mirror", "--branches", "--tags"].includes(arg)) wholesale = true;
    else if (!arg.startsWith("-")) positionals.push(arg);
  }
  const [remote = null, ...specs] = positionals;
  const targets: Array<string | null> = [];
  for (const raw of specs) {
    if (raw.startsWith("+")) force = true;
    const spec = raw.replace(/^\+/, "");
    const colon = spec.indexOf(":");
    const destination = colon >= 0 ? spec.slice(colon + 1) : spec;
    if (!destination) continue;
    if (destination === "HEAD") targets.push(null);
    else if (destination.startsWith("refs/heads/")) targets.push(destination.slice(11));
    else if (!destination.startsWith("refs/")) targets.push(destination);
  }
  // No refspec pushes the current branch (push.default simple/current).
  if (specs.length === 0 && !wholesale) targets.push(null);
  return { kind: "push", targets, blindForce: force && !lease, remote };
};

/** The workit meaning of one invocation; null for read-only or unrelated ones. */
export function rawAction(invocation: RawInvocation): RawAction | null {
  const [first, second] = invocation.args;
  if (invocation.tool === "git") {
    if (first === "commit") return { kind: "commit", amend: invocation.args.includes("--amend") };
    if (first === "push") return pushAction(invocation.args);
    return null;
  }
  const forge = invocation.tool;
  const noun = forge === "gh" ? "pr" : "mr";
  if (first !== noun) return null;
  if (second === "merge") return { kind: "merge", forge };
  if (second === "create") return { kind: "pr-create", forge };
  if (["view", "checks", "status", "ci", "list"].includes(second ?? ""))
    return { kind: "pr-read", forge };
  return null;
}

// ---------------------------------------------------------------------------
// repository facts (filesystem only)

type Repo = { location: StoreLocation; dir: string; branch: string | null };

const repoAt = (dir: string): Repo | null => {
  const location = resolveStore(dir);
  if (location instanceof Error || !location.shared) return null;
  return { location, dir, branch: resolveTaskKey(dir, location).branch };
};

/** A repository Workit manages: it has a Workit store, or workspaces.json matches it. */
const isWorkitWorkspace = (repo: Repo): boolean => {
  if (fs.existsSync(repo.location.dir)) return true;
  try {
    return resolveRuntimeWorkspaceVcs(repo.location.top ?? repo.dir) !== null;
  } catch {
    return false;
  }
};

/** Protected by the branch policy, or the workspace's default target. */
const guardedBranch = (dir: string, branch: string): boolean => {
  try {
    const policy = resolveBranchPolicyFor(dir);
    return (
      policy.protected.has(branch.toLowerCase()) ||
      policy.defaultTargetBranch.toLowerCase() === branch.toLowerCase()
    );
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// pre-tool: refuse or nudge

const quote = (text: string) => `\`${text}\``;

const refusal = (action: RawAction, branch: string | null): string | null => {
  if (action.kind === "merge")
    return `workit: raw ${quote(action.forge === "gh" ? "gh pr merge" : "glab mr merge")} bypasses the merge grant and the verdict gate. Run ${quote("workit pr merge")} instead (it checks both; ${quote("workit help pr")}).`;
  if (action.kind === "push" && branch)
    return `workit: raw ${quote("git push")}${action.blindForce ? " --force" : ""} onto ${branch}, a protected branch or the default target, bypasses workit's protected-branch check. Push your feature branch with ${quote("workit git push")} (${quote("workit git push --force-with-lease")} to rewrite it) and land it with ${quote("workit pr merge")}.`;
  return null;
};

const nudgeFor = (action: RawAction, host: HookInput["host"], session: string): string | null => {
  switch (action.kind) {
    case "commit": {
      // Cursor's shell carries no conversation id: name it explicitly.
      const prefix = host === "cursor" && session ? `WORKIT_SESSION_ID=${session} ` : "";
      return action.amend
        ? `workit: raw ${quote("git commit --amend")} is recorded for this session; for new commits prefer ${quote(`${prefix}workit git commit -m '<msg>'`)} (adds the Workit-Session trailer and checks branch and commit policy).`
        : `workit: prefer ${quote(`${prefix}workit git commit -m '<msg>' [--all | -- <paths>]`)}: it adds the Workit-Session trailer and checks branch and commit policy.`;
    }
    case "push":
      return action.blindForce
        ? `workit: ${quote("git push --force")} overwrites without a lease; use ${quote("workit git push --force-with-lease")}.`
        : `workit: prefer ${quote("workit git push")}: it refuses protected branches and verifies the remote tip.`;
    case "pr-create":
      return `workit: prefer ${quote("workit pr create --fill")} (or --title/--body): it records the PR the merge gate checks.`;
    case "pr-read":
      return `workit: ${quote("workit pr status")} shows the PR, its checks and the verdict state; ${quote("workit ci wait")} waits for checks.`;
    case "merge":
      return null;
  }
};

/** Raw invocations that change history, each with its repository. */
const actionsIn = (cwd: string, command: string): Array<{ action: RawAction; repo: Repo }> => {
  const out: Array<{ action: RawAction; repo: Repo }> = [];
  const repos = new Map<string, Repo | null>();
  for (const invocation of rawInvocations(command)) {
    const action = rawAction(invocation);
    if (!action) continue;
    const dir = path.resolve(cwd, invocation.dir ?? ".");
    if (!repos.has(dir)) repos.set(dir, repoAt(dir));
    const repo = repos.get(dir);
    if (repo && isWorkitWorkspace(repo)) out.push({ action, repo });
  }
  return out;
};

/** Cheap pre-filter: no git/gh/glab word, nothing to do. */
const mentionsRawTool = (command: string) => /\b(?:git|gh|glab)\b/.test(command);

/**
 * The pre-tool decision for a shell command: deny a gate bypass inside a
 * Workit workspace, else a nudge (as context) for routine raw delivery
 * commands, else nothing. Never throws.
 */
export function rawGitPre(
  input: HookInput,
  command: string,
  options: { pending: boolean },
): HookDecision {
  try {
    if (!mentionsRawTool(command)) return NONE;
    const actions = actionsIn(input.cwd, command);
    const nudges: string[] = [];
    for (const { action, repo } of actions) {
      if (action.kind === "merge") return deny(refusal(action, null)!);
      if (action.kind === "push")
        for (const target of action.targets) {
          const branch = target ?? repo.branch;
          if (branch && guardedBranch(repo.dir, branch)) return deny(refusal(action, branch)!);
        }
      if (action.kind === "commit" && options.pending) markPending(input, repo);
      const nudge = nudgeFor(action, input.host, input.session.id);
      if (nudge && !nudges.includes(nudge)) nudges.push(nudge);
    }
    return nudges.length ? { kind: "context", text: nudges.join("\n") } : NONE;
  } catch {
    return NONE;
  }
}

const deny = (reason: string): HookDecision => ({ kind: "deny", reason, unblock: null });

// ---------------------------------------------------------------------------
// post-tool: record a raw commit for the session (B2)

/** A commit made within this window (or since a pending marker) is taken as this command's. */
const FRESH_SECONDS = 600;

type HeadCommit = { sha: string; committed: number; subject: string };

const headCommit = (dir: string): HeadCommit | null => {
  const run = spawnSync("git", ["log", "-1", "--format=%H%x1f%ct%x1f%s"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
  });
  const [sha, committed, subject = ""] = (run.status === 0 ? run.stdout.trim() : "").split("\x1f");
  return sha && /^[0-9a-f]{40,64}$/.test(sha)
    ? { sha, committed: Number(committed), subject }
    : null;
};

/**
 * Record HEAD as a commit of `input`'s session when it is new enough (made
 * at or after `since`, Unix seconds) and not recorded for the session yet.
 * True when a row was written.
 */
const recordCommit = (input: HookInput, repo: Repo, since: number): boolean => {
  const session = input.session.id;
  if (!session || !repo.branch) return false;
  const head = headCommit(repo.dir);
  if (!head || head.committed < since) return false;
  const ledger = readLedger(repo.dir);
  if (!ledger.ok) return false;
  const known = ledger.value.rows.some(
    (row) =>
      row.type === "commit.recorded" &&
      (row.sha === head.sha || row.head === head.sha) &&
      (row.session ?? row.actor.session) === session,
  );
  if (known) return false;
  return appendHookObserved(repo.dir, {
    type: "commit.recorded",
    actor: { host: input.host, session, agentId: input.session.agentId },
    branch: repo.branch,
    head: head.sha,
    sha: head.sha,
    session,
    agentId: input.session.agentId,
    subject: head.subject.slice(0, 200),
    files: [],
    fileCount: null,
    via: "raw_shell",
  }).ok;
};

/** Post-tool: a raw `git commit` that succeeded is recorded for the session. */
export function rawGitPost(input: HookInput, command: string, exitCode: number | null): void {
  try {
    if (exitCode !== null && exitCode !== 0) return;
    if (!/\bcommit\b/.test(command)) return;
    const since = Date.now() / 1000 - FRESH_SECONDS;
    for (const { action, repo } of actionsIn(input.cwd, command))
      if (action.kind === "commit") recordCommit(input, repo, since);
  } catch {
    // Fail open: a lost record only weakens author detection.
  }
}

// ---------------------------------------------------------------------------
// hosts without a post-tool event: a pending marker, settled next command

const markerPath = (store: string, session: string) =>
  path.join(
    store,
    "hooks",
    `pending-commit-${createHash("sha256").update(session).digest("hex").slice(0, 24)}.json`,
  );

const storeOf = (cwd: string): string | null => {
  const location = resolveStore(cwd);
  return location instanceof Error || !location.shared ? null : location.dir;
};

function markPending(input: HookInput, repo: Repo): void {
  const store = storeOf(input.cwd);
  if (!store || !input.session.id) return;
  const file = markerPath(store, input.session.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ dir: repo.dir, at: Math.floor(Date.now() / 1000) })}\n`,
  );
}

/**
 * On a host without a post-tool event, the session's previous raw commit (if
 * any) is recorded now: the marker names the repository and when the commit
 * command started. One stat when there is nothing pending.
 */
export function settlePendingCommit(input: HookInput): void {
  try {
    if (!input.session.id) return;
    const store = storeOf(input.cwd);
    if (!store) return;
    const file = markerPath(store, input.session.id);
    if (!fs.existsSync(file)) return;
    const marker = JSON.parse(fs.readFileSync(file, "utf8")) as { dir?: unknown; at?: unknown };
    fs.rmSync(file, { force: true });
    if (typeof marker.dir !== "string" || typeof marker.at !== "number") return;
    const repo = repoAt(marker.dir);
    if (repo) recordCommit(input, repo, marker.at - 1);
  } catch {
    // Fail open.
  }
}
