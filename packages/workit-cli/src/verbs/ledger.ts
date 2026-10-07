// `workit ledger` (design §2.1 S13, D18): record and query the repo-wide run ledger.
//
//   workit ledger decision "<what>" --why "<why>" [--ref <path|url>…]
//   workit ledger ruling   "<what>" --why "<why>" --cost-if-wrong "<…>" [--ref …]
//   workit ledger verdict  <result> --how "<method/evidence>" [--kind unit|live|perf|review]
//                          [--pr n|--branch b] [--base <ref>] [--surface ui|cli|api]
//                          [--evidence <ref>…] [--self] [--session <id> | --as <role>]
//   workit ledger verdict  [<branch>]                 # current + accepted verdicts
//   workit ledger list|show [--branch b] [--pr n] [--type t] [--last n]
//   workit ledger check    [--pr n|--branch b]
//   workit ledger standing add "<order>" | list | clear [<id>]  [--fanout <name>]
//                          # the lead's standing orders for a fanout's workers,
//                          # recorded only by the session that first made the
//                          # plan; `workit fanout brief` pastes those in force
//   workit ledger add decision|ruling|verdict …       # same as the bare forms
//
// Every write accepts --supersedes <id> (same type, same session only), plus
// --branch/--pr to key it. Verdicts are agent-asserted; the acting session is
// WORKIT_SESSION_ID, and without one a verdict is recorded as self.
// `--session <id>` names the acting session explicitly; `--as <role>` mints a
// fresh one (`<session or host>:<role>:<random>`) for a verifier or reviewer
// subagent that shares its lead's environment, so no two verifiers ever share
// an id and none collides with the author's. `--pr`
// must resolve to a branch through the CLI's own PR rows or a fetched forge
// ref; it is never guessed from other rows.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import {
  VERDICT_RESULTS,
  actorFromEnv,
  branchForPr,
  activeStanding,
  checkVerdicts,
  clearStanding,
  filterRows,
  readLedger,
  recordDecision,
  recordRuling,
  recordStanding,
  recordVerdict,
  summarizeRow,
  type LedgerResult,
  type ReadRow,
  type RecordContext,
  type VerdictCheck,
} from "@brainervirus/workit-core/src/ledger";
import { readFanout, selectFanout, type FanoutFile } from "@brainervirus/workit-core/src/fanout";
import { currentBranch } from "@brainervirus/workit-core/src/git/rev";
import { ensureImplicitTask } from "./implicit-task";
import { emit, fail, ok, type Io } from "../output";

const USAGE =
  "workit ledger decision|ruling|verdict|standing|list|check ... (workit help ledger for the grammar)";
const STANDING_USAGE =
  'workit ledger standing add "<order>" | list | clear [<id>]  [--fanout <name>] [--json]';

const OPTIONS = {
  why: { type: "string" },
  "cost-if-wrong": { type: "string" },
  ref: { type: "string", multiple: true },
  how: { type: "string" },
  kind: { type: "string" },
  surface: { type: "string" },
  evidence: { type: "string", multiple: true },
  self: { type: "boolean" },
  branch: { type: "string" },
  base: { type: "string" },
  pr: { type: "string" },
  type: { type: "string" },
  last: { type: "string" },
  supersedes: { type: "string" },
  session: { type: "string" },
  as: { type: "string" },
  fanout: { type: "string" },
  json: { type: "boolean" },
} as const;

type Values = {
  why?: string;
  "cost-if-wrong"?: string;
  ref?: string[];
  how?: string;
  kind?: string;
  surface?: string;
  evidence?: string[];
  self?: boolean;
  branch?: string;
  base?: string;
  pr?: string;
  type?: string;
  last?: string;
  supersedes?: string;
  session?: string;
  as?: string;
  fanout?: string;
};

const SESSION_SAFE = /^[A-Za-z0-9_.:@/+-]{1,128}$/;
const ROLE_SAFE = /^[a-z][a-z0-9-]{0,31}$/;

