// Stop control (ledger decision "stop control: option A, nudge once"): when
// the main agent ends its turn with an obligation the ledger or git can
// prove unmet, the host continues it once with a reason naming the
// obligation and the workit command that clears it. The obligations, for the
// session's branch (the checked-out branch, on which this session recorded a
// commit or opened a PR):
//   (a) unpushed: a commit this session recorded, not on the push remote,
//       while the effective endpoint is pr, green or merged;
//   (b) checks: the branch's open PR has failing or pending checks recorded
//       for its current head (`pr.status` rows) while the endpoint is green
//       or merged;
//   (c) verdict: the session opened the PR (or verified delivery) but the
//       head carries no accepted non-author verdict.
// A branch that landed (a CLI `pr.merged` row for HEAD, or for a head that
// contains this session's commits) owes nothing: its remote branch may be
// deleted, and an `--unverified` merge was the user's call.
// A stop is never blocked: in a subagent, outside a Workit workspace, when
// the host says this stop already follows a continuation (one continue per
// turn), or when the agent's last message asks the user a question. Reads
// the ledger and local git only (no forge call), and every failure allows
// the stop.
import { spawnSync } from "node:child_process";
import { resolveAutonomy } from "../autonomy";
import { currentBranch, pushRemoteName } from "../git/rev";
import { checkVerdicts, readLedger, type ReadRow } from "../ledger";
import type { HostDescriptor } from "./descriptor";
import type { HookDecision, HookInput } from "./protocol";
import { guardedBranch, inWorkitWorkspace } from "./raw-git";

const NONE: HookDecision = { kind: "none" };

export type StopObligation = {
  kind: "unpushed" | "checks" | "verdict";
  /** What is left, with the workit command that clears it. */
  reason: string;
};

/** A question mark (Latin, full-width, Arabic) ending a sentence, or Spanish's opening one. */
const QUESTION = /[?？؟](?=[\s*_`"')\]>]*(?:\s|$))|¿/;
/** An offer or a request for permission. */
const OFFER =
  /\b(?:let me know|want me to|should I|shall I|would you like|do you want|if you(?:'d| would) like|may I|can I go ahead)\b/i;
/** A `[y/N]`, `(y/n)` or `[Y/n]` prompt. */
const YES_NO = /[[(]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[\])]/i;
/** A list item: `- a`, `* a`, `1. a`, `2) a`, `a) a`. */
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)]|[a-z][.)])\s+/i;

/**
 * Does the message end by asking the user something? The last two
 * paragraphs (past code blocks and a trailing option list) are read for a
 * question mark, an offer ("want me to", "shall I", "let me know") or a
 * yes/no prompt: a stop that waits on the user is never blocked, so this
 * errs towards "yes".
 */
export const asksUser = (message: string | null | undefined): boolean => {
  if (!message) return false;
  const paragraphs = message
    .replace(/```[\s\S]*?(?:```|$)/g, "\n\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  // A trailing option list belongs to the question before it.
  while (
    paragraphs.length > 1 &&
    paragraphs
      .at(-1)!
      .split("\n")
      .every((line) => LIST_ITEM.test(line))
  )
    paragraphs.pop();
  const tail = paragraphs.slice(-2).join("\n");
  return QUESTION.test(tail) || OFFER.test(tail) || YES_NO.test(tail);
};

const short = (sha: string | null | undefined) => (sha ?? "?").slice(0, 12);

/** A git command's output lines, or null when it fails. */
const gitList = (cwd: string, args: string[]): string[] | null => {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
  });
  return run.status === 0 ? run.stdout.split("\n").filter(Boolean) : null;
};

const gitLine = (cwd: string, args: string[]): string | null => gitList(cwd, args)?.[0] ?? null;

const sessionOf = (row: ReadRow): string | null =>
  (typeof row.session === "string" ? row.session : null) ?? row.actor.session;

/**
 * The branch's open PR: the newest one the CLI opened or observed
 * (`pr.created`, `pr.status`), unless it was merged since.
 */
const openPr = (rows: readonly ReadRow[]): number | null => {
  const seen = rows.findLast(
    (row) =>
      (row.type === "pr.created" || row.type === "pr.status") &&
      row.observer === "workit_cli" &&
      typeof row.pr === "number",
  );
  if (!seen) return null;
  const merged = rows.some(
    (row) => row.type === "pr.merged" && row.pr === seen.pr && row.seq > seen.seq,
  );
  return merged ? null : (seen.pr as number);
};

/**
 * Has the branch landed? A CLI `pr.merged` row for the current HEAD, or one
 * whose merged head already contains every commit of this session on HEAD:
 * the merge record and the branch both say done, so nothing is left to push
 * (the remote branch may be deleted) or to verify (an `--unverified` merge
 * was the user's call).
 */
const landed = (
  cwd: string,
  rows: readonly ReadRow[],
  head: string | null,
  mine: ReadonlySet<string>,
): boolean => {
  const merged = rows.filter(
    (row) =>
      row.type === "pr.merged" && row.observer === "workit_cli" && typeof row.head === "string",
  );
  if (!head || merged.length === 0) return false;
  if (merged.some((row) => row.head === head)) return true;
  if (mine.size === 0) return false;
  return merged.slice(-3).some((row) => {
    // Commits on HEAD the merged head lacks; null when it is not a local commit.
    const after = gitList(cwd, [
      "rev-list",
      `--max-count=${UNPUSHED_SCAN}`,
      "HEAD",
      "--not",
      row.head as string,
    ]);
    return after !== null && !after.some((sha) => mine.has(sha));
  });
};

/** How far back (a) looks for unpushed commits. */
const UNPUSHED_SCAN = 500;

/**
 * (a) This session's recorded commits on HEAD that the push remote does not
 * have. Another session's or the user's commits never count.
 */
const unpushed = (
  cwd: string,
  branch: string,
  endpoint: string,
  mine: ReadonlySet<string>,
): StopObligation | null => {
  const remote = pushRemoteName(cwd, branch);
  if (!remote || mine.size === 0) return null;
  const listed = gitList(cwd, [
    "rev-list",
    `--max-count=${UNPUSHED_SCAN}`,
    "HEAD",
    "--not",
    `--remotes=${remote}`,
  ]);
  const count = (listed ?? []).filter((sha) => mine.has(sha)).length;
  if (count === 0) return null;
  return {
    kind: "unpushed",
    reason: `${branch} has ${count} commit(s) of this session not on ${remote}, and this workspace's endpoint is \`${endpoint}\` (\`workit grant show\`): push them with \`workit git push\`${endpoint === "pr" ? ", then open or update the PR (`workit pr create --fill`)" : ""}.`,
  };
};

