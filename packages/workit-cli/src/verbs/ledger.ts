// `workit ledger` (design §2.1 S13, D18): record and query the repo-wide run ledger.
//
//   workit ledger decision "<what>" --why "<why>" [--ref <path|url>…]
//   workit ledger ruling   "<what>" --why "<why>" --cost-if-wrong "<…>" [--ref …]
//   workit ledger verdict  <result> --how "<method/evidence>" [--kind unit|live|perf|review]
//                          [--pr n|--branch b] [--base <ref>] [--surface ui|cli|api]
//                          [--evidence <ref>…] [--self]
//   workit ledger verdict  [<branch>]                 # current + accepted verdicts
//   workit ledger list|show [--branch b] [--pr n] [--type t] [--last n]
//   workit ledger check    [--pr n|--branch b]
//   workit ledger add decision|ruling|verdict …       # same as the bare forms
//
// Every write accepts --supersedes <id> (same type, same session only), plus
// --branch/--pr to key it. Verdicts are agent-asserted; the acting session is
// WORKIT_SESSION_ID, and without one a verdict is recorded as self. `--pr`
// must resolve to a branch through the CLI's own PR rows or a fetched forge
// ref; it is never guessed from other rows.
import { parseArgs } from "node:util";
import {
  VERDICT_RESULTS,
  actorFromEnv,
  branchForPr,
  checkVerdicts,
  filterRows,
  readLedger,
  recordDecision,
  recordRuling,
  recordVerdict,
  summarizeRow,
  type LedgerResult,
  type ReadRow,
  type RecordContext,
  type VerdictCheck,
} from "@brainervirus/workit-core/src/ledger";
import { currentBranch } from "@brainervirus/workit-core/src/git/rev";
import { ensureImplicitTask } from "./implicit-task";
import { emit, fail, ok, type Io } from "../output";

const USAGE =
  "workit ledger decision|ruling|verdict|list|check ... (workit help ledger for the grammar)";

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
    `${check.branch} @ ${(check.head ?? "no commit").slice(0, 12)}: current: ${check.current.basis}${typeof check.current.verdict?.result === "string" ? ` (${check.current.verdict.result})` : ""}; ${check.accepted.accepted ? "accepted" : `not accepted (${check.accepted.reasons.join(", ")})`}`,
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
  if (!["decision", "ruling", "verdict", "list", "show", "check"].includes(sub))
    return usage(io, `unknown ledger subcommand "${sub}"`);

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
  const context: RecordContext = {
    cwd: io.cwd,
    actor: actorFromEnv(io.env),
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
      }),
    ),
    (row) =>
      `recorded verdict ${row.id}: ${row.result} [${row.kind}] for ${row.branch} @ ${(row.head ?? "").slice(0, 12)}${row.self ? ` (self${row.selfReason === "no_session" ? ": WORKIT_SESSION_ID unset" : ""}; never accepted)` : ""}`,
  );
}
