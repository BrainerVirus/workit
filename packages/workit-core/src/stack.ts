// `workit stack` (D7, design §2.1 S12): plain base-branch chains on GitHub and
// GitLab, no Graphite and no `gh stack`/git-spice dependency.
//
// Truth is git ancestry plus the forge's PR bases. The stack file
// `<store>/stacks/<name>.json` (D13: under the git common dir, so it is shared
// by every worktree and survives worktree removal) is a reconstructible
// cache of the order and of what each branch was last built on:
//   {v:1, name, trunk, forge, repo, branches:[{branch, parent, pr, lastHead,
//    lastParentHead, patchId, merged}], updatedAt}
// `lastParentHead` is the parent tip a branch was last rebased onto, so a
// restack is `git rebase --onto <new parent tip> <lastParentHead> <branch>`.
//
// One writer per stack: every command that writes the file or touches the
// branches holds `<store>/stacks/<name>.json.lock` (a held lock answers
// `busy`; a lock left by a dead process is reclaimed).
//
// sync: after a parent merged (squash merges rewrite history, so a child must
// be rebased, design §0 #9) every remaining branch is restacked in order,
// pushed with a lease through the S11 push, and its PR retargeted. A rebase
// conflict stops with the rebase left in progress and the unblock command;
// unprocessed branches keep their recorded state. Each restack appends an
// observed `stack.restacked` row; when the change relative to its parent is
// identical (patch-id and exact diff hash), S13 carries the verdict through
// it. CI is never carried: it runs again on the new head.
//
// land: walks from the root and merges only the contiguous run of PRs that
// are open, based on trunk, READY (S10) and verdict-accepted (S13), one at a
// time through the S11 `pr merge` gates (merge grant, head-SHA guard). After
// each merge the rest is restacked and retargeted and the next PR's CI is
// awaited before it is judged. The first PR that does not qualify stops the
// run with the reason; it has already been moved onto trunk. Descendants are
// never armed for auto-merge.
//
// Optional adapters (`gh stack`, git-spice) can later implement `StackAdapter`
// and replace the built-in restack/retarget; nothing else depends on how the
// chain is rewritten.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { requireGrant, type GrantDecision } from "./autonomy";
import { mergePullRequest, type Sleep } from "./forge/pr-ops";
import {
  buildStatusDoc,
  pollDelay,
  waitVerdict,
  type ChecksState,
  type NextAction,
  type PrStatusDoc,
} from "./forge/report";
import type { ResolvedForge } from "./forge/resolve";
import type { ForgeResult, MergeMethod, PrState } from "./forge/types";
import { executePush, pushPreflight, recordedRemoteTip, type PushPlan } from "./git/ops";
import {
  currentBranch,
  fetchRefs,
  GIT_TIMEOUTS,
  hasCommit,
  headSha,
  mergeBase,
  patchId,
  pushRemoteName,
  remoteRefTip,
  resolveRef,
} from "./git/rev";
import {
  appendObserved,
  checkVerdicts,
  diffHash,
  ledgerLock,
  readLedger,
  storeRoot,
  type LedgerActor,
  type ReadRow,
  type VerdictBasis,
} from "./ledger";

export const STACK_VERSION = 1;

export type StackEntry = {
  branch: string;
  /** The branch this one is built on (the trunk for the root). */
  parent: string;
  pr: number | null;
  /** The branch tip when the stack last processed it. */
  lastHead: string | null;
  /** The parent tip it was last rebased onto (the `--onto` upstream for the next restack). */
  lastParentHead: string | null;
  /** patch-id of lastParentHead...lastHead. */
  patchId: string | null;
  /** Set once its PR merged (or its tip reached the trunk); skipped afterwards. */
  merged: { pr: number | null; mergeSha: string | null; at: string } | null;
};

export type StackFile = {
  v: number;
  name: string;
  trunk: string;
  forge: "github" | "gitlab" | null;
  repo: string | null;
  branches: StackEntry[];
  updatedAt: string;
};

export type StackError = {
  ok: false;
  code: "blocked" | "failed" | "unavailable" | "not_found" | "busy" | "invalid_input";
  error: string;
  unblock?: string;
  data?: Record<string, unknown>;
};
export type StackResult<T> = { ok: true; data: T } | StackError;

const stackFail = (
  code: StackError["code"],
  error: string,
  unblock?: string,
  data?: Record<string, unknown>,
): StackError => ({
  ok: false,
  code,
  error,
  ...(unblock ? { unblock } : {}),
  ...(data ? { data } : {}),
});

const fromForge = (result: Extract<ForgeResult<unknown>, { ok: false }>): StackError =>
  stackFail(result.code, result.error, result.unblock);

/**
 * Test and adapter seams. `pushPlan` decides where a branch is pushed (the
 * S11 preflight by default); `adapter` is where an optional `gh stack` /
 * git-spice adapter would plug in later. Only the built-in one ships.
 */
export type StackAdapter = {
  name: string;
  /** Rebase `branch` from `from` onto `onto`; the built-in one runs git rebase --onto. */
  restack(cwd: string, input: { branch: string; onto: string; from: string }): RestackOutcome;
};

export const stackDeps: {
  pushPlan: (cwd: string, branch: string) => ForgeResult<PushPlan>;
  adapter: StackAdapter;
} = {
  pushPlan: (cwd, branch) => pushPreflight(cwd, { branch }),
  adapter: { name: "git", restack: (cwd, input) => gitRestack(cwd, input) },
};

// ---------------------------------------------------------------------------
// git plumbing

type GitRun = { ok: boolean; stdout: string; stderr: string };

const gitRun = (cwd: string, args: string[], timeoutMs: number = GIT_TIMEOUTS.local): GitRun => {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      LC_ALL: "C",
      LANGUAGE: "C",
    },
  });
  return {
    ok: run.status === 0,
    stdout: run.stdout ?? "",
    stderr: run.error ? String(run.error.message) : (run.stderr ?? ""),
  };
};

const safeRef = (value: string): boolean => value.length > 0 && !value.startsWith("-");

