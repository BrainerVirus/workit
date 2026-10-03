// The run ledger (design §2.1 S13, §2.2; D13, D14, D17): an append-only,
// repo-wide JSONL file of decisions, rulings, verdicts and handoff notes.
//
// - Location (D13): `$(git rev-parse --git-common-dir)/workit/ledger/ledger.jsonl`
//   in a git repo, so every worktree of the repo shares one ledger and it
//   survives worktree removal and `git clean`; `<cwd>/.workit/ledger/` outside
//   git.
// - Concurrency: one row is one `write(2)` of at most MAX_LINE_BYTES (the
//   POSIX PIPE_BUF floor) on an O_APPEND descriptor, so concurrent appenders
//   from any number of processes or worktrees never interleave or overwrite,
//   and no lock is needed. A torn tail left by a crashed writer is fenced off
//   with a newline before the next row instead of being glued to it.
// - Reader tolerance (D17): unknown keys are kept and ignored, unparsable
//   lines and rows without the required keys are skipped and counted, and the
//   file is never rewritten. `seq` is the row's position among valid rows; a
//   row supersedes an older one by its `id`.
// - Verdict keying (§2.2): a verdict stores the HEAD SHA it judged plus
//   `base` and the stable patch-id of `base...head`. Against the branch's
//   current state it is `fresh` (same head), `carried` (new head, same
//   patch-id: a rebase that only moved the base) or `stale` (the change
//   itself differs).
//
// Plain TS over the git binary: no zod, no task store, no config reads.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GIT_TIMEOUTS, currentBranch, headSha, patchId, worktreeTree } from "./git/rev";

export const LEDGER_VERSION = 1;
/** One row must fit one atomic append (POSIX guarantees PIPE_BUF ≥ 4096 bytes). */
export const MAX_LINE_BYTES = 4096;

export const VERDICT_RESULTS = [
  "verified",
  "tests-verified",
  "type-check-only",
  "blocked",
  "failed",
] as const;
export type VerdictResult = (typeof VERDICT_RESULTS)[number];
export const VERDICT_KINDS = ["unit", "live", "perf", "review"] as const;
export type VerdictKind = (typeof VERDICT_KINDS)[number];
export const VERDICT_SURFACES = ["ui", "cli", "api"] as const;
export type VerdictSurface = (typeof VERDICT_SURFACES)[number];

export type LedgerActor = {
  host: string;
  session: string | null;
  agentId: string | null;
  /** True only when a host hook attested this row; the CLI alone never does. */
  attested: boolean;
};

/** The code state a row was recorded against (§2.2). */
export type CodeKey = {
  branch: string | null;
  head: string | null;
  /** The base ref the patch-id was computed against (e.g. `origin/main`). */
  base: string | null;
  baseSha: string | null;
  patchId: string | null;
  /** Worktree tree key, only when the row was recorded on the checked-out branch. */
  tree: string | null;
  dirty: boolean | null;
};

type RowCommon = CodeKey & {
  v: number;
  id: string;
  at: string;
  type: string;
  actor: LedgerActor;
  pr?: number;
  /** The `id` of an older row this one replaces. */
  supersedes?: string;
};

export type DecisionRow = RowCommon & {
  type: "decision";
  what: string;
  why: string;
  refs: string[];
};
export type RulingRow = RowCommon & {
  type: "ruling";
  what: string;
  why: string;
  costIfWrong: string;
  refs: string[];
};
export type VerdictRow = RowCommon & {
  type: "verdict";
  kind: VerdictKind;
  result: VerdictResult;
  how: string;
  surface: VerdictSurface | null;
  /** Who saw the verdict being recorded (D14): always the CLI. */
  observer: "workit_cli";
  attestation: { host: string; session: string | null; agentId: string | null } | null;
  /** Recorded by an author of the branch via `--self`: not an independent verdict. */
  self: boolean;
  evidenceRefs: string[];
};
export type HandoffRow = RowCommon & { type: "handoff"; note: string | null; next: string };

