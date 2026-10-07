// `workit fanout brief <slice>`: the complete worker brief, rendered from the
// plan, the standing orders in force for the fanout (`workit ledger standing`)
// and the slice's scratch dir, so the lead passes it to the worker verbatim.
//
// MODE is `resume` when the branch already exists (a retry continues it),
// else `new`; `--attempt <n>` renders one attempt of a race on its own branch
// `<branch>-try<n>` (refused when another slice has that branch), worktree
// `<worktree>+try<n>` and session `<lead>-w-<slice>+try<n>`: slice ids cannot
// contain `+`, so no attempt collides with another slice's path or session.
// The lead must have a WORKIT_SESSION_ID: worker ids derive from it. A
// worker id longer than the ledger's 128 characters hashes its slice part. The fan-in line follows the plan's `fanIn`:
// one PR per slice forbids every merge; integration mode has the worker merge
// the integration tip before reporting, and nothing else. It only reads, apart
// from hiding `.workit-scratch/` in the repository's info/exclude.
import { createHash } from "node:crypto";
import { activeStanding, readLedger, type LedgerActor } from "./ledger";
import { branchRef, fanoutFail, type FanoutFile, type FanoutResult } from "./fanout";
import {
  SCRATCH_DIR,
  excludeScratch,
  findSlice,
  listWorktrees,
  samePath,
  slicePath,
} from "./fanout-worktree";

export type BriefMode = "new" | "resume";

export type BriefOutcome = {
  fanout: string;
  slice: string;
  mode: BriefMode;
  attempt: number | null;
  branch: string;
  base: string;
  tier: string;
  /** Absolute when the slice's worktree exists, else relative to the worker's worktree root. */
  scratch: string;
  session: string;
  standing: Array<{ id: string; what: string }>;
  text: string;
};

export const DEFAULT_TIMEBOX = "30 minutes";

const REPORT = [
  "REPORT: branch, head SHA, files changed, each VERIFY command with its exit code,",
  "  each ACCEPTANCE line met / not met, rulings you made (`workit ledger ruling`),",
  "  anything out of scope as a follow-up, not a diff.",
];

const rules = (mode: BriefMode, branch: string, base: string): string[] => [
  "RULES:",
  mode === "new"
    ? `  1. First command: \`workit git branch ${branch} --base ${base}\` (your worktree may start on another name).`
    : `  1. First command: \`git switch ${branch}\`, then continue from its head.`,
  '  2. Decide ambiguities yourself: `workit ledger ruling "<what>" --why "<why>" --cost-if-wrong "<cost>"`; stop only for an irreversible, security-sensitive or out-of-worktree action.',
  "  3. Commit with `workit git commit -m <msg> -- <paths in SCOPE>`; push only if this brief says so.",
  "  4. Never record a verdict on your own work.",
];

/** A session id fragment that the ledger accepts ([A-Za-z0-9_.:@/+-]). */
const sessionSafe = (text: string): string => text.replace(/[^A-Za-z0-9_.:@/+-]/gu, "-");

/** The ledger's session id limit. */
const SESSION_MAX = 128;

/** `<lead>-w-<slice>[+try<n>]`, with the slice part hashed when the whole would be too long. */
function workerSession(lead: string, slice: string, attempt: number | null): string {
  const tail = attempt === null ? "" : `+try${attempt}`;
  const full = `${lead}-w-${slice}${tail}`;
  if (full.length <= SESSION_MAX) return full;
  const digest = createHash("sha256").update(slice).digest("hex").slice(0, 12);
  return `${lead.slice(0, SESSION_MAX - 3 - digest.length - tail.length)}-w-${digest}${tail}`;
}

