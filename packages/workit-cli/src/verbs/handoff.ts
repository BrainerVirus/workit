// `workit handoff` (design §2.1 S13): a compact resume brief for the
// checked-out branch, built from git and the shared ledger, so another
// session or worktree can pick up without an export/import step.
//
//   workit handoff [--note "<intent/progress>"] [--next "<next steps>"] [--record] [--last n] [--json]
//   workit handoff --task <id>      # the v1 task export, unchanged until S15
//
// --record appends the brief's note and next step to the ledger as a
// `handoff` row, which the next brief shows as `lastHandoff`.
//
// The printed brief stays within MAX_BRIEF_BYTES (#426): a longer one is cut
// in the middle (its note and next step always print) and the whole brief is
// written under the store's handoff/ dir, whose path the brief names.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  actorFromEnv,
  buildHandoff,
  recordHandoff,
  storeRoot,
  type HandoffBrief,
} from "@brainervirus/workit-core/src/ledger";
import { emit, fail, ok, type Io } from "../output";

const USAGE = "workit handoff [--note <text>] [--next <text>] [--record] [--last <n>] [--json]";

/** The printed brief's bound; the full brief goes to a file. */
export const MAX_BRIEF_BYTES = 4096;

const short = (sha: string | null): string => (sha ? sha.slice(0, 12) : "no commit");

type Brief = HandoffBrief & { recorded: string | null };

/** The brief as lines: `body` may be cut, `tail` (note, next step, recording) always prints. */
function render(brief: Brief): { body: string[]; tail: string[] } {
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
        (row) =>
          `  #${row.seq} ${row.type}${row.branch ? ` [${row.branch}]` : ""}${row.labels.length ? ` (${row.labels.join(", ")})` : ""}  ${row.summary}`,
      ),
    );
  const tail: string[] = [];
  if (brief.note) tail.push(`note:   ${brief.note}`);
  tail.push(`next:   ${brief.next}`);
  if (brief.next !== brief.nextCommand) tail.push(`next command: ${brief.nextCommand}`);
  if (brief.recorded) tail.push(`recorded handoff ${brief.recorded}`);
  return { body: lines, tail };
}

const bytes = (lines: string[]): number => Buffer.byteLength(`${lines.join("\n")}\n`);

const TAIL_LINE_BYTES = 480;

/** A tail line (note, next) cut to TAIL_LINE_BYTES so huge values cannot push the brief past its bound. */
const capLine = (line: string): string =>
  Buffer.byteLength(line) <= TAIL_LINE_BYTES
    ? line
    : `${Buffer.from(line)
        .subarray(0, TAIL_LINE_BYTES)
        .toString()
        .replace(/\uFFFD$/u, "")}… (cut)`;

/** The brief within MAX_BRIEF_BYTES, writing the whole one to a file when it is longer. */
function bounded(brief: Brief, cwd: string): string[] {
  const { body, tail } = render(brief);
  // The branch line, then the note/next step, then the evidence: an agent reads the top.
  const [first, ...rest] = body;
  if (bytes([...body, ...tail]) <= MAX_BRIEF_BYTES) return [first, ...tail, ...rest];
  const store = storeRoot(cwd);
  let file: string | null = null;
  if (store.ok)
    try {
      const dir = path.join(store.value.root, "handoff");
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, `${(brief.branch ?? "detached").replaceAll(/[^\w.-]+/gu, "-")}.txt`);
      fs.writeFileSync(file, `${[first, ...tail, ...rest].join("\n")}\n`, {
        mode: 0o600,
      });
    } catch {
      file = null;
    }
  const pointer = `… cut to ${MAX_BRIEF_BYTES} bytes; full brief: ${file ?? "not written (workit handoff --json has it all)"}`;
  const cappedTail = tail.map(capLine);
  const kept: string[] = [];
  for (const line of rest) {
    const cut = line.length > 400 ? `${line.slice(0, 400)}…` : line;
    if (bytes([first, ...cappedTail, ...kept, cut, pointer]) > MAX_BRIEF_BYTES) break;
    kept.push(cut);
  }
  return [first, ...cappedTail, ...kept, pointer];
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
    return emit(
      io,
      fail("invalid_input", "--last must be a positive integer", {
        unblock: USAGE,
      }),
    );
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
  return emit(io, ok({ ...data, recorded }), (brief) => bounded(brief, io.cwd));
}

export async function run(argv: string[], io: Io): Promise<number> {
  if (!argv.some((arg) => arg === "--task" || arg.startsWith("--task=")))
    return resumeBrief(argv, io);
  const { runTaskCommand } = await import("../task");
  return runTaskCommand(["handoff", ...argv]);
}