const isAncestor = (cwd: string, ancestor: string, descendant: string): boolean =>
  safeRef(ancestor) &&
  safeRef(descendant) &&
  gitRun(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]).ok;

const branchTip = (cwd: string, branch: string): string | null =>
  resolveRef(cwd, `refs/heads/${branch}`);

/** The worktree that has `branch` checked out, if any. */
function worktreeOf(cwd: string, branch: string): string | null {
  const list = gitRun(cwd, ["worktree", "list", "--porcelain"]);
  if (!list.ok) return null;
  let current: string | null = null;
  for (const line of list.stdout.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && current) return current;
  }
  return null;
}

/** A rebase (or am) stopped in this worktree. */
function rebaseInProgress(dir: string): boolean {
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const found = gitRun(dir, ["rev-parse", "--path-format=absolute", "--git-path", name]);
    if (found.ok && fs.existsSync(found.stdout.trim())) return true;
  }
  return false;
}

const trackedDirt = (dir: string): boolean => {
  const status = gitRun(dir, ["status", "--porcelain", "--untracked-files=no"]);
  return !status.ok || status.stdout.trim() !== "";
};

export type RestackOutcome =
  | { ok: true; head: string }
  | { ok: false; conflict: boolean; worktree: string; error: string };

/**
 * `git rebase --onto <onto> <from> <branch>`, in the worktree that has the
 * branch checked out (else here). Never autostashes and never updates other
 * refs (`rebase.updateRefs` would move sibling stack branches behind our back).
 */
function gitRestack(
  cwd: string,
  input: { branch: string; onto: string; from: string },
): RestackOutcome {
  const owner = worktreeOf(cwd, input.branch);
  const dir = owner ?? cwd;
  const args = [
    "-c",
    "rebase.autoStash=false",
    "-c",
    "rebase.updateRefs=false",
    "rebase",
    "--no-autosquash",
    "--onto",
    input.onto,
    input.from,
    ...(owner ? [] : [input.branch]),
  ];
  const run = gitRun(dir, args, GIT_TIMEOUTS.worktree);
  if (run.ok) {
    const head = branchTip(cwd, input.branch);
    return head
      ? { ok: true, head }
      : { ok: false, conflict: false, worktree: dir, error: `${input.branch} vanished` };
  }
  if (rebaseInProgress(dir))
    return { ok: false, conflict: true, worktree: dir, error: firstLine(run) };
  return { ok: false, conflict: false, worktree: dir, error: firstLine(run) };
}

const firstLine = (run: GitRun): string =>
  (`${run.stderr}\n${run.stdout}`.split("\n").find((line) => line.trim()) ?? "git failed")
    .trim()
    .slice(0, 300);

// ---------------------------------------------------------------------------
// store

const fileFor = (name: string): string => `${encodeURIComponent(name)}.json`;

export function stacksDir(cwd: string): StackResult<string> {
  const root = storeRoot(cwd);
  if (!root.ok) return stackFail(root.code, root.error, root.unblock);
  return { ok: true, data: path.join(root.value.root, "stacks") };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** Tolerant read (D17): unknown keys are ignored, required keys are checked. */
function parseStack(raw: unknown): StackFile | null {
  if (!isRecord(raw) || !Array.isArray(raw.branches)) return null;
  const name = str(raw.name);
  const trunk = str(raw.trunk);
  if (!name || !trunk) return null;
  const branches: StackEntry[] = [];
  for (const item of raw.branches) {
    if (!isRecord(item)) return null;
    const branch = str(item.branch);
    if (!branch) return null;
    const merged = isRecord(item.merged)
      ? {
          pr: typeof item.merged.pr === "number" ? item.merged.pr : null,
          mergeSha: str(item.merged.mergeSha),
          at: str(item.merged.at) ?? "",
        }
      : null;
    branches.push({
      branch,
      parent: str(item.parent) ?? trunk,
      pr: typeof item.pr === "number" ? item.pr : null,
      lastHead: str(item.lastHead),
      lastParentHead: str(item.lastParentHead),
      patchId: str(item.patchId),
      merged,
    });
  }
  return {
    v: typeof raw.v === "number" ? raw.v : STACK_VERSION,
    name,
    trunk,
    forge: raw.forge === "github" || raw.forge === "gitlab" ? raw.forge : null,
    repo: str(raw.repo),
    branches,
    updatedAt: str(raw.updatedAt) ?? "",
  };
}

export function readStack(cwd: string, name: string): StackResult<StackFile | null> {
  const dir = stacksDir(cwd);
  if (!dir.ok) return dir;
  const file = path.join(dir.data, fileFor(name));
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, data: null };
    return stackFail("unavailable", `cannot read ${file}: ${(error as Error).message}`);
  }
  let parsed: StackFile | null = null;
  try {
    parsed = parseStack(JSON.parse(text));
  } catch {
    parsed = null;
  }
  return parsed
    ? { ok: true, data: parsed }
    : stackFail(
        "failed",
        `stack file ${file} is not a valid stack`,
        `workit stack plan --name ${name} <branch…>  # rebuild it`,
      );
}

/** Atomic write (temp file + rename) so a reader never sees half a stack. */
export function writeStack(
  cwd: string,
  stack: StackFile,
  now: Date = new Date(),
): StackResult<void> {
  const dir = stacksDir(cwd);
  if (!dir.ok) return dir;
  const file = path.join(dir.data, fileFor(stack.name));
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir.data, { recursive: true });
    stack.updatedAt = now.toISOString();
    fs.writeFileSync(temp, `${JSON.stringify(stack, null, 2)}\n`);
    fs.renameSync(temp, file);
    return { ok: true, data: undefined };
  } catch (error) {
    fs.rmSync(temp, { force: true });
    return stackFail("unavailable", `cannot write ${file}: ${(error as Error).message}`);
  }
}

/** Every stack in the store, sorted by name (unreadable files are skipped). */
export function listStacks(cwd: string): StackResult<StackFile[]> {
  const dir = stacksDir(cwd);
  if (!dir.ok) return dir;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir.data).filter((name) => name.endsWith(".json"));
  } catch {
    return { ok: true, data: [] };
  }
  const out: StackFile[] = [];
  for (const name of names.toSorted()) {
    const read = readStack(cwd, decodeURIComponent(name.slice(0, -".json".length)));
    if (read.ok && read.data) out.push(read.data);
  }
  return { ok: true, data: out };
}

