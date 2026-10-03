// `workit handoff` (design §2.1 S13): a compact resume brief for the
// checked-out branch, built from git and the shared ledger, so another
// session or worktree can pick up without an export/import step.
//
//   workit handoff [--note "<intent/progress>"] [--next "<next steps>"] [--record] [--last n] [--json]
//   workit handoff --task <id>      # the v1 task export, unchanged until S15
//
// --record appends the brief's note and next step to the ledger as a
// `handoff` row, which the next brief shows as `lastHandoff`.
import { parseArgs } from "node:util";
import {
  actorFromEnv,
  buildHandoff,
  recordHandoff,
  type HandoffBrief,
} from "@brainervirus/workit-core/src/ledger";
import { emit, fail, ok, type Io } from "../output";

const USAGE = "workit handoff [--note <text>] [--next <text>] [--record] [--last <n>] [--json]";

const short = (sha: string | null): string => (sha ? sha.slice(0, 12) : "no commit");

function human(brief: HandoffBrief & { recorded: string | null }): string[] {
  const lines = [
    `branch: ${brief.branch ?? "(detached)"} @ ${short(brief.head)}${brief.subject ? ` ${brief.subject}` : ""}`,
  ];
  if (brief.base)
    lines.push(
      `base:   ${brief.base}${brief.ahead === null ? "" : ` (ahead ${brief.ahead}, behind ${brief.behind})`}`,
    );
  lines.push(
    brief.dirty.dirty
      ? `dirty:  ${brief.dirty.files} file(s): ${brief.dirty.paths.join(", ")}${brief.dirty.files > brief.dirty.paths.length ? ", …" : ""}`
      : "dirty:  clean",
  );
  if (brief.stack)
    lines.push(
      `stack:  ${brief.stack.name} ${brief.stack.index}/${brief.stack.size}${brief.stack.parent ? ` on ${brief.stack.parent}` : ""}`,
    );
  if (brief.pr !== null) lines.push(`pr:     #${brief.pr}`);
  lines.push(
    `verdict: current ${brief.verdict.current}; ${brief.verdict.accepted ? "accepted" : `not accepted (${brief.verdict.reasons.join(", ")})`}`,
    ...brief.verdict.verdicts.map(
      (entry) =>
        `  ${entry.kind}: ${entry.basis}${entry.accepted ? ", accepted" : ` (${entry.reasons.join(", ")})`}  ${entry.summary}`,
    ),
  );
  if (brief.checks.length)
    lines.push(
      "checks:",
      ...brief.checks.map(
        (check) => `  ${check.name}: ${check.result ?? "?"} (${check.fresh ? "fresh" : "stale"})`,
      ),
    );
  if (brief.rulings.length)
    lines.push("rulings:", ...brief.rulings.map((row) => `  #${row.seq} ${row.summary}`));
  if (brief.lastHandoff)
    lines.push(
      `last handoff (${brief.lastHandoff.at}): ${brief.lastHandoff.next}${brief.lastHandoff.note ? ` (note: ${brief.lastHandoff.note})` : ""}`,
    );
  if (brief.recent.length)
    lines.push(
      "recent ledger:",
      ...brief.recent.map(
        (row) => `  #${row.seq} ${row.type}${row.branch ? ` [${row.branch}]` : ""}  ${row.summary}`,
      ),
    );
  if (brief.note) lines.push(`note:   ${brief.note}`);
  lines.push(`next:   ${brief.next}`);
  if (brief.next !== brief.nextCommand) lines.push(`next command: ${brief.nextCommand}`);
  if (brief.recorded) lines.push(`recorded handoff ${brief.recorded}`);
  return lines;
}

async function resumeBrief(argv: string[], io: Io): Promise<number> {
  let values: { note?: string; next?: string; record?: boolean; last?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        note: { type: "string" },
        next: { type: "string" },
        record: { type: "boolean" },
        last: { type: "string" },
        json: { type: "boolean" },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (error) {
    return emit(io, fail("invalid_input", (error as Error).message, { unblock: USAGE }));
  }
  const last = values.last === undefined ? 10 : Number(values.last);
  if (!Number.isInteger(last) || last < 1)
    return emit(io, fail("invalid_input", "--last must be a positive integer", { unblock: USAGE }));
  const built = buildHandoff(io.cwd, {
    last,
    note: values.note ?? null,
    next: values.next ?? null,
  });
  if (!built.ok)
    return emit(io, fail(built.code, built.error, built.unblock ? { unblock: built.unblock } : {}));
  const data = built.value;
  let recorded: string | null = null;
  if (values.record) {
    const row = recordHandoff(
      { cwd: io.cwd, actor: actorFromEnv(io.env), branch: data.branch },
      { note: data.note, next: data.next },
    );
    if (!row.ok) return emit(io, fail(row.code, row.error, { data: { ...data, recorded } }));
    recorded = row.value.id;
  }
  return emit(io, ok({ ...data, recorded }), human);
}

export async function run(argv: string[], io: Io): Promise<number> {
  if (!argv.includes("--task")) return resumeBrief(argv, io);
  const { runTaskCommand } = await import("../task");
  return runTaskCommand(["handoff", ...argv]);
}