type Acting = { actor: RecordContext["actor"]; derivedFrom?: string | null };

/**
 * The acting identity: --session, a fresh --as role id, else the environment.
 * An --as id remembers the session it was derived from: with none it is self,
 * and an author's derived id is refused like the author (D18).
 */
const actorFor = (io: Io, values: Values): Acting | Error => {
  const actor = actorFromEnv(io.env);
  if (values.session !== undefined && values.as !== undefined)
    return new Error("pass --session or --as, not both");
  if (values.session !== undefined) {
    if (!SESSION_SAFE.test(values.session))
      return new Error("--session must be 1-128 characters of [A-Za-z0-9_.:@/+-]");
    return { actor: { ...actor, session: values.session } };
  }
  if (values.as !== undefined) {
    if (!ROLE_SAFE.test(values.as)) return new Error("--as takes a lowercase role, e.g. verifier");
    const prefix = (actor.session ?? actor.host).slice(0, 96);
    return {
      actor: { ...actor, session: `${prefix}:${values.as}:${randomBytes(4).toString("hex")}` },
      derivedFrom: actor.session,
    };
  }
  return { actor };
};

const positiveInt = (value: string | undefined, flag: string): number | undefined | Error => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : new Error(`${flag} must be a positive integer`);
};

const failed = (io: Io, result: Extract<LedgerResult<unknown>, { ok: false }>): number =>
  emit(io, fail(result.code, result.error, result.unblock ? { unblock: result.unblock } : {}));

const fromResult = <T>(io: Io, result: LedgerResult<T>, human: (value: T) => string): number =>
  result.ok ? emit(io, ok(result.value), human) : failed(io, result);

const usage = (io: Io, error: string): number =>
  emit(io, fail("invalid_input", error, { unblock: USAGE }));

const verdictLines = (check: VerdictCheck): string[] => {
  const lines = [
    `${check.branch} @ ${(check.head ?? "no commit").slice(0, 12)}: current: ${check.current.basis}${typeof check.current.verdict?.result === "string" ? ` (${check.current.verdict.result})` : ""}; ${check.accepted.accepted ? "accepted" : `not accepted (${check.accepted.reasons.join(", ")})`}; review: ${check.review}`,
  ];
  for (const entry of check.verdicts)
    lines.push(
      `  ${entry.kind}: ${entry.basis}${entry.accepted ? ", accepted" : ` (${entry.reasons.join(", ")})`}  ${summarizeRow(entry.verdict).summary}`,
    );
  return lines;
};

/**
 * The branch a command targets: --branch, else the branch --pr resolves to
 * (refused when unknown or when it disagrees with --branch), else HEAD's.
 */
function targetBranch(
  io: Io,
  rows: readonly ReadRow[],
  branch: string | undefined,
  pr: number | undefined,
): LedgerResult<string | null> {
  if (pr !== undefined) {
    const resolved = branchForPr(io.cwd, rows, pr);
    if (!resolved.ok)
      return {
        ok: false,
        code: "invalid_input",
        error:
          resolved.reason === "ambiguous"
            ? `cannot resolve PR ${pr} to a branch: ambiguous (${resolved.candidates.join(", ")})`
            : `cannot resolve PR ${pr} to a branch: no workit pr row records it and no fetched forge ref (refs/pull/${pr}/head) points at a local branch tip`,
        unblock: "pass --branch <branch> instead, or fetch the PR ref",
      };
    if (branch !== undefined && branch !== resolved.branch)
      return {
        ok: false,
        code: "invalid_input",
        error: `PR ${pr} is branch ${resolved.branch}, not ${branch}`,
      };
    return { ok: true, value: resolved.branch };
  }
  return { ok: true, value: branch ?? null };
}

