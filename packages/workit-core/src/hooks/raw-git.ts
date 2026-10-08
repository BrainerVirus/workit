// Raw git/forge commands on an agent's shell (audit B1/B2). Workit's delivery
// rules (merge grant, verdict gate, protected branches, session trailer) live
// in its own verbs, so a raw command skips them. The pre-tool hook:
//   - refuses, inside a Workit workspace, the raw forms that bypass a gate:
//     `gh pr merge`, `glab mr merge`, and `git push` to the workspace's push
//     remote onto a protected branch or the default target, naming the
//     workit command;
//   - lets routine raw commands run (`git commit`, a feature-branch push,
//     `gh pr create|view|checks`, `glab mr create|view`) with a short nudge.
// A raw `git commit` is recorded as the session's `commit.recorded` row so
// the author's own verdict never reads as independent. The pre-tool hook
// notes HEAD before the command (a marker in the commit's own repository);
// the post-tool hook records only a commit that moved HEAD away from it and
// was made after it, and that no other session claims. Hosts without a
// post-tool event settle the marker on the session's next shell command.
//
// Classification is string parsing only. Git is spawned only to read the new
// commit after a raw commit and the push remote before a deny; HEAD and the
// current branch are read from the git dir. Every failure answers "no
// decision": hooks fail open.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBranchPolicyFor } from "../core/branch";
import { resolveRuntimeWorkspaceVcs } from "../core/workspaces";
import { pushRemoteName } from "../git/rev";
import { appendHookObserved, readLedger } from "../ledger";
import { resolveStore, resolveTaskKey, type StoreLocation } from "../store/paths";
import type { HookDecision, HookInput } from "./protocol";
import { segmentsOf, type ShellDialect } from "./shell-words";

const NONE: HookDecision = { kind: "none" };

/** One git/gh/glab invocation: its arguments after global options, and the
 * directory it runs in relative to the hook's cwd (`cd x`, `git -C x`).
 * `dir` is undefined when it cannot be known (`cd -`, `cd $X`, an unmatched
 * `popd`): such an invocation never gets a decision. */
export type RawInvocation = {
  tool: "git" | "gh" | "glab";
  dir: string | null | undefined;
  args: string[];
};

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const PREFIXES = new Set(["sudo", "command", "env", "nohup", "time", "exec", "nice", "&"]);
const SCRIPT_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/;
const CD = new Set(["cd", "chdir", "set-location", "sl"]);
const PUSHD = new Set(["pushd", "push-location"]);
const POPD = new Set(["popd", "pop-location"]);
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

type Dir = string | null | undefined;

const isAbsolute = (value: string) =>
  path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");