export type LedgerRow = DecisionRow | RulingRow | VerdictRow | HandoffRow;
/** A row as read back: any known or future type, plus its position. */
export type ReadRow = RowCommon & Record<string, unknown> & { seq: number; superseded: boolean };

export type LedgerResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: "invalid_input" | "blocked" | "unavailable" | "not_found";
      error: string;
      unblock?: string;
    };

// ---------------------------------------------------------------------------
// git plumbing (bounded, never prompts)

const git = (cwd: string, args: string[]): string | null => {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUTS.local,
    killSignal: "SIGKILL",
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  if (run.status !== 0) return null;
  const value = (run.stdout ?? "").trim();
  return value ? value : null;
};

const safeRef = (value: string): boolean => value.length > 0 && !value.startsWith("-");

/** The commit a ref resolves to, or null. */
export function resolveCommit(cwd: string, ref: string): string | null {
  if (!safeRef(ref)) return null;
  return git(cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
}

/** A local branch's tip, falling back to its remote-tracking ref on origin. */
export function branchHead(cwd: string, branch: string): string | null {
  if (!safeRef(branch)) return null;
  return (
    resolveCommit(cwd, `refs/heads/${branch}`) ??
    resolveCommit(cwd, `refs/remotes/origin/${branch}`)
  );
}

/**
 * The default base for patch-ids: origin's HEAD branch when known, else the
 * first of origin/main, origin/master, main, master that exists.
 */
export function defaultBase(cwd: string): string | null {
  const originHead = git(cwd, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead && resolveCommit(cwd, originHead)) return originHead;
  for (const candidate of ["origin/main", "origin/master", "main", "master"])
    if (resolveCommit(cwd, candidate)) return candidate;
  return null;
}

// ---------------------------------------------------------------------------
// store root (D13)

export type StoreRoot = { root: string; shared: boolean };

/**
 * Where workit state lives for `cwd`: `<git common dir>/workit` (shared by all
 * worktrees of the repo) or `<cwd>/.workit` outside git.
 */
export function storeRoot(cwd: string): StoreRoot {
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common) return { root: path.join(path.resolve(cwd, common), "workit"), shared: true };
  return { root: path.join(path.resolve(cwd), ".workit"), shared: false };
}

export const ledgerPath = (cwd: string): string =>
  path.join(storeRoot(cwd).root, "ledger", "ledger.jsonl");

// ---------------------------------------------------------------------------
// append

/** The acting identity from the environment (unattested: only hooks attest). */
export function actorFromEnv(env: NodeJS.ProcessEnv): LedgerActor {
  const value = (key: string): string | null => {
    const raw = env[key]?.trim();
    return raw ? raw : null;
  };
  return {
    host: value("WORKIT_HOST") ?? "cli",
    session: value("WORKIT_SESSION_ID"),
    agentId: value("WORKIT_AGENT_ID"),
    attested: false,
  };
}