export async function run(argv: string[], io: Io): Promise<number> {
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    return usage(io, (error as Error).message);
  }
  const { values } = parsed;
  let positionals = parsed.positionals;
  if (positionals[0] === "add") {
    positionals = positionals.slice(1);
    if (!["decision", "ruling", "verdict"].includes(positionals[0] ?? ""))
      return usage(io, "ledger add takes decision|ruling|verdict");
  }
  const [sub, ...rest] = positionals;
  const pr = positiveInt(values.pr, "--pr");
  if (pr instanceof Error) return usage(io, pr.message);
  const last = positiveInt(values.last, "--last");
  if (last instanceof Error) return usage(io, last.message);
  const text = rest.join(" ");
  if (sub === undefined) return usage(io, "missing subcommand");
  if (!["decision", "ruling", "verdict", "standing", "list", "show", "check"].includes(sub))
    return usage(io, `unknown ledger subcommand "${sub}"`);
  if (sub === "standing") return standing(io, values, rest);

  const ledger = readLedger(io.cwd);
  if (!ledger.ok) return failed(io, ledger);
  const { rows } = ledger.value;

  if (sub === "list" || sub === "show") {
    if (rest.length) return usage(io, `unexpected argument: ${rest[0]}`);
    const listed = filterRows(rows, {
      branch: values.branch,
      pr,
      type: values.type,
      last: last ?? 50,
    });
    return emit(
      io,
      ok({ path: ledger.value.path, skipped: ledger.value.skipped, rows: listed }),
      (data) =>
        data.rows.length
          ? data.rows.map((row) => {
              const line = summarizeRow(row);
              return `#${line.seq} ${line.at} ${line.type}${line.branch ? ` [${line.branch}]` : ""}${line.labels.length ? ` (${line.labels.join(", ")})` : ""}  ${line.summary}`;
            })
          : "ledger is empty",
    );
  }

  const isRead =
    sub === "check" ||
    (sub === "verdict" &&
      values.how === undefined &&
      !(VERDICT_RESULTS as readonly string[]).includes(rest[0] ?? ""));
  if (isRead) {
    if (rest.length > (sub === "verdict" ? 1 : 0))
      return usage(io, `unexpected argument: ${rest.at(-1)}`);
    const target = targetBranch(io, rows, rest[0] ?? values.branch, pr);
    if (!target.ok) return failed(io, target);
    const branch = target.value ?? currentBranch(io.cwd);
    if (!branch)
      return emit(
        io,
        fail("invalid_input", "HEAD is detached; name the branch", {
          unblock: "pass --branch <branch>",
        }),
      );
    return emit(io, ok(checkVerdicts(io.cwd, branch, rows)), verdictLines);
  }

  const target = targetBranch(io, rows, values.branch, pr);
  if (!target.ok) return failed(io, target);
  const acting = actorFor(io, values);
  if (acting instanceof Error) return usage(io, acting.message);
  const { actor } = acting;
  const context: RecordContext = {
    cwd: io.cwd,
    actor,
    branch: target.value,
    base: values.base ?? null,
    ...(pr === undefined ? {} : { pr }),
    ...(values.supersedes ? { supersedes: values.supersedes } : {}),
  };

  // A recording on the checked-out branch creates its implicit task (D3).
  const recorded = async <T>(result: LedgerResult<T>): Promise<LedgerResult<T>> => {
    if (result.ok) await ensureImplicitTask(io, target.value ?? null);
    return result;
  };
  if (sub === "decision")
    return fromResult(
      io,
      await recorded(recordDecision(context, { what: text, why: values.why, refs: values.ref })),
      (row) => `recorded decision ${row.id}`,
    );
  if (sub === "ruling")
    return fromResult(
      io,
      await recorded(
        recordRuling(context, {
          what: text,
          why: values.why,
          costIfWrong: values["cost-if-wrong"],
          refs: values.ref,
        }),
      ),
      (row) => `recorded ruling ${row.id}`,
    );
  if (rest.length !== 1)
    return usage(io, `ledger verdict takes one result: ${VERDICT_RESULTS.join("|")}`);
  return fromResult(
    io,
    await recorded(
      recordVerdict(context, {
        result: rest[0],
        kind: values.kind,
        how: values.how,
        surface: values.surface ?? null,
        self: values.self === true,
        evidenceRefs: values.evidence,
        ...("derivedFrom" in acting ? { derivedFrom: acting.derivedFrom } : {}),
      }),
    ),
    (row) =>
      `recorded verdict ${row.id}: ${row.result} [${row.kind}] for ${row.branch} @ ${(row.head ?? "").slice(0, 12)} as ${actor.session ?? "no session"}${row.self ? ` (self${row.selfReason === "no_session" ? ": WORKIT_SESSION_ID unset" : ""}; never accepted)` : ""}`,
  );
}