const joinDir = (base: Dir, next: string): Dir => {
  if (base === undefined || /[$`*?]/.test(next) || next === "-") return undefined;
  const expanded =
    next === "~" || next.startsWith("~/") ? path.join(os.homedir(), next.slice(1)) : next;
  return base === null || isAbsolute(expanded) ? expanded : path.join(base, expanded);
};

/** The directory operand of `cd`/`Set-Location` (`-Path x`, `-LiteralPath x`). */
const cdTarget = (words: string[]): string | null => {
  const args = words.slice(1);
  const flag = args.findIndex((word) => /^-(?:literal)?path$/i.test(word));
  if (flag >= 0) return args[flag + 1] ?? null;
  return args.find((word) => word === "-" || !word.startsWith("-")) ?? null;
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

const commandName = (word: string | undefined) =>
  (word?.split(/[\\/]/).at(-1) ?? "").toLowerCase().replace(/\.exe$/, "");

/**
 * Every git/gh/glab invocation in a shell command: `&&`/`;`/`|` chains,
 * `cd`/`pushd`/`popd` before it (scoped to `( … )` groups), `git -C dir`,
 * env prefixes and `bash -c '…'` scripts.
 */
export function rawInvocations(
  command: string,
  dialect: ShellDialect = "posix",
  depth = 0,
): RawInvocation[] {
  const found: RawInvocation[] = [];
  let dir: Dir = null;
  const groups: Array<{ dir: Dir; stack: Dir[] }> = [];
  let stack: Dir[] = [];
  for (const segment of segmentsOf(command, dialect)) {
    if (segment.group === "open") {
      groups.push({ dir, stack: [...stack] });
      continue;
    }
    if (segment.group === "close") {
      const saved = groups.pop();
      if (saved) ({ dir, stack } = saved);
      continue;
    }
    const words = stripPrefixes(segment.words);
    const name = commandName(words[0]);
    if (CD.has(name)) {
      const target = cdTarget(words);
      dir = target === null ? os.homedir() : joinDir(dir, target);
      continue;
    }
    if (PUSHD.has(name)) {
      const target = cdTarget(words);
      stack.push(dir);
      dir = target === null || target === "-" ? undefined : joinDir(dir, target);
      continue;
    }
    if (POPD.has(name)) {
      dir = stack.length ? stack.pop() : undefined;
      continue;
    }
    if (SHELLS.has(name) && depth < 3) {
      const flag = words.findIndex((word, index) => index > 0 && SCRIPT_FLAG.test(word));
      const script = flag > 0 ? words[flag + 1] : undefined;
      if (script)
        for (const inner of rawInvocations(script, "posix", depth + 1))
          found.push({
            ...inner,
            dir:
              inner.dir === null
                ? dir
                : inner.dir === undefined
                  ? undefined
                  : joinDir(dir, inner.dir),
          });
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
      /** The remote named on the command line; null pushes to the default one. */
      remote: string | null;
    }
  | { kind: "merge"; forge: "gh" | "glab" }
  | { kind: "pr-create"; forge: "gh" | "glab" }
  | { kind: "pr-read"; forge: "gh" | "glab" };

/** git push options that take the next word as their value. */
const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);

const pushAction = (args: string[]): RawAction | null => {
  let force = false;
  let lease = false;
  let wholesale = false;
  let remote: string | null = null;
  const positionals: string[] = [];
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg === "--dry-run" || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(arg)) return null;
    if (arg === "--repo") remote = args[++index] ?? null;
    else if (arg.startsWith("--repo=")) remote = arg.slice("--repo=".length);
    else if (PUSH_VALUE_OPTIONS.has(arg)) index++;
    else if (arg === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg)) force = true;
    else if (arg.startsWith("--force-with-lease") || arg === "--force-if-includes") lease = true;
    else if (["--all", "--mirror", "--branches", "--tags"].includes(arg)) wholesale = true;
    else if (!arg.startsWith("-")) positionals.push(arg);
  }
  // `--repo` names the remote; positionals are then all refspecs.
  const specs = remote === null ? positionals.slice(1) : positionals;
  remote ??= positionals[0] ?? null;
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

/** Options whose next word is their value (never an option or subcommand). */
const VALUE_OPTIONS: Record<RawInvocation["tool"], ReadonlySet<string>> = {
  git: new Set([
    "-m",
    "--message",
    "-F",
    "--file",
    "-C",
    "-c",
    "--reuse-message",
    "--reedit-message",
    "--author",
    "--date",
    "--trailer",
    "-t",
    "--template",
    "--cleanup",
    "--fixup",
    "--squash",
    "-o",
    "--push-option",
    "--repo",
    "--receive-pack",
    "--exec",
  ]),
  gh: new Set(
    ["-b", "--body", "-F", "--body-file", "-t", "--title", "--subject", "-A", "--author-email"]
      .concat(["-B", "--base", "-H", "--head", "-l", "--label", "-a", "--assignee"])
      .concat(["-r", "--reviewer", "-m", "--milestone", "-p", "--project", "-T", "--template"])
      .concat(["--match-head-commit", "-R", "--repo"]),
  ),
  glab: new Set(
    ["-m", "--message", "--squash-message", "--sha", "-t", "--title", "-d", "--description"]
      .concat(["-b", "--target-branch", "-s", "--source-branch", "-l", "--label"])
      .concat(["-a", "--assignee", "--reviewer", "-R", "--repo"]),
  ),
};

/**
 * A help request: `help` as the subcommand (`git help push`, `gh pr help`),
 * or `--help`/`-h` where an option can stand, never as an option's value
 * (`git commit -m help` is a commit).
 */
const asksHelp = (invocation: RawInvocation): boolean => {
  const { tool, args } = invocation;
  if (args[0] === "help" || (tool !== "git" && args[1] === "help")) return true;
  const values = VALUE_OPTIONS[tool];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
    if (values.has(arg)) index++;
  }
  return false;
};

/** The workit meaning of one invocation; null for read-only, help or unrelated ones. */
export function rawAction(invocation: RawInvocation): RawAction | null {
  const args = invocation.args;
  if (asksHelp(invocation)) return null;
  const [first, second] = args;
  if (invocation.tool === "git") {
    if (first === "commit")
      return args.includes("--dry-run")
        ? null
        : { kind: "commit", amend: args.includes("--amend") };
    if (first === "push") return pushAction(args);
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

/** A push names the remote workit itself pushes to (or none, the default). */
const toPushRemote = (repo: Repo, remote: string | null): boolean => {
  if (remote === null) return true;
  try {
    // No known push remote: the named one may well be it.
    const pushRemote = pushRemoteName(repo.dir, repo.branch);
    return pushRemote === null || pushRemote === remote;
  } catch {
    return false;
  }
};

/** HEAD's commit read from the git dir (loose or packed ref), or null. */
const headSha = (repo: Repo): string | null => {
  const git = repo.location.git;
  if (!git || git.reftable) return null;
  try {
    const head = fs.readFileSync(path.join(git.gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40,64}$/.test(head)) return head;
    const ref = /^ref: (refs\/.+)$/.exec(head)?.[1];
    if (!ref) return null;
    const common = path.dirname(repo.location.dir);
    try {
      return fs.readFileSync(path.join(common, ref), "utf8").trim() || null;
    } catch {}
    const packed = fs.readFileSync(path.join(common, "packed-refs"), "utf8");
    return (
      new RegExp(`^([0-9a-f]{40,64}) ${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec(
        packed,
      )?.[1] ?? null
    );
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// pre-tool: refuse or nudge

const quote = (text: string) => `\`${text}\``;

const refusal = (action: RawAction, branch: string | null): string => {
  if (action.kind === "merge")
    return `workit: raw ${quote(action.forge === "gh" ? "gh pr merge" : "glab mr merge")} bypasses the merge grant and the verdict gate. Run ${quote("workit pr merge")} instead (it checks both; ${quote("workit help pr")}).`;
  return `workit: raw ${quote("git push")}${action.kind === "push" && action.blindForce ? " --force" : ""} onto ${branch}, a protected branch or the default target, bypasses workit's protected-branch check. Push your feature branch with ${quote("workit git push")} (${quote("workit git push --force-with-lease")} to rewrite it) and land it with ${quote("workit pr merge")}.`;
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

type Located = { action: RawAction; repo: Repo };

/** Raw invocations with a meaning, each with its Workit repository. */
const actionsIn = (cwd: string, command: string, dialect: ShellDialect): Located[] => {
  const out: Located[] = [];
  const repos = new Map<string, Repo | null>();
  for (const invocation of rawInvocations(command, dialect)) {
    if (invocation.dir === undefined) continue;
    const action = rawAction(invocation);
    if (!action) continue;
    const dir = path.resolve(cwd, invocation.dir ?? ".");
    if (!repos.has(dir)) {
      const repo = repoAt(dir);
      repos.set(dir, repo && isWorkitWorkspace(repo) ? repo : null);
    }
    const repo = repos.get(dir);
    if (repo) out.push({ action, repo });
  }
  return out;
};

/** Is `dir` in a repository Workit manages? */
export const inWorkitWorkspace = (dir: string): boolean => {
  const repo = repoAt(dir);
  return repo !== null && isWorkitWorkspace(repo);
};

/** A raw push, PR/MR create or merge in a Workit workspace (help and dry runs excluded). */
export const rawDelivery = (cwd: string, command: string, dialect: ShellDialect): boolean =>
  mentionsRawTool(command) &&
  actionsIn(cwd, command, dialect).some(
    ({ action }) => action.kind !== "commit" && action.kind !== "pr-read",
  );

/** Cheap pre-filter: no git/gh/glab word, nothing to do. */
const mentionsRawTool = (command: string) => /\b(?:git|gh|glab)\b/i.test(command);

const dialectOf = (input: HookInput): ShellDialect =>
  (input.event.kind === "shell.pre" || input.event.kind === "shell.post"
    ? input.event.dialect
    : undefined) ?? "posix";

/**
 * The pre-tool decision for a shell command: deny a gate bypass inside a
 * Workit workspace, else a nudge (as context) for routine raw delivery
 * commands, else nothing. Never throws, never writes.
 */
export function rawGitPre(input: HookInput, command: string): HookDecision {
  try {
    if (!mentionsRawTool(command)) return NONE;
    const nudges: string[] = [];
    for (const { action, repo } of actionsIn(input.cwd, command, dialectOf(input))) {
      if (action.kind === "merge") return deny(refusal(action, null));
      if (action.kind === "push")
        for (const target of action.targets) {
          const branch = target ?? repo.branch;
          if (branch && guardedBranch(repo.dir, branch) && toPushRemote(repo, action.remote))
            return deny(refusal(action, branch));
        }
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
// recording raw commits (B2)

/** The marker key for a shell call that has no post-tool event (Cursor). */
export const NEXT_COMMAND = "next";
/** A marker older than this is a command that never reported back. */
const MARKER_TTL_SECONDS = 3_600;

type Marker = { head: string | null; at: number };

const markerFile = (repo: Repo, session: string, key: string) =>
  path.join(
    repo.location.dir,
    "hooks",
    `commit-${createHash("sha256").update(`${session}\0${key}`).digest("hex").slice(0, 32)}.json`,
  );

/** The marker key of one shell call: its tool-use id, else the command. */
export const callKey = (toolUseId: string | null, command: string): string =>
  toolUseId ?? `cmd:${createHash("sha256").update(command).digest("hex")}`;

/**
 * Before a shell call that runs a raw `git commit` in a Workit workspace:
 * note HEAD and the time in that repository's store, under the session and
 * `key`. Never throws.
 */
export function noteRawCommit(input: HookInput, command: string, key: string): void {
  try {
    if (!input.session.id || !/\bcommit\b/.test(command)) return;
    const at = Math.floor(Date.now() / 1000);
    for (const { action, repo } of actionsIn(input.cwd, command, dialectOf(input))) {
      if (action.kind !== "commit") continue;
      const file = markerFile(repo, input.session.id, key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ head: headSha(repo), at } satisfies Marker)}\n`);
    }
  } catch {
    // Fail open: a missing marker only loses this record.
  }
}

type HeadCommit = { sha: string; committed: number; subject: string; trailer: string | null };

const headCommit = (dir: string): HeadCommit | null => {
  const run = spawnSync(
    "git",
    [
      "log",
      "-1",
      "--format=%H%x1f%ct%x1f%s%x1f%(trailers:key=Workit-Session,valueonly,separator=%x2c)",
    ],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    },
  );
  const [sha, committed, subject = "", trailer = ""] = (
    run.status === 0 ? run.stdout.trim() : ""
  ).split("\x1f");
  return sha && /^[0-9a-f]{40,64}$/.test(sha)
    ? { sha, committed: Number(committed), subject, trailer: trailer.trim() || null }
    : null;
};

/**
 * Settle one marker: record HEAD for the session when HEAD moved away from
 * the noted commit, the new commit was made at or after the note, and no
 * other session claims it (a ledger row or a Workit-Session trailer).
 */
const settle = (input: HookInput, repo: Repo, file: string): void => {
  let marker: Marker;
  try {
    marker = JSON.parse(fs.readFileSync(file, "utf8")) as Marker;
  } catch {
    return;
  }
  fs.rmSync(file, { force: true });
  const session = input.session.id;
  const now = Date.now() / 1000;
  if (typeof marker.at !== "number" || now - marker.at > MARKER_TTL_SECONDS) return;
  if (!session || !repo.branch) return;
  const head = headCommit(repo.dir);
  if (!head || head.sha === marker.head || head.committed < marker.at) return;
  if (head.trailer && head.trailer !== session) return;
  const ledger = readLedger(repo.dir);
  if (!ledger.ok) return;
  const claimed = ledger.value.rows.some(
    (row) => row.type === "commit.recorded" && (row.sha === head.sha || row.head === head.sha),
  );
  if (claimed) return;
  appendHookObserved(repo.dir, {
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
  });
};

/** Post-tool: a raw `git commit` the pre-tool hook noted is recorded for the session. */
export function rawGitPost(input: HookInput, command: string, key: string): void {
  try {
    if (!input.session.id || !/\bcommit\b/.test(command)) return;
    for (const { action, repo } of actionsIn(input.cwd, command, dialectOf(input)))
      if (action.kind === "commit") settle(input, repo, markerFile(repo, input.session.id, key));
  } catch {
    // Fail open: a lost record only weakens author detection.
  }
}

/**
 * A host without a post-tool event: the session's previous raw commit in
 * the checkout it works in is settled on its next shell command (one stat
 * when nothing is pending). A commit made in another repository through
 * `cd`/`-C` is settled only when a later command runs there.
 */
export function settlePendingCommit(input: HookInput): void {
  try {
    if (!input.session.id) return;
    const repo = repoAt(input.cwd);
    if (!repo) return;
    const file = markerFile(repo, input.session.id, NEXT_COMMAND);
    if (fs.existsSync(file)) settle(input, repo, file);
  } catch {
    // Fail open.
  }
}