const newId = (): string => `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;

export type NewRow<T extends LedgerRow> = Omit<T, "v" | "id" | "at">;

/**
 * Append one row atomically. Fails with `invalid_input` when the serialized
 * row exceeds MAX_LINE_BYTES (put long text in a file and reference it).
 */
export function appendRow<T extends LedgerRow>(
  cwd: string,
  row: NewRow<T>,
  now: Date = new Date(),
): LedgerResult<T> {
  const full = { v: LEDGER_VERSION, id: newId(), at: now.toISOString(), ...row } as T;
  const line = `${JSON.stringify(full)}\n`;
  const bytes = Buffer.byteLength(line);
  if (bytes > MAX_LINE_BYTES)
    return {
      ok: false,
      code: "invalid_input",
      error: `ledger row is ${bytes} bytes; the limit is ${MAX_LINE_BYTES}. Shorten the text and pass details by --ref <path|url>`,
    };
  const file = ledgerPath(cwd);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // a+ = O_APPEND|O_RDWR: every write lands at the end, and we can still
    // peek at the last byte to fence off a torn tail.
    const fd = fs.openSync(file, "a+");
    try {
      const size = fs.fstatSync(fd).size;
      let fence = "";
      if (size > 0) {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) fence = "\n";
      }
      fs.writeSync(fd, fence + line);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return {
      ok: false,
      code: "unavailable",
      error: `cannot append to ${file}: ${(error as Error).message}`,
    };
  }
  return { ok: true, value: full };
}

// ---------------------------------------------------------------------------
// read (D17: tolerant)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

const normalizeActor = (value: unknown): LedgerActor => {
  const actor = isRecord(value) ? value : {};
  return {
    host: str(actor.host) ?? "unknown",
    session: str(actor.session),
    agentId: str(actor.agentId),
    attested: actor.attested === true,
  };
};

export type LedgerRead = { path: string; rows: ReadRow[]; skipped: number };

/** Every valid row in append order. Never throws; a missing file is empty. */
export function readLedger(cwd: string): LedgerRead {
  const file = ledgerPath(cwd);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { path: file, rows: [], skipped: 0 };
  }
  const rows: ReadRow[] = [];
  let skipped = 0;
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    if (!isRecord(parsed) || !str(parsed.id) || !str(parsed.type) || !str(parsed.at)) {
      skipped += 1;
      continue;
    }
    const pr = typeof parsed.pr === "number" && Number.isInteger(parsed.pr) ? parsed.pr : undefined;
    rows.push({
      ...parsed,
      v: typeof parsed.v === "number" ? parsed.v : LEDGER_VERSION,
      id: parsed.id as string,
      at: parsed.at as string,
      type: parsed.type as string,
      actor: normalizeActor(parsed.actor),
      branch: str(parsed.branch),
      head: str(parsed.head),
      base: str(parsed.base),
      baseSha: str(parsed.baseSha),
      patchId: str(parsed.patchId),
      tree: str(parsed.tree),
      dirty: typeof parsed.dirty === "boolean" ? parsed.dirty : null,
      ...(pr === undefined ? {} : { pr }),
      ...(str(parsed.supersedes) ? { supersedes: parsed.supersedes as string } : {}),
      seq: rows.length + 1,
      superseded: false,
    });
  }
  const replaced = new Set(rows.map((row) => row.supersedes).filter(Boolean));
  for (const row of rows) row.superseded = replaced.has(row.id);
  return { path: file, rows, skipped };
}

export type RowFilter = { branch?: string; pr?: number; type?: string; last?: number };

export function filterRows(rows: readonly ReadRow[], filter: RowFilter): ReadRow[] {
  const matched = rows.filter(
    (row) =>
      (filter.branch === undefined || row.branch === filter.branch) &&
      (filter.pr === undefined || row.pr === filter.pr) &&
      (filter.type === undefined || row.type === filter.type),
  );
  return filter.last === undefined
    ? matched
    : matched.slice(Math.max(0, matched.length - filter.last));
}

// ---------------------------------------------------------------------------
// code keys and verdict validity (§2.2)

/**
 * The code state of `branch` (default: the checked-out branch) against
 * `base` (default: defaultBase). The worktree tree is included only for the
 * checked-out branch.
 */
export function codeKey(
  cwd: string,
  options: { branch?: string | null; base?: string | null } = {},
): CodeKey {
  const checkedOut = currentBranch(cwd);
  const branch = options.branch ?? checkedOut;
  const head = branch ? branchHead(cwd, branch) : headSha(cwd);
  const base = options.base ?? defaultBase(cwd);
  const baseSha = base ? resolveCommit(cwd, base) : null;
  const patch = base && head ? patchId(cwd, base, head) : null;
  const onTree = branch !== null && branch === checkedOut;
  const tree = onTree ? worktreeTree(cwd) : null;
  return {
    branch,
    head,
    base,
    baseSha,
    patchId: patch,
    tree: tree?.key ?? null,
    dirty: tree ? tree.dirty : null,
  };
}

export type VerdictBasis = "fresh" | "carried" | "stale" | "none";

/** fresh: same head · carried: same non-null patch-id · stale: otherwise. */
export function verdictBasis(
  verdict: { head: string | null; patchId: string | null },
  current: { head: string | null; patchId: string | null },
): Exclude<VerdictBasis, "none"> {
  if (verdict.head && verdict.head === current.head) return "fresh";
  if (verdict.patchId && verdict.patchId === current.patchId) return "carried";
  return "stale";
}

export type EffectiveVerdict = {
  kind: string;
  basis: Exclude<VerdictBasis, "none">;
  valid: boolean;
  /** The branch's patch-id against this verdict's own base, now. */
  currentPatchId: string | null;
  verdict: ReadRow;
};

export type VerdictCheck = {
  branch: string;
  head: string | null;
  base: string | null;
  patchId: string | null;
  valid: boolean;
  basis: VerdictBasis;
  /** The newest valid verdict, else the newest verdict, else null. */
  verdict: ReadRow | null;
  /** The newest live verdict per kind, after carry-over. */
  verdicts: EffectiveVerdict[];
};

const isVerdict = (row: ReadRow): boolean =>
  row.type === "verdict" && typeof row.result === "string" && !row.superseded;

/** The branch's PR-to-branch mapping as recorded in the ledger (newest wins). */
export function branchForPr(rows: readonly ReadRow[], pr: number): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1)
    if (rows[index].pr === pr && rows[index].branch) return rows[index].branch;
  return null;
}

/** Current effective verdicts for `branch`, after patch-id carry-over. */
export function checkVerdicts(
  cwd: string,
  branch: string,
  rows: readonly ReadRow[] = readLedger(cwd).rows,
): VerdictCheck {
  const head = branchHead(cwd, branch);
  const fallbackBase = defaultBase(cwd);
  const patchCache = new Map<string, string | null>();
  const patchFor = (base: string | null): string | null => {
    if (!base || !head) return null;
    if (!patchCache.has(base)) patchCache.set(base, patchId(cwd, base, head));
    return patchCache.get(base) ?? null;
  };
  const newestPerKind = new Map<string, ReadRow>();
  for (const row of rows)
    if (row.branch === branch && isVerdict(row))
      newestPerKind.set(typeof row.kind === "string" ? row.kind : "review", row);
  const verdicts: EffectiveVerdict[] = [...newestPerKind.entries()]
    .map(([kind, row]) => {
      const currentPatchId = patchFor(row.base ?? fallbackBase);
      const basis = verdictBasis(row, { head, patchId: currentPatchId });
      return { kind, basis, valid: basis !== "stale", currentPatchId, verdict: row };
    })
    .toSorted((a, b) => a.verdict.seq - b.verdict.seq);
  const newestValid = verdicts.findLast((entry) => entry.valid);
  const chosen = newestValid ?? verdicts.at(-1) ?? null;
  return {
    branch,
    head,
    base: chosen?.verdict.base ?? fallbackBase,
    patchId: chosen ? chosen.currentPatchId : patchFor(fallbackBase),
    valid: chosen?.valid ?? false,
    basis: chosen?.basis ?? "none",
    verdict: chosen?.verdict ?? null,
    verdicts,
  };
}

/** Sessions that authored `branch`: from `commit.recorded` and `task.opened` rows. */
export function authorSessions(rows: readonly ReadRow[], branch: string): Set<string> {
  const sessions = new Set<string>();
  for (const row of rows) {
    if (row.branch !== branch || (row.type !== "commit.recorded" && row.type !== "task.opened"))
      continue;
    const session = str(row.session) ?? row.actor.session;
    if (session) sessions.add(session);
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// recording helpers

export type RecordContext = {
  cwd: string;
  actor: LedgerActor;
  branch?: string | null;
  base?: string | null;
  pr?: number;
  supersedes?: string;
  now?: Date;
};

const common = (context: RecordContext, key: CodeKey) => ({
  ...key,
  actor: context.actor,
  ...(context.pr === undefined ? {} : { pr: context.pr }),
  ...(context.supersedes ? { supersedes: context.supersedes } : {}),
});

/** Cheap key for notes: branch and head only (no tree hashing, no patch-id). */
const noteKey = (context: RecordContext): CodeKey => {
  const branch = context.branch ?? currentBranch(context.cwd);
  return {
    branch,
    head: branch ? branchHead(context.cwd, branch) : headSha(context.cwd),
    base: null,
    baseSha: null,
    patchId: null,
    tree: null,
    dirty: null,
  };
};

const required = (value: string | undefined | null, flag: string): LedgerResult<string> => {
  const text = value?.trim();
  return text
    ? { ok: true, value: text }
    : { ok: false, code: "invalid_input", error: `${flag} is required` };
};

export function recordDecision(
  context: RecordContext,
  input: { what?: string; why?: string; refs?: string[] },
): LedgerResult<DecisionRow> {
  const what = required(input.what, "<what>");
  if (!what.ok) return what;
  const why = required(input.why, "--why");
  if (!why.ok) return why;
  return appendRow<DecisionRow>(
    context.cwd,
    {
      ...common(context, noteKey(context)),
      type: "decision",
      what: what.value,
      why: why.value,
      refs: input.refs ?? [],
    },
    context.now,
  );
}

export function recordRuling(
  context: RecordContext,
  input: { what?: string; why?: string; costIfWrong?: string; refs?: string[] },
): LedgerResult<RulingRow> {
  const what = required(input.what, "<what>");
  if (!what.ok) return what;
  const why = required(input.why, "--why");
  if (!why.ok) return why;
  const cost = required(input.costIfWrong, "--cost-if-wrong");
  if (!cost.ok) return cost;
  return appendRow<RulingRow>(
    context.cwd,
    {
      ...common(context, noteKey(context)),
      type: "ruling",
      what: what.value,
      why: why.value,
      costIfWrong: cost.value,
      refs: input.refs ?? [],
    },
    context.now,
  );
}

export function recordVerdict(
  context: RecordContext,
  input: {
    result: string;
    kind?: string;
    how?: string;
    surface?: string | null;
    self?: boolean;
    evidenceRefs?: string[];
  },
): LedgerResult<VerdictRow> {
  if (!(VERDICT_RESULTS as readonly string[]).includes(input.result))
    return {
      ok: false,
      code: "invalid_input",
      error: `unknown verdict "${input.result}"; expected ${VERDICT_RESULTS.join("|")}`,
    };
  const kind = input.kind ?? "review";
  if (!(VERDICT_KINDS as readonly string[]).includes(kind))
    return { ok: false, code: "invalid_input", error: `--kind must be ${VERDICT_KINDS.join("|")}` };
  const surface = input.surface ?? null;
  if (surface !== null && !(VERDICT_SURFACES as readonly string[]).includes(surface))
    return {
      ok: false,
      code: "invalid_input",
      error: `--surface must be ${VERDICT_SURFACES.join("|")}`,
    };
  const how = required(input.how, "--how");
  if (!how.ok) return how;
  const branch = context.branch ?? currentBranch(context.cwd);
  if (!branch)
    return {
      ok: false,
      code: "invalid_input",
      error: "HEAD is detached; name the branch the verdict is for",
      unblock: "pass --branch <branch>",
    };
  const key = codeKey(context.cwd, { branch, base: context.base });
  if (!key.head)
    return { ok: false, code: "not_found", error: `branch "${branch}" has no commit to judge` };
  const self = input.self === true;
  const session = context.actor.session;
  if (!self && session && authorSessions(readLedger(context.cwd).rows, branch).has(session))
    return {
      ok: false,
      code: "blocked",
      error: `author_verdict: session ${session} authored ${branch}; a verdict must come from a different session`,
      unblock:
        'have a non-author session record the verdict, or pass --self (a self verdict is not accepted by merge:"verified")',
    };
  return appendRow<VerdictRow>(
    context.cwd,
    {
      ...common(context, key),
      type: "verdict",
      kind: kind as VerdictKind,
      result: input.result as VerdictResult,
      how: how.value,
      surface: surface as VerdictSurface | null,
      observer: "workit_cli",
      attestation: null,
      self,
      evidenceRefs: input.evidenceRefs ?? [],
    },
    context.now,
  );
}

export function recordHandoff(
  context: RecordContext,
  input: { note: string | null; next: string },
): LedgerResult<HandoffRow> {
  return appendRow<HandoffRow>(
    context.cwd,
    { ...common(context, noteKey(context)), type: "handoff", note: input.note, next: input.next },
    context.now,
  );
}

// ---------------------------------------------------------------------------
// handoff brief (replaces export/import: the ledger is shared across worktrees)

export type RowSummary = {
  seq: number;
  id: string;
  at: string;
  type: string;
  branch: string | null;
  summary: string;
};

export function summarizeRow(row: ReadRow): RowSummary {
  const text = (key: string): string => str(row[key]) ?? "";
  let summary: string;
  switch (row.type) {
    case "decision":
      summary = `${text("what")} (why: ${text("why")})`;
      break;
    case "ruling":
      summary = `${text("what")} (why: ${text("why")}; cost if wrong: ${text("costIfWrong")})`;
      break;
    case "verdict":
      summary = `${text("result")} [${text("kind") || "review"}] at ${(row.head ?? "?").slice(0, 12)}${row.self === true ? " (self)" : ""}: ${text("how")}`;
      break;
    case "handoff":
      summary = `next: ${text("next")}${text("note") ? ` (note: ${text("note")})` : ""}`;
      break;
    default:
      summary = text("what") || text("name") || row.type;
  }
  return { seq: row.seq, id: row.id, at: row.at, type: row.type, branch: row.branch, summary };
}

export type StackPosition = {
  name: string;
  index: number;
  size: number;
  parent: string | null;
  pr: number | null;
};

/** The branch's place in a cached stack (`<store>/stacks/*.json`, S12), if any. */
export function stackPosition(root: string, branch: string): StackPosition | null {
  const dir = path.join(root, "stacks");
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
  for (const name of names.toSorted()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.branches)) continue;
    const branches = parsed.branches.filter(isRecord);
    const index = branches.findIndex((entry) => entry.branch === branch);
    if (index < 0) continue;
    const entry = branches[index];
    return {
      name: str(parsed.name) ?? name.replace(/\.json$/u, ""),
      index: index + 1,
      size: branches.length,
      parent: str(entry.parent),
      pr: typeof entry.pr === "number" ? entry.pr : null,
    };
  }
  return null;
}