/** The stack `name`, else the one holding the current branch, else the only one. */
export function selectStack(cwd: string, name: string | null): StackResult<StackFile> {
  if (name) {
    const read = readStack(cwd, name);
    if (!read.ok) return read;
    return read.data
      ? { ok: true, data: read.data }
      : stackFail(
          "not_found",
          `no stack named ${name}`,
          `workit stack plan --name ${name} <branch…>`,
        );
  }
  const all = listStacks(cwd);
  if (!all.ok) return all;
  const branch = currentBranch(cwd);
  const holding = all.data.filter((stack) =>
    stack.branches.some((entry) => entry.branch === branch),
  );
  if (holding.length === 1) return { ok: true, data: holding[0] };
  if (holding.length === 0 && all.data.length === 1) return { ok: true, data: all.data[0] };
  return stackFail(
    "not_found",
    holding.length > 1 || all.data.length > 1
      ? `several stacks match; pick one (${(holding.length > 1 ? holding : all.data).map((stack) => stack.name).join(", ")})`
      : "no stack is planned here",
    holding.length > 1 || all.data.length > 1
      ? "pass --name <stack>"
      : "workit stack plan [<branch>…]  # from the current branch chain by default",
  );
}

// ---------------------------------------------------------------------------
// single writer

const LOCK_WAIT_MS = 2_000;