export function renderBrief(
  cwd: string,
  plan: FanoutFile,
  input: { slice: string; mode: BriefMode | null; attempt: number | null; actor: LedgerActor },
): FanoutResult<BriefOutcome> {
  const found = findSlice(plan, input.slice);
  if (!found.ok) return found;
  const slice = found.data;
  const ledger = readLedger(cwd);
  if (!ledger.ok) return fanoutFail(ledger.code, ledger.error, ledger.unblock);
  if (!input.actor.session)
    return fanoutFail(
      "blocked",
      "WORKIT_SESSION_ID is not set: worker session ids derive from the lead's",
      "export WORKIT_SESSION_ID=<your session id>, then render the brief again",
    );
  const branch = input.attempt === null ? slice.branch : `${slice.branch}-try${input.attempt}`;
  const taken = plan.slices.find((other) => other.id !== slice.id && other.branch === branch);
  if (taken)
    return fanoutFail(
      "invalid_input",
      `attempt branch ${branch} is slice ${taken.id}'s branch`,
      "pick another --attempt number, or rename one of the branches in the plan",
    );
  const head = branchRef(cwd, branch);
  const mode: BriefMode = input.mode ?? (head ? "resume" : "new");
  if (mode === "resume" && !head)
    return fanoutFail(
      "not_found",
      `MODE resume needs the branch ${branch}, which does not exist here`,
      `workit fanout brief ${slice.id} --mode new`,
    );

  const planned = `${slicePath(cwd, slice)}${input.attempt === null ? "" : `+try${input.attempt}`}`;
  const exists = listWorktrees(cwd).some((entry) => samePath(entry.path, planned));
  excludeScratch(cwd);
  const scratch = exists ? `${planned}/${SCRATCH_DIR}` : SCRATCH_DIR;
  const scratchLine = exists
    ? `SCRATCH: ${scratch}  (yours alone; temp files go here, never a shared path)`
    : `SCRATCH: ${SCRATCH_DIR}/ at your worktree root (mkdir -p it; git ignores it; never a shared path)`;

  const standing = activeStanding(ledger.value.rows, plan.name).map((row) => ({
    id: row.id,
    what: String(row.what),
  }));
  const session = workerSession(sessionSafe(input.actor.session), slice.id, input.attempt);
  const fanIn =
    plan.fanIn === "integration"
      ? [
          `FAN-IN: integration branch ${plan.trunk}. Before you report, merge its tip into your branch`,
          `  (\`git merge --no-edit ${plan.trunk}\`), resolve conflicts inside SCOPE and re-run VERIFY, so the`,
          "  lead's merge is a fast-forward. No other merge, and no rebase, retarget or force-push.",
        ]
      : [
          "FAN-IN: one PR per slice. Never rebase, retarget, merge or force-push: the lead owns topology.",
        ];

  const lines = [
    `MODE: ${mode}${input.attempt === null ? "" : `  (race attempt ${input.attempt}: the lead keeps the attempt with the best verdict)`}`,
    `GOAL: ${slice.goal}`,
    `SCOPE: ${slice.scope.join(", ")}`,
    ...(slice.owns.length ? [`  owns: ${slice.owns.join(", ")}`] : []),
    `  branch: ${branch}   base: ${slice.base}`,
    `CONTEXT: ${slice.context ?? "none given: read the files in SCOPE and the neighbours they import"}`,
    ...(mode === "resume" && head
      ? [
          `  resume: continue ${branch} from ${head.slice(0, 12)}; read \`git log ${slice.base}..${branch}\` and \`workit ledger list --branch ${branch}\` (the last report, verdicts, rulings)`,
        ]
      : []),
    "ACCEPTANCE:",
    ...slice.acceptance.map((line) => `  - ${line}`),
    `VERIFY: ${slice.verify.join("; ")}`,
    `TIER: ${slice.tier}`,
    `TIMEBOX: ${slice.timebox ?? DEFAULT_TIMEBOX}; past it without a new commit you will be replaced`,
    scratchLine,
    `FORBIDDEN: ${slice.forbidden.join("; ")}`,
    ...fanIn,
    ...REPORT,
    "STANDING:",
    ...(standing.length
      ? standing.map((order) => `  - ${order.what}`)
      : ["  - none recorded beyond this brief"]),
    `  export WORKIT_SESSION_ID=${session}`,
    ...rules(mode, branch, slice.base),
  ];
  return {
    ok: true,
    data: {
      fanout: plan.name,
      slice: slice.id,
      mode,
      attempt: input.attempt,
      branch,
      base: slice.base,
      tier: slice.tier,
      scratch,
      session,
      standing,
      text: `${lines.join("\n")}\n`,
    },
  };
}
