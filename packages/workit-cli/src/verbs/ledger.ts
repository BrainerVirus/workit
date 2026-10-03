// `workit ledger` (design §2.1 S13): record and query the repo-wide run ledger.
//
//   workit ledger decision "<what>" --why "<why>" [--ref <path|url>…]
//   workit ledger ruling   "<what>" --why "<why>" --cost-if-wrong "<…>" [--ref …]
//   workit ledger verdict  <result> --how "<method/evidence>" [--kind unit|live|perf|review]
//                          [--pr n|--branch b] [--base <ref>] [--surface ui|cli|api]
//                          [--evidence <ref>…] [--self]
//   workit ledger verdict  [<branch>]                 # effective verdicts after carry-over
//   workit ledger list|show [--branch b] [--pr n] [--type t] [--last n]
//   workit ledger check    [--pr n|--branch b]
//   workit ledger add decision|ruling|verdict …       # same as the bare forms
//
// Every write accepts --supersedes <id>, plus --branch/--pr to key it.
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
  type RecordContext,
  type VerdictCheck,
} from "@brainervirus/workit-core/src/ledger";
import { currentBranch } from "@brainervirus/workit-core/src/git/rev";
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

const fromResult = <T>(io: Io, result: LedgerResult<T>, human: (value: T) => string): number =>
  result.ok
    ? emit(io, ok(result.value), human)
    : emit(io, fail(result.code, result.error, result.unblock ? { unblock: result.unblock } : {}));

const usage = (io: Io, error: string): number =>
  emit(io, fail("invalid_input", error, { unblock: USAGE }));

const verdictLines = (check: VerdictCheck): string[] => {
  const lines = [
    `${check.branch} @ ${(check.head ?? "no commit").slice(0, 12)}: ${check.valid ? "valid" : "no valid verdict"} (${check.basis})`,
  ];
  for (const entry of check.verdicts)
    lines.push(`  ${entry.kind}: ${entry.basis}  ${summarizeRow(entry.verdict).summary}`);
  return lines;
};

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
  const context: RecordContext = {
    cwd: io.cwd,
    actor: actorFromEnv(io.env),
    branch: values.branch ?? null,
    base: values.base ?? null,
    ...(pr === undefined ? {} : { pr }),
    ...(values.supersedes ? { supersedes: values.supersedes } : {}),
  };
  const text = rest.join(" ");

  switch (sub) {
    case "decision":
      return fromResult(
        io,
        recordDecision(context, { what: text, why: values.why, refs: values.ref }),
        (row) => `recorded decision ${row.id}`,
      );
    case "ruling":
      return fromResult(
        io,
        recordRuling(context, {
          what: text,
          why: values.why,
          costIfWrong: values["cost-if-wrong"],
          refs: values.ref,
        }),
        (row) => `recorded ruling ${row.id}`,
      );
    case "verdict": {
      const [first] = rest;
      const isResult =
        first !== undefined && (VERDICT_RESULTS as readonly string[]).includes(first);
      if (!isResult && values.how === undefined) {
        if (rest.length > 1) return usage(io, "ledger verdict takes at most one <branch>");
        return showVerdicts(io, first ?? values.branch, pr);
      }
      if (rest.length !== 1)
        return usage(io, `ledger verdict takes one result: ${VERDICT_RESULTS.join("|")}`);
      return fromResult(
        io,
        recordVerdict(context, {
          result: first,
          kind: values.kind,
          how: values.how,
          surface: values.surface ?? null,
          self: values.self === true,
          evidenceRefs: values.evidence,
        }),
        (row) =>
          `recorded verdict ${row.id}: ${row.result} [${row.kind}] for ${row.branch} @ ${(row.head ?? "").slice(0, 12)}${row.self ? " (self)" : ""}`,
      );
    }
    case "list":
    case "show": {
      if (rest.length) return usage(io, `unexpected argument: ${rest[0]}`);
      const ledger = readLedger(io.cwd);
      const rows = filterRows(ledger.rows, {
        branch: values.branch,
        pr,
        type: values.type,
        last: last ?? 50,
      });
      return emit(io, ok({ path: ledger.path, skipped: ledger.skipped, rows }), (data) =>
        data.rows.length
          ? data.rows.map((row) => {
              const line = summarizeRow(row);
              return `#${line.seq} ${line.at} ${line.type}${line.branch ? ` [${line.branch}]` : ""}${row.superseded ? " (superseded)" : ""}  ${line.summary}`;
            })
          : "ledger is empty",
      );
    }
    case "check":
      if (rest.length) return usage(io, `unexpected argument: ${rest[0]}`);
      return showVerdicts(io, values.branch, pr);
    case undefined:
      return usage(io, "missing subcommand");
    default:
      return usage(io, `unknown ledger subcommand "${sub}"`);
  }
}

function showVerdicts(io: Io, branchArg: string | undefined, pr: number | undefined): number {
  const ledger = readLedger(io.cwd);
  const branch =
    branchArg ?? (pr === undefined ? null : branchForPr(ledger.rows, pr)) ?? currentBranch(io.cwd);
  if (!branch)
    return emit(
      io,
      fail(
        pr === undefined ? "invalid_input" : "not_found",
        pr === undefined
          ? "HEAD is detached; name the branch"
          : `no ledger row maps PR ${pr} to a branch`,
        { unblock: "pass --branch <branch>" },
      ),
    );
  const check = checkVerdicts(io.cwd, branch, ledger.rows);
  return emit(io, ok({ ...check, ...(pr === undefined ? {} : { pr }) }), verdictLines);
}