const ownerPid = (token: string | null): number | null => {
  const match = token ? /^(\d+)-/u.exec(token) : null;
  return match ? Number(match[1]) : null;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Hold the stack's lock for `fn`. A lock held by a live process answers
 * `busy` after LOCK_WAIT_MS (retryable); one left by a dead process on this
 * machine is reclaimed. Long operations (land waits for CI) keep the lock
 * for their whole run, so there is no age-based takeover.
 */
export async function withStackLock<T>(
  cwd: string,
  name: string,
  fn: () => Promise<StackResult<T>>,
  waitMs: number = LOCK_WAIT_MS,
): Promise<StackResult<T>> {
  const dir = stacksDir(cwd);
  if (!dir.ok) return dir;
  const lock = path.join(dir.data, `${fileFor(name)}.lock`);
  try {
    fs.mkdirSync(dir.data, { recursive: true });
  } catch (error) {
    return stackFail("unavailable", `cannot create ${dir.data}: ${(error as Error).message}`);
  }
  const deadline = Date.now() + waitMs;
  let token: string | null = null;
  for (;;) {
    token = ledgerLock.acquire(lock);
    if (token) break;
    const observed = ledgerLock.token(lock);
    const pid = ownerPid(observed);
    if (pid !== null && !alive(pid) && ledgerLock.reap(lock, observed)) continue;
    if (Date.now() >= deadline)
      return stackFail(
        "busy",
        `stack ${name} is busy: another workit stack command${pid ? ` (pid ${pid})` : ""} holds ${lock}`,
        "retry when it finishes; remove the .lock directory only if no workit process is running",
        { lock, pid },
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try {
    return await fn();
  } finally {
    ledgerLock.release(lock, token);
  }
}

// ---------------------------------------------------------------------------
// plan

export type PlanInput = {
  name: string | null;
  trunk: string;
  /** Bottom (closest to trunk) first; empty: derive from the current branch. */
  branches: string[];
};

export type PlanOutcome = {
  stack: StackFile;
  created: boolean;
  /** Per branch: built on its parent's tip, and the PR base the forge reports. */
  checks: Array<{
    branch: string;
    parent: string;
    onParent: boolean;
    pr: number | null;
    prBase: string | null;
    baseMatches: boolean | null;
  }>;
  notes: string[];
};

const remoteFor = (cwd: string, resolved: ResolvedForge | null, trunk: string): string =>
  resolved?.baseRemote ?? pushRemoteName(cwd, trunk) ?? "origin";

/** The trunk tip: the remote-tracking ref when present, else the local branch. */
const trunkTip = (cwd: string, remote: string, trunk: string): string | null =>
  resolveRef(cwd, `refs/remotes/${remote}/${trunk}`) ?? branchTip(cwd, trunk);

/**
 * The current branch and the local branches it is stacked on: every local
 * branch (not the trunk) whose tip is a proper ancestor of HEAD and not
 * already on the trunk, ordered bottom-up.
 */
function deriveChain(cwd: string, trunk: string, base: string): StackResult<string[]> {
  const branch = currentBranch(cwd);
  if (!branch || branch === trunk)
    return stackFail(
      "invalid_input",
      branch ? `you are on the trunk ${trunk}` : "HEAD is detached",
      "switch to the top branch of the stack, or name the branches: workit stack plan <bottom> … <top>",
    );
  const refs = gitRun(cwd, [
    "for-each-ref",
    "--format=%(refname:short) %(objectname)",
    "refs/heads",
  ]);
  const head = branchTip(cwd, branch);
  if (!refs.ok || !head) return stackFail("failed", "cannot list local branches");
  const below: Array<{ branch: string; depth: number }> = [];
  for (const line of refs.stdout.split("\n")) {
    const [name, sha] = line.trim().split(" ");
    if (!name || !sha || name === branch || name === trunk) continue;
    if (sha === head || isAncestor(cwd, sha, base) || !isAncestor(cwd, sha, head)) continue;
    const count = gitRun(cwd, ["rev-list", "--count", `${base}..${sha}`]);
    below.push({ branch: name, depth: Number(count.stdout.trim()) || 0 });
  }
  // Branches sharing one tip are ambiguous; keep the order stable by name.
  below.sort((a, b) => a.depth - b.depth || a.branch.localeCompare(b.branch));
  return { ok: true, data: [...below.map((entry) => entry.branch), branch] };
}

export function planStack(
  cwd: string,
  resolved: ResolvedForge | null,
  input: PlanInput,
  existing: StackFile | null,
): StackResult<PlanOutcome> {
  const remote = remoteFor(cwd, resolved, input.trunk);
  const notes: string[] = [];
  const trunkSha = trunkTip(cwd, remote, input.trunk);
  if (!trunkSha)
    return stackFail(
      "not_found",
      `trunk ${input.trunk} is not available locally`,
      `git fetch ${remote} ${input.trunk}  # or pass --trunk <branch>`,
    );
  let branches = input.branches;
  if (branches.length === 0) {
    if (existing) branches = existing.branches.map((entry) => entry.branch);
    else {
      const derived = deriveChain(cwd, input.trunk, trunkSha);
      if (!derived.ok) return derived;
      branches = derived.data;
    }
  }
  if (new Set(branches).size !== branches.length)
    return stackFail("invalid_input", "a branch is listed twice");
  if (branches.includes(input.trunk))
    return stackFail("invalid_input", `the trunk ${input.trunk} cannot be in the stack`);
  for (const branch of branches)
    if (!safeRef(branch) || !branchTip(cwd, branch))
      return stackFail(
        "not_found",
        `branch ${branch} does not exist locally`,
        `git switch ${branch}  # or git branch ${branch} ${remote}/${branch}`,
      );

  const previous = new Map((existing?.branches ?? []).map((entry) => [entry.branch, entry]));
  const entries: StackEntry[] = [];
  const checks: PlanOutcome["checks"] = [];
  let parent = input.trunk;
  let parentSha = trunkSha;
  for (const branch of branches) {
    const tip = branchTip(cwd, branch) as string;
    const before = previous.get(branch);
    if (before?.merged) {
      entries.push(before);
      continue;
    }
    const onParent = isAncestor(cwd, parentSha, tip);
    // A branch not yet on its parent was forked at the merge base.
    const builtOn = onParent ? parentSha : (mergeBase(cwd, parentSha, tip) ?? parentSha);
    let pr = before?.pr ?? null;
    let prBase: string | null = null;
    if (resolved) {
      const found = resolved.forge.findPr(branch, {
        owner: resolved.headRepo.split("/")[0] ?? null,
        projectId: resolved.headProjectId,
        sha: tip,
      });
      if (found.ok && found.data && found.data.state === "open") {
        pr = found.data.number;
        const status = resolved.forge.prStatus(pr);
        if (status.ok) prBase = status.data.base;
      } else if (!found.ok) notes.push(`${branch}: PR lookup failed (${found.error})`);
    }
    entries.push({
      branch,
      parent,
      pr,
      lastHead: tip,
      lastParentHead: builtOn,
      patchId: patchId(cwd, builtOn, tip),
      merged: null,
    });
    checks.push({
      branch,
      parent,
      onParent,
      pr,
      prBase,
      baseMatches: prBase === null ? null : prBase === parent,
    });
    if (!onParent) notes.push(`${branch} is not on ${parent}; workit stack sync rebases it`);
    if (prBase !== null && prBase !== parent)
      notes.push(
        `${branch}: PR base is ${prBase}, the stack says ${parent}; workit stack sync retargets it`,
      );
    parent = branch;
    parentSha = tip;
  }
  if (!resolved) notes.push("forge not resolved: PR numbers were not looked up");
  const name = input.name ?? existing?.name ?? branches[0];
  return {
    ok: true,
    data: {
      stack: {
        v: STACK_VERSION,
        name,
        trunk: input.trunk,
        forge: resolved?.forge.kind ?? existing?.forge ?? null,
        repo: resolved?.forge.repo ?? existing?.repo ?? null,
        branches: entries,
        updatedAt: "",
      },
      created: existing === null,
      checks,
      notes,
    },
  };
}

// ---------------------------------------------------------------------------
// status

export type StackVerdict = "READY" | "WAITING" | "ADVANCE" | "COMPLETE";

export type StopReason =
  | "no_pr"
  | "pr_closed"
  | "base_not_trunk"
  | "not_ready"
  | "no_verdict"
  | "needs_verdict"
  | "grant_required"
  | "max_reached"
  | "merge_refused"
  | "head_unverified";

export type BranchStatus = {
  branch: string;
  parent: string;
  pr: number | null;
  merged: boolean;
  head: string | null;
  /** The parent's (or trunk's) tip is in this branch's history. */
  onParent: boolean | null;
  prState: PrState | null;
  prBase: string | null;
  baseMatches: boolean | null;
  next: NextAction | null;
  checks: ChecksState | null;
  blockers: string[];
  verdict: { accepted: boolean; basis: VerdictBasis; reasons: string[]; verdictId: string | null };
};

export type Qualification =
  | { ok: true }
  | { ok: false; reason: StopReason; detail: string; unblock: string; ready: boolean };

export type StatusOutcome = {
  name: string;
  trunk: string;
  verdict: StackVerdict;
  reason: string | null;
  next: string | null;
  branches: BranchStatus[];
};

type Ctx = {
  cwd: string;
  resolved: ResolvedForge;
  actor: LedgerActor;
  sleep: Sleep;
};

const noun = (resolved: ResolvedForge, pr: number): string =>
  `${resolved.forge.kind === "github" ? "PR #" : "MR !"}${pr}`;

function statusDoc(ctx: Ctx, pr: number): ForgeResult<PrStatusDoc> {
  const status = ctx.resolved.forge.prStatus(pr);
  if (!status.ok) return status;
  return buildStatusDoc(ctx.cwd, ctx.resolved, status.data, { logLines: 0, behind: false });
}

const verdictOf = (cwd: string, branch: string, rows: readonly ReadRow[]) => {
  const check = checkVerdicts(cwd, branch, rows);
  return {
    accepted: check.accepted.accepted,
    basis: check.current.basis,
    reasons: check.accepted.reasons as string[],
    verdictId:
      typeof check.accepted.verdict?.id === "string" && check.accepted.accepted
        ? check.accepted.verdict.id
        : null,
  };
};

/**
 * Does the root-most open PR qualify to land? Order: a PR exists and is
 * open, it targets the trunk, the forge says READY, an accepted verdict
 * covers the head (unless the grant is `merge: true`), and the grant allows
 * merging. `ready` says everything but the grant holds ("verified, ready").
 */
export function qualify(
  ctx: Pick<Ctx, "cwd" | "resolved">,
  stack: StackFile,
  entry: StackEntry,
  doc: PrStatusDoc | null,
  verdict: BranchStatus["verdict"],
  grant: GrantDecision,
): Qualification {
  const label = entry.pr ? noun(ctx.resolved, entry.pr) : entry.branch;
  const stop = (reason: StopReason, detail: string, unblock: string, ready = false) => ({
    ok: false as const,
    reason,
    detail,
    unblock,
    ready,
  });
  if (!entry.pr || !doc)
    return stop(
      "no_pr",
      `${entry.branch} has no open PR`,
      `git switch ${entry.branch} && workit pr create --fill --base ${entry.parent}  # then workit stack plan`,
    );
  if (doc.state !== "open")
    return stop(
      "pr_closed",
      `${label} is ${doc.state}`,
      "reopen it, or drop the branch from the stack: workit stack plan <branches…>",
    );
  if (doc.base !== stack.trunk)
    return stop(
      "base_not_trunk",
      `${label} targets ${doc.base}, not ${stack.trunk}`,
      "workit stack sync",
    );
  if (doc.next !== "READY")
    return stop(
      "not_ready",
      `${label} is ${doc.next}${doc.blockers.length ? ` (${doc.blockers.join(", ")})` : ""}`,
      doc.next === "WAITING_CI"
        ? `workit ci wait --pr ${entry.pr}`
        : `workit pr status --pr ${entry.pr}`,
    );
  const requireVerdict = grant.allowed ? grant.requireVerdict : true;
  if (requireVerdict && !verdict.accepted)
    return stop(
      verdict.reasons.includes("no_verdict") ? "no_verdict" : "needs_verdict",
      `${label} has no accepted independent verdict for ${doc.head.sha.slice(0, 12)} (${verdict.reasons.join(", ") || "none"})`,
      `an independent session verifies ${entry.branch} and runs: workit ledger verdict verified --how "<what was exercised>" --branch ${entry.branch}`,
    );
  if (!grant.allowed)
    return stop(
      "grant_required",
      `${label} is verified and ready, but ${grant.error}`,
      grant.unblock,
      true,
    );
  return { ok: true };
}

export function stackStatus(ctx: Ctx, stack: StackFile): StackResult<StatusOutcome> {
  const ledger = readLedger(ctx.cwd);
  if (!ledger.ok) return stackFail(ledger.code, ledger.error, ledger.unblock);
  const remote = remoteFor(ctx.cwd, ctx.resolved, stack.trunk);
  const trunkSha = trunkTip(ctx.cwd, remote, stack.trunk);
  const grant = requireGrant(ctx.cwd, "merge");
  const branches: BranchStatus[] = [];
  let verdict: StackVerdict | null = null;
  let reason: string | null = null;
  let next: string | null = null;
  let parentName = stack.trunk;
  let parentSha = trunkSha;
  let mergedSeen = false;
  for (const entry of stack.branches) {
    let doc: PrStatusDoc | null = null;
    if (entry.pr) {
      const read = statusDoc(ctx, entry.pr);
      if (!read.ok) return fromForge(read);
      doc = read.data;
    }
    const merged = entry.merged !== null || doc?.state === "merged";
    const head = branchTip(ctx.cwd, entry.branch);
    const row: BranchStatus = {
      branch: entry.branch,
      parent: parentName,
      pr: entry.pr,
      merged,
      head,
      onParent: merged || !head || !parentSha ? null : isAncestor(ctx.cwd, parentSha, head),
      prState: doc?.state ?? null,
      prBase: doc?.base ?? null,
      baseMatches: doc && !merged ? doc.base === parentName : null,
      next: doc?.next ?? null,
      checks: doc?.checks.state ?? null,
      blockers: doc?.blockers ?? [],
      verdict: merged
        ? { accepted: true, basis: "none", reasons: [], verdictId: null }
        : verdictOf(ctx.cwd, entry.branch, ledger.value.rows),
    };
    branches.push(row);
    if (merged) {
      mergedSeen = true;
      continue;
    }
    if (verdict === null) {
      // The root-most open branch decides the stack's verdict.
      const stale = row.onParent === false || row.baseMatches === false;
      if (mergedSeen && stale) {
        verdict = "ADVANCE";
        reason = "a parent merged; the rest is not restacked or retargeted yet";
        next = "workit stack sync";
      } else {
        const q = qualify(ctx, stack, entry, doc, row.verdict, grant);
        if (q.ok) {
          verdict = "READY";
          next = "workit stack land";
        } else {
          verdict = "WAITING";
          reason = `${q.reason}: ${q.detail}`;
          next = q.unblock;
        }
      }
    }
    parentName = entry.branch;
    parentSha = head;
  }
  return {
    ok: true,
    data: {
      name: stack.name,
      trunk: stack.trunk,
      verdict: verdict ?? "COMPLETE",
      reason,
      next,
      branches,
    },
  };
}

// ---------------------------------------------------------------------------
// sync

export type SyncOptions = {
  /** Push and retarget (false: only rebase locally). */
  publish: boolean;
  dryRun: boolean;
  /** Process only the first N unmerged branches (land moves just the new root). */
  limit?: number;
};

export type SyncStep = {
  branch: string;
  pr: number | null;
  parent: string;
  /** null: already on its parent. */
  restack: { from: string; onto: string; head: string | null; carried: boolean | null } | null;
  push: { pushed: boolean; forced: boolean; sha: string } | null;
  retarget: { from: string; to: string } | null;
};

export type SyncOutcome = {
  name: string;
  dryRun: boolean;
  merged: Array<{ branch: string; pr: number | null }>;
  steps: SyncStep[];
};

type SyncState = {
  /** PR status docs read during this run, by PR number. */
  docs: Map<number, PrStatusDoc>;
};

/** Mark branches whose PR merged (or whose tip is on the trunk) as merged. */
function detectMerged(
  ctx: Ctx | null,
  cwd: string,
  stack: StackFile,
  trunkSha: string,
  state: SyncState,
): StackResult<Array<{ branch: string; pr: number | null }>> {
  const newly: Array<{ branch: string; pr: number | null }> = [];
  for (const entry of stack.branches) {
    if (entry.merged) continue;
    let merged = false;
    if (entry.pr && ctx) {
      const read = statusDoc(ctx, entry.pr);
      if (!read.ok) return fromForge(read);
      state.docs.set(entry.pr, read.data);
      merged = read.data.state === "merged";
    } else {
      const tip = branchTip(cwd, entry.branch);
      merged = tip !== null && isAncestor(cwd, tip, trunkSha);
    }
    if (merged) {
      entry.merged = { pr: entry.pr, mergeSha: null, at: new Date().toISOString() };
      newly.push({ branch: entry.branch, pr: entry.pr });
    }
  }
  return { ok: true, data: newly };
}

/**
 * Push `branch` through the S11 push: the grant, the protected-branch check
 * and the lease. A rewrite is forced only with a lease on the tip the stack
 * last saw (or workit's own recorded push), and only when that tip is in the
 * branch's history or reflog (S11 `--force-if-includes` semantics).
 */
function pushBranch(
  cwd: string,
  actor: LedgerActor,
  branch: string,
  priorTip: string | null,
): StackResult<{ pushed: boolean; forced: boolean; sha: string }> {
  const plan = stackDeps.pushPlan(cwd, branch);
  if (!plan.ok) return fromForge(plan);
  const remote = remoteRefTip(cwd, plan.data.rawUrl, `refs/heads/${branch}`);
  if (!remote.ok) return stackFail(remote.code, remote.error);
  if (remote.sha === plan.data.sha)
    return { ok: true, data: { pushed: false, forced: false, sha: plan.data.sha } };
  const grant = requireGrant(cwd, "push", { forge: !plan.data.local });
  if (!grant.allowed)
    return stackFail("blocked", grant.error, grant.unblock, { reason: grant.reason });
  const force = remote.sha !== null && !isAncestor(cwd, remote.sha, plan.data.sha);
  const expect = !force
    ? null
    : remote.sha === priorTip
      ? priorTip
      : (recordedRemoteTip(cwd, plan.data) ?? null);
  const pushed = executePush(cwd, plan.data, { forceWithLease: force, expect, actor });
  if (!pushed.ok) return { ...fromForge(pushed), data: { branch } };
  return {
    ok: true,
    data: { pushed: pushed.data.pushed, forced: pushed.data.forced, sha: plan.data.sha },
  };
}

/**
 * Bring every unmerged branch onto its effective parent (the nearest unmerged
 * branch below it, else the trunk), push it and retarget its PR, in order.
 * Writes the stack file after every branch, so a stop leaves the processed
 * branches recorded and the rest untouched.
 */
export function syncStack(
  cwd: string,
  ctx: Ctx | null,
  stack: StackFile,
  options: SyncOptions,
  actor: LedgerActor,
): StackResult<SyncOutcome> {
  const remote = remoteFor(cwd, ctx?.resolved ?? null, stack.trunk);
  let observedTrunk: string | null = null;
  if (!options.dryRun && safeRef(stack.trunk)) {
    const fetched = fetchRefs(cwd, remote, [
      `+refs/heads/${stack.trunk}:refs/remotes/${remote}/${stack.trunk}`,
    ]);
    if (!fetched.ok)
      return stackFail(fetched.code, fetched.error, `git fetch ${remote} ${stack.trunk}`);
  } else if (safeRef(stack.trunk)) {
    // Dry run: read the remote trunk without moving any ref (objects by id only).
    const remoteTrunk = remoteRefTip(cwd, remote, `refs/heads/${stack.trunk}`);
    if (remoteTrunk.ok && remoteTrunk.sha) {
      if (!hasCommit(cwd, remoteTrunk.sha)) fetchRefs(cwd, remote, [remoteTrunk.sha]);
      if (hasCommit(cwd, remoteTrunk.sha)) observedTrunk = remoteTrunk.sha;
    }
  }
  const trunkSha = observedTrunk ?? trunkTip(cwd, remote, stack.trunk);
  if (!trunkSha)
    return stackFail(
      "not_found",
      `trunk ${stack.trunk} is not available`,
      `git fetch ${remote} ${stack.trunk}`,
    );
  const state: SyncState = { docs: new Map() };
  const merged = detectMerged(ctx, cwd, stack, trunkSha, state);
  if (!merged.ok) return merged;

  const outcome: SyncOutcome = {
    name: stack.name,
    dryRun: options.dryRun,
    merged: merged.data,
    steps: [],
  };
  const original = currentBranch(cwd);
  const originalSha = original ? null : headSha(cwd);
  // Pre-flight: no rebase may already be stopped anywhere we would work.
  if (!options.dryRun && rebaseInProgress(cwd))
    return stackFail(
      "blocked",
      "a rebase is already in progress in this worktree",
      "resolve the conflicts, git rebase --continue (or git rebase --abort), then workit stack sync",
    );
  const restore = () => {
    if (options.dryRun || rebaseInProgress(cwd)) return;
    if (original && currentBranch(cwd) !== original) gitRun(cwd, ["switch", "-q", original]);
    else if (originalSha && headSha(cwd) !== originalSha)
      gitRun(cwd, ["switch", "-q", "--detach", originalSha]);
  };

  let parent = { name: stack.trunk, tip: trunkSha as string | null };
  let processed = 0;
  try {
    for (const entry of stack.branches) {
      if (entry.merged) continue;
      if (options.limit !== undefined && processed >= options.limit) break;
      processed += 1;
      const tip = branchTip(cwd, entry.branch);
      if (!tip)
        return stackFail(
          "not_found",
          `stack branch ${entry.branch} does not exist locally`,
          `git branch ${entry.branch} ${remote}/${entry.branch}  # then workit stack sync`,
          { progress: outcome },
        );
      const step: SyncStep = {
        branch: entry.branch,
        pr: entry.pr,
        parent: parent.name,
        restack: null,
        push: null,
        retarget: null,
      };
      let newTip: string | null = tip;
      const parentTip = parent.tip;
      if (parentTip === null) {
        // Dry run: the parent would be rewritten first, so this one moves too.
        step.restack = {
          from: entry.lastParentHead ?? "?",
          onto: `${parent.name} (restacked)`,
          head: null,
          carried: null,
        };
        newTip = null;
      } else if (!isAncestor(cwd, parentTip, tip)) {
        const from =
          entry.lastParentHead && isAncestor(cwd, entry.lastParentHead, tip)
            ? entry.lastParentHead
            : (mergeBase(cwd, entry.lastParentHead ?? parentTip, tip) ?? parentTip);
        if (options.dryRun) {
          step.restack = { from, onto: parentTip, head: null, carried: null };
          newTip = null;
        } else {
          const owner = worktreeOf(cwd, entry.branch);
          const dir = owner ?? cwd;
          if (rebaseInProgress(dir))
            return stackFail(
              "blocked",
              `a rebase is in progress in ${dir}`,
              `cd ${dir} && git rebase --continue  # or --abort; then workit stack sync`,
              { conflict: entry.branch, worktree: dir, progress: outcome },
            );
          if (trackedDirt(dir))
            return stackFail(
              "blocked",
              `dirty_worktree: ${dir} has uncommitted changes; restacking ${entry.branch} needs a clean worktree`,
              `commit or stash the changes in ${dir}, then workit stack sync`,
              { branch: entry.branch, worktree: dir, progress: outcome },
            );
          const rebased = stackDeps.adapter.restack(cwd, {
            branch: entry.branch,
            onto: parentTip,
            from,
          });
          if (!rebased.ok) {
            outcome.steps.push(step);
            return rebased.conflict
              ? stackFail(
                  "blocked",
                  `conflict restacking ${entry.branch} onto ${parent.name}: ${rebased.error}`,
                  `resolve the conflicts in ${rebased.worktree}, git rebase --continue, then workit stack sync  # or git rebase --abort`,
                  { conflict: entry.branch, worktree: rebased.worktree, progress: outcome },
                )
              : stackFail(
                  "failed",
                  `restacking ${entry.branch} failed: ${rebased.error}`,
                  undefined,
                  {
                    branch: entry.branch,
                    progress: outcome,
                  },
                );
          }
          newTip = rebased.head;
          step.restack = { from, onto: parentTip, head: newTip, carried: null };
        }
      }
      if (!options.dryRun && newTip) {
        // The change moved (restacked now, or after a resolved conflict):
        // record whether it is the same change on the new base (S13 carry).
        if (entry.lastHead && entry.lastHead !== newTip && entry.lastParentHead && parentTip) {
          const before = {
            p: patchId(cwd, entry.lastParentHead, entry.lastHead),
            d: diffHash(cwd, entry.lastParentHead, entry.lastHead),
          };
          const after = { p: patchId(cwd, parentTip, newTip), d: diffHash(cwd, parentTip, newTip) };
          const equal =
            before.p !== null && before.p === after.p && before.d !== null && before.d === after.d;
          appendObserved(cwd, {
            type: "stack.restacked",
            actor,
            stack: stack.name,
            branch: entry.branch,
            head: newTip,
            fromHead: entry.lastHead,
            fromBase: entry.lastParentHead,
            toBase: parentTip,
            patchId: after.p,
            diffHash: after.d,
            patchEqual: equal,
          });
          if (step.restack) step.restack.carried = equal;
          else
            step.restack = {
              from: entry.lastParentHead,
              onto: parentTip,
              head: newTip,
              carried: equal,
            };
        }
        if (options.publish) {
          const pushed = pushBranch(cwd, actor, entry.branch, entry.lastHead ?? tip);
          if (!pushed.ok) {
            outcome.steps.push(step);
            return { ...pushed, data: { ...pushed.data, progress: outcome } };
          }
          step.push = pushed.data;
        }
        entry.lastHead = newTip;
        entry.lastParentHead = parentTip;
        entry.patchId = parentTip ? patchId(cwd, parentTip, newTip) : null;
      }
      if (options.publish && ctx && entry.pr) {
        const doc = state.docs.get(entry.pr);
        if (doc && doc.state === "open" && doc.base !== parent.name) {
          step.retarget = { from: doc.base, to: parent.name };
          if (!options.dryRun) {
            const grant = requireGrant(cwd, "pr");
            if (!grant.allowed)
              return stackFail("blocked", grant.error, grant.unblock, {
                reason: grant.reason,
                progress: outcome,
              });
            const updated = ctx.resolved.forge.updateBase(entry.pr, parent.name);
            if (!updated.ok)
              return { ...fromForge(updated), data: { branch: entry.branch, progress: outcome } };
            appendObserved(cwd, {
              type: "pr.retargeted",
              actor,
              stack: stack.name,
              branch: entry.branch,
              head: newTip,
              pr: entry.pr,
              base: parent.name,
              previousBase: doc.base,
            });
          }
        }
      }
      entry.parent = parent.name;
      outcome.steps.push(step);
      if (!options.dryRun) {
        const written = writeStack(cwd, stack);
        if (!written.ok) return written;
      }
      parent = { name: entry.branch, tip: newTip };
    }
    if (!options.dryRun) {
      const written = writeStack(cwd, stack);
      if (!written.ok) return written;
    }
  } finally {
    restore();
  }
  return { ok: true, data: outcome };
}

// ---------------------------------------------------------------------------
// land

export type LandOptions = {
  dryRun: boolean;
  max: number | null;
  method: MergeMethod;
  /** How long to wait for CI on a PR that was just restacked. */
  timeoutMs: number;
  intervalMs: number;
};

export type LandOutcome = {
  name: string;
  dryRun: boolean;
  landed: Array<{ pr: number; branch: string; mergeSha: string | null }>;
  /** Dry run: the PRs that qualify now, in order (later ones assume a clean restack). */
  wouldLand: Array<{ pr: number; branch: string }>;
  stoppedAt: {
    pr: number | null;
    branch: string;
    reason: StopReason;
    detail: string;
    unblock: string;
    /** Everything but the merge grant holds: "verified, ready". */
    ready: boolean;
  } | null;
  retargeted: number[];
  restacked: string[];
  complete: boolean;
};

/** Poll the PR until its checks settle or the wait budget is spent (sleep-time based). */
async function awaitChecks(
  ctx: Ctx,
  pr: number,
  head: string,
  options: LandOptions,
): Promise<ForgeResult<PrStatusDoc>> {
  let waited = 0;
  for (let poll = 0; ; poll += 1) {
    const doc = statusDoc(ctx, pr);
    if (!doc.ok) return doc;
    const verdict = waitVerdict(doc.data, { head, elapsedMs: waited });
    if (verdict.state !== "waiting" || waited >= options.timeoutMs) return doc;
    const delay = Math.min(
      pollDelay(options.intervalMs, poll),
      Math.max(1, options.timeoutMs - waited),
    );
    await ctx.sleep(delay);
    waited += delay;
  }
}

export async function landStack(
  ctx: Ctx,
  stack: StackFile,
  options: LandOptions,
): Promise<StackResult<LandOutcome>> {
  const outcome: LandOutcome = {
    name: stack.name,
    dryRun: options.dryRun,
    landed: [],
    wouldLand: [],
    stoppedAt: null,
    retargeted: [],
    restacked: [],
    complete: false,
  };
  const absorb = (sync: SyncOutcome) => {
    for (const step of sync.steps) {
      if (step.retarget && step.pr && !outcome.retargeted.includes(step.pr))
        outcome.retargeted.push(step.pr);
      if (step.restack?.head && !outcome.restacked.includes(step.branch))
        outcome.restacked.push(step.branch);
    }
  };
  const failWith = (error: StackError): StackError => ({
    ...error,
    data: { ...error.data, land: outcome },
  });

  // Catch up first: a parent merged elsewhere leaves the rest to restack.
  if (!options.dryRun) {
    const synced = syncStack(
      ctx.cwd,
      ctx,
      stack,
      { publish: true, dryRun: false, limit: 1 },
      ctx.actor,
    );
    if (!synced.ok) return failWith(synced);
    absorb(synced.data);
  }
  const ledgerRows = () => {
    const ledger = readLedger(ctx.cwd);
    return ledger.ok ? ledger.value.rows : [];
  };
  const simulated = new Set<string>();
  let justRestacked = new Set(outcome.restacked);
  for (;;) {
    const entry = stack.branches.find(
      (candidate) => !candidate.merged && !simulated.has(candidate.branch),
    );
    if (!entry) {
      outcome.complete =
        !options.dryRun ||
        stack.branches.every((candidate) => candidate.merged || simulated.has(candidate.branch));
      break;
    }
    if (options.max !== null && outcome.landed.length + outcome.wouldLand.length >= options.max) {
      outcome.stoppedAt = {
        pr: entry.pr,
        branch: entry.branch,
        reason: "max_reached",
        detail: `--max ${options.max} reached`,
        unblock: "workit stack land",
        ready: false,
      };
      break;
    }
    let doc: PrStatusDoc | null = null;
    if (entry.pr) {
      const head = branchTip(ctx.cwd, entry.branch);
      const read =
        justRestacked.has(entry.branch) && head
          ? await awaitChecks(ctx, entry.pr, head, options)
          : statusDoc(ctx, entry.pr);
      if (!read.ok) return failWith(fromForge(read));
      doc = read.data;
      if (options.dryRun && doc.state === "merged") {
        // Merged elsewhere; the real run would restack past it.
        simulated.add(entry.branch);
        continue;
      }
    }
    const grant = requireGrant(ctx.cwd, "merge");
    const verdict = verdictOf(ctx.cwd, entry.branch, ledgerRows());
    // A dry run predicts the retarget the real run would do first.
    const effective =
      options.dryRun && simulated.size > 0 && doc ? { ...doc, base: stack.trunk } : doc;
    const q = qualify(ctx, stack, entry, effective, verdict, grant);
    if (!q.ok) {
      outcome.stoppedAt = {
        pr: entry.pr,
        branch: entry.branch,
        reason: q.reason,
        detail: q.detail,
        unblock: q.unblock,
        ready: q.ready,
      };
      break;
    }
    const pr = entry.pr as number;
    if (options.dryRun) {
      outcome.wouldLand.push({ pr, branch: entry.branch });
      simulated.add(entry.branch);
      continue;
    }
    const merged = await mergePullRequest(
      ctx.cwd,
      ctx.resolved,
      { pr, method: options.method, deleteBranch: false, actor: ctx.actor },
      ctx.sleep,
    );
    if (!merged.ok) {
      if (merged.code === "blocked" && "refusal" in merged && merged.refusal) {
        outcome.stoppedAt = {
          pr,
          branch: entry.branch,
          reason: "merge_refused",
          detail: merged.error,
          unblock: merged.unblock ?? `workit pr status --pr ${pr}`,
          ready: false,
        };
        break;
      }
      return failWith(stackFail(merged.code, merged.error, merged.unblock));
    }
    outcome.landed.push({ pr, branch: entry.branch, mergeSha: merged.data.mergeSha });
    entry.merged = { pr, mergeSha: merged.data.mergeSha, at: new Date().toISOString() };
    const written = writeStack(ctx.cwd, stack);
    if (!written.ok) return failWith(written);
    // Move the next PR onto the trunk: restack, lease push, retarget. The
    // ones above it wait (restacking them now would only spend CI that the
    // next merge restarts); `workit stack sync` moves them all.
    const before = new Set(outcome.restacked);
    const synced = syncStack(
      ctx.cwd,
      ctx,
      stack,
      { publish: true, dryRun: false, limit: 1 },
      ctx.actor,
    );
    if (!synced.ok) return failWith(synced);
    absorb(synced.data);
    justRestacked = new Set(outcome.restacked.filter((branch) => !before.has(branch)));
    for (const step of synced.data.steps) if (step.restack?.head) justRestacked.add(step.branch);
  }
  return { ok: true, data: outcome };
}