export type CheckFreshness = { name: string; result: string | null; fresh: boolean; at: string };

export type HandoffBrief = {
  store: { root: string; shared: boolean; ledger: string };
  branch: string | null;
  head: string | null;
  subject: string | null;
  base: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: { dirty: boolean; files: number; paths: string[] };
  pr: number | null;
  stack: StackPosition | null;
  verdict: Omit<VerdictCheck, "verdicts"> & {
    verdicts: Array<Omit<EffectiveVerdict, "verdict"> & { summary: string }>;
  };
  checks: CheckFreshness[];
  rulings: RowSummary[];
  recent: RowSummary[];
  lastHandoff: { at: string; note: string | null; next: string } | null;
  note: string | null;
  next: string;
  nextCommand: string;
  skippedRows: number;
};

const MAX_DIRTY_PATHS = 10;

const dirtyState = (cwd: string): HandoffBrief["dirty"] => {
  const run = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUTS.worktree,
    killSignal: "SIGKILL",
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (run.status !== 0) return { dirty: false, files: 0, paths: [] };
  const paths: string[] = [];
  const entries = (run.stdout ?? "").split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // Renames and copies carry the source path as the next entry.
    if (entry[0] === "R" || entry[0] === "C") index += 1;
  }
  return { dirty: paths.length > 0, files: paths.length, paths: paths.slice(0, MAX_DIRTY_PATHS) };
};

