// Stop control (ledger decision "stop control: option A, nudge once"): when
// the main agent ends its turn with an obligation the ledger or git can
// prove unmet, the host continues it once with a reason naming the
// obligation and the workit command that clears it. The obligations, for the
// session's branch (the checked-out branch, on which this session recorded a
// commit or opened a PR):
//   (a) unpushed: a commit not on the push remote while the effective
//       endpoint is pr, green or merged;
//   (b) checks: the branch's open PR has failing or pending checks recorded
//       for its current head (`pr.status` rows) while the endpoint is green
//       or merged;
//   (c) verdict: the session opened the PR (or verified delivery) but the
//       head carries no accepted non-author verdict.
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

/** The trailing lines that may carry a question to the user. */
const QUESTION_TAIL = 6;

/**
 * Does the message end by asking the user something? A question mark ending
 * one of its last lines (past closing markup, quotes or brackets) counts: a
 * stop that waits on the user is never blocked, so this errs towards "yes".
 */
export const asksUser = (message: string | null | undefined): boolean => {
  if (!message) return false;
  const lines = message
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .map((line) => line.trim().replace(/[\s*_`"')\]>]+$/, ""))
    .filter(Boolean);
  return lines.slice(-QUESTION_TAIL).some((line) => line.endsWith("?") || line.endsWith("？"));
};

const short = (sha: string | null | undefined) => (sha ?? "?").slice(0, 12);

const gitLine = (cwd: string, args: string[]): string | null => {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
  });
  return run.status === 0 ? run.stdout.trim() || null : null;
};

const sessionOf = (row: ReadRow): string | null =>
  (typeof row.session === "string" ? row.session : null) ?? row.actor.session;

/** The newest PR the CLI opened for the branch, unless it was merged since. */
const openPr = (rows: readonly ReadRow[]): number | null => {
  const created = rows.findLast(
    (row) =>
      row.type === "pr.created" && row.observer === "workit_cli" && typeof row.pr === "number",
  );
  if (!created) return null;
  const merged = rows.some(
    (row) => row.type === "pr.merged" && row.pr === created.pr && row.seq > created.seq,
  );
  return merged ? null : (created.pr as number);
};

/** (a) Commits on HEAD the push remote does not have. */
const unpushed = (cwd: string, branch: string, endpoint: string): StopObligation | null => {
  const remote = pushRemoteName(cwd, branch);
  if (!remote) return null;
  const count = Number(
    gitLine(cwd, ["rev-list", "--count", "HEAD", "--not", `--remotes=${remote}`]),
  );
  if (!Number.isFinite(count) || count === 0) return null;
  return {
    kind: "unpushed",
    reason: `${branch} has ${count} commit(s) not on ${remote}, and this workspace's endpoint is \`${endpoint}\` (\`workit grant show\`): push them with \`workit git push\`${endpoint === "pr" ? ", then open or update the PR (`workit pr create --fill`)" : ""}.`,
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
    reason: `the head ${short(check.head)} of ${branch}, which this session delivered, has ${has}: hand it to a session that did not author it (the ${verifier} agent records \`workit ledger verdict <result> --branch ${branch} --how "<evidence>"\`), or tell the user it is unverified. Never record a verdict on your own work.`,
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
    const committed = mine.some((row) => row.type === "commit.recorded");
    const delivered = mine.some(
      (row) =>
        row.observer === "workit_cli" &&
        (row.type === "pr.created" || row.type === "delivery.verified"),
    );
    if (!committed && !delivered) return null;
    const endpoint = resolveAutonomy(input.cwd).effectiveEndpoint;
    if (endpoint !== "commit") {
      const left = unpushed(input.cwd, branch, endpoint);
      if (left) return left;
    }
    const pr = openPr(rows);
    const head = gitLine(input.cwd, ["rev-parse", "HEAD"]);
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