/** The fanout a standing order belongs to: --fanout, else the plan `fanout` commands would pick. */
/**
 * The fanout a standing order belongs to: --fanout, else the plan `fanout`
 * commands would pick. `plan` is null only for a --fanout with no plan file
 * (its orders can still be listed and cleared).
 */
function standingFanout(io: Io, values: Values): { name: string; plan: FanoutFile | null } | Error {
  if (values.fanout !== undefined) {
    const name = values.fanout.trim();
    if (!name) return new Error("--fanout needs a plan name");
    const read = readFanout(io.cwd, name);
    return { name, plan: read.ok ? read.data : null };
  }
  const selected = selectFanout(io.cwd, null, currentBranch(io.cwd));
  return selected.ok
    ? { name: selected.data.name, plan: selected.data }
    : new Error(`${selected.error}; pass --fanout <name>`);
}

async function standing(io: Io, values: Values, args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action !== "add" && action !== "list" && action !== "clear")
    return emit(
      io,
      fail(
        "invalid_input",
        action ? `unknown standing action "${action}"` : "missing add, list or clear",
        { unblock: STANDING_USAGE },
      ),
    );
  const target = standingFanout(io, values);
  if (target instanceof Error)
    return emit(io, fail("invalid_input", target.message, { unblock: STANDING_USAGE }));
  const fanout = target.name;
  const lead = target.plan?.leadSession ?? null;
  if (action === "list") {
    if (rest.length) return usage(io, `unexpected argument: ${rest[0]}`);
    const ledger = readLedger(io.cwd);
    if (!ledger.ok) return failed(io, ledger);
    const orders = activeStanding(ledger.value.rows, fanout, lead).map((row) => ({
      id: row.id,
      at: row.at,
      what: row.what as string,
    }));
    return emit(io, ok({ fanout, orders }), (data) =>
      data.orders.length
        ? [
            `standing orders for fanout ${fanout}:`,
            ...data.orders.map((o) => `  ${o.id}  ${o.what}`),
          ]
        : `no standing orders for fanout ${fanout}`,
    );
  }
  const acting = actorFor(io, values);
  if (acting instanceof Error) return usage(io, acting.message);
  const context: RecordContext = {
    cwd: io.cwd,
    actor: acting.actor,
    ...(values.supersedes ? { supersedes: values.supersedes } : {}),
  };
  if (action === "add" && target.plan === null)
    return emit(
      io,
      fail("not_found", `no fanout plan named ${fanout}`, {
        unblock: "workit fanout plan <plan.json> first, or name an existing plan with --fanout",
      }),
    );
  if (action === "add")
    return fromResult(
      io,
      recordStanding(context, { fanout, lead, what: rest.join(" ") }),
      (row) => `recorded standing order ${row.id} for fanout ${fanout}`,
    );
  if (rest.length > 1) return usage(io, `unexpected argument: ${rest[1]}`);
  return fromResult(io, clearStanding(context, { fanout, lead, target: rest[0] ?? null }), (row) =>
    row.target
      ? `cleared standing order ${row.target} for fanout ${fanout}`
      : `cleared every standing order for fanout ${fanout}`,
  );
}