/** (b) The open PR's checks, as last recorded for the current head. */
const redChecks = (
  rows: readonly ReadRow[],
  pr: number,
  head: string,
  endpoint: string,
): StopObligation | null => {
  const status = rows.findLast(
    (row) => row.type === "pr.status" && row.observer === "workit_cli" && row.pr === pr,
  );
  const state = status && status.head === head ? status.checks : null;
  if (state !== "failing" && state !== "pending") return null;
  return {
    kind: "checks",
    reason: `PR #${pr}'s checks were last seen ${state} at ${short(head)}, and this workspace's endpoint is \`${endpoint}\`: run \`workit ci wait --pr ${pr}\`${state === "failing" ? " after fixing the failures `workit pr status` lists (then push)" : ""}.`,
  };
};

/** (c) Delivered by this session, yet no accepted non-author verdict on the head. */
const unverified = (
  cwd: string,
  branch: string,
  all: readonly ReadRow[],
  descriptor: HostDescriptor,
): StopObligation | null => {
  const check = checkVerdicts(cwd, branch, all);
  if (check.accepted.accepted || check.accepted.reasons.includes("failing_verdict")) return null;
  const has = check.review === "self-reviewed" ? "only a self verdict" : "no current verdict";
  const verifier = `${descriptor.subagents.agentPrefix}verifier`;
  return {
    kind: "verdict",
    reason: `the head ${short(check.head)} of ${branch}, which this session delivered, has ${has}: if no verifier is already running on it, hand it to a session that did not author it (the ${verifier} agent records \`workit ledger verdict <result> --branch ${branch} --how "<evidence>"\`), or tell the user it is unverified. Never record a verdict on your own work.`,
  };
};

/** The first unmet obligation for the session's branch, or null. Never throws. */
export function stopObligation(
  input: HookInput,
  descriptor: HostDescriptor,
): StopObligation | null {
  try {
    const session = input.session.id;
    if (!session || input.session.agentId || !inWorkitWorkspace(input.cwd)) return null;
    const branch = currentBranch(input.cwd);
    if (!branch || guardedBranch(input.cwd, branch)) return null;
    const ledger = readLedger(input.cwd);
    if (!ledger.ok) return null;
    const all = ledger.value.rows;
    const rows = all.filter((row) => row.branch === branch);
    const mine = rows.filter((row) => sessionOf(row) === session);
    const commits = new Set(
      mine
        .filter((row) => row.type === "commit.recorded")
        .map((row) => (typeof row.sha === "string" ? row.sha : row.head))
        .filter((sha): sha is string => typeof sha === "string"),
    );
    const delivered = mine.some(
      (row) =>
        row.observer === "workit_cli" &&
        (row.type === "pr.created" || row.type === "delivery.verified"),
    );
    if (commits.size === 0 && !delivered) return null;
    const head = gitLine(input.cwd, ["rev-parse", "HEAD"]);
    if (landed(input.cwd, rows, head, commits)) return null;
    const endpoint = resolveAutonomy(input.cwd).effectiveEndpoint;
    if (endpoint !== "commit") {
      const left = unpushed(input.cwd, branch, endpoint, commits);
      if (left) return left;
    }
    const pr = openPr(rows);
    if ((endpoint === "green" || endpoint === "merged") && pr !== null && head) {
      const left = redChecks(rows, pr, head, endpoint);
      if (left) return left;
    }
    return delivered ? unverified(input.cwd, branch, all, descriptor) : null;
  } catch {
    return null;
  }
}

/**
 * The stop decision: continue once with the obligation, or allow. A stop
 * that follows a continuation (`stopHookActive`), a subagent's stop, and a
 * stop whose last message asks the user something are always allowed. So is
 * a stop whose last message is unknown: it may be a question.
 */
export function stopDecision(input: HookInput, descriptor: HostDescriptor): HookDecision {
  const event = input.event;
  if (event.kind !== "stop" || event.stopHookActive) return NONE;
  if (!event.lastMessage?.trim() || asksUser(event.lastMessage)) return NONE;
  const left = stopObligation(input, descriptor);
  return left
    ? {
        kind: "continue",
        reason: `Workit: before stopping, ${left.reason} If this cannot be done now, say so to the user and stop.`,
      }
    : NONE;
}