const PASSING: ReadonlySet<string> = new Set(["verified", "tests-verified", "type-check-only"]);

const nextCommandFor = (brief: Omit<HandoffBrief, "nextCommand" | "next">): string => {
  const branchFlag = brief.branch ? ` --branch ${brief.branch}` : "";
  if (!brief.head) return "make the first commit on this branch, then: workit handoff";
  if (brief.dirty.dirty)
    return `commit or stash the ${brief.dirty.files} changed file(s), then: workit handoff`;
  const stale = brief.checks.find((check) => !check.fresh);
  if (stale) return `workit check ${stale.name}`;
  const verdict = brief.verdict;
  if (!verdict.valid)
    return `workit ledger verdict verified${branchFlag} --how "<method and evidence>"  (from a session that did not author the branch)`;
  const result = str(verdict.verdict?.result);
  if (result && !PASSING.has(result))
    return `address the ${result} verdict, then re-verify: workit ledger verdict verified${branchFlag} --how "<…>"`;
  return brief.pr === null ? "workit pr create" : `workit pr status --pr ${brief.pr}`;
};

/**
 * A compact resume brief for the checked-out branch: code state, dirty files,
 * stack position, verdict validity, check freshness, rulings, the newest
 * ledger rows, and one next command.
 */
export function buildHandoff(
  cwd: string,
  options: { last?: number; note?: string | null; next?: string | null } = {},
): HandoffBrief {
  const store = storeRoot(cwd);
  const ledger = readLedger(cwd);
  const branch = currentBranch(cwd);
  const head = headSha(cwd);
  const base = defaultBase(cwd);
  let ahead: number | null = null;
  let behind: number | null = null;
  if (base && head) {
    const counts = git(cwd, ["rev-list", "--left-right", "--count", `${base}...HEAD`]);
    const [left, right] = (counts ?? "").split(/\s+/u).map(Number);
    if (Number.isFinite(left) && Number.isFinite(right)) {
      behind = left;
      ahead = right;
    }
  }
  const mine = branch ? filterRows(ledger.rows, { branch }) : [];
  const stack = branch ? stackPosition(store.root, branch) : null;
  const prRow = mine.findLast((row) => row.pr !== undefined);
  const pr = stack?.pr ?? prRow?.pr ?? null;
  const verdict: VerdictCheck = branch
    ? checkVerdicts(cwd, branch, ledger.rows)
    : {
        branch: "",
        head,
        base,
        patchId: null,
        valid: false,
        basis: "none",
        verdict: null,
        verdicts: [],
      };
  const checkRows = mine.filter((row) => row.type === "check" && !row.superseded && str(row.name));
  const latestChecks = new Map<string, ReadRow>();
  for (const row of checkRows) latestChecks.set(str(row.name) as string, row);
  const tree = latestChecks.size ? (worktreeTree(cwd)?.key ?? null) : null;
  const checks: CheckFreshness[] = [...latestChecks.entries()].map(([name, row]) => ({
    name,
    result: str(row.result),
    fresh: tree !== null && row.tree === tree,
    at: row.at,
  }));
  const lastHandoffRow = mine.findLast((row) => row.type === "handoff");
  const partial: Omit<HandoffBrief, "nextCommand" | "next"> = {
    store: { root: store.root, shared: store.shared, ledger: ledger.path },
    branch,
    head,
    subject: head ? git(cwd, ["log", "-1", "--format=%s", head]) : null,
    base,
    ahead,
    behind,
    dirty: dirtyState(cwd),
    pr,
    stack,
    verdict: {
      ...verdict,
      verdicts: verdict.verdicts.map(({ verdict: row, ...rest }) => ({
        ...rest,
        summary: summarizeRow(row).summary,
      })),
    },
    checks,
    rulings: mine
      .filter((row) => row.type === "ruling" && !row.superseded)
      .slice(-5)
      .map(summarizeRow),
    recent: ledger.rows.slice(-(options.last ?? 10)).map(summarizeRow),
    lastHandoff: lastHandoffRow
      ? {
          at: lastHandoffRow.at,
          note: str(lastHandoffRow.note),
          next: str(lastHandoffRow.next) ?? "",
        }
      : null,
    note: options.note?.trim() || null,
    skippedRows: ledger.skipped,
  };
  const nextCommand = nextCommandFor(partial);
  return { ...partial, nextCommand, next: options.next?.trim() || nextCommand };
}
