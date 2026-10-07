// `workit fanout plan|check` (G1, G2): flag parsing and rendering; the rules
// live in core fanout.ts and fanout-check.ts. The CLI never spawns agents.
//
//   workit fanout plan  <plan.json> [--name <n>] [--trunk <b>]
//   workit fanout check [<slice>…] [--name <n>] [--base <ref>]
import fs from "node:fs";
import path from "node:path";
import { checkFanout, type CheckOutcome } from "@brainervirus/workit-core/src/fanout-check";
import {
  planFanout,
  selectFanout,
  type FanoutError,
  type PlanOutcome,
} from "@brainervirus/workit-core/src/fanout";
import { currentBranch } from "@brainervirus/workit-core/src/git/rev";
import { actorFromEnv } from "@brainervirus/workit-core/src/ledger";
import { emit, fail, ok, type Io } from "../output";
import { parseFlags, usage } from "./forge-common";

const PLAN_USAGE = "workit fanout plan <plan.json> [--name <n>] [--trunk <b>] [--json]";
const CHECK_USAGE = "workit fanout check [<slice>…] [--name <n>] [--base <ref>] [--json]";
const USAGE = "workit fanout plan|check ... (workit help fanout)";

const failed = (io: Io, result: FanoutError): number =>
  emit(io, fail(result.code, result.error, { unblock: result.unblock, data: result.data ?? {} }));

function renderBlockedPlan(io: Io, result: FanoutError): void {
  if (io.json || (result.code !== "blocked" && result.code !== "invalid_input")) return;
  const problems = result.data?.problems;
  if (Array.isArray(problems)) for (const problem of problems) io.stderr(`  - ${problem}\n`);
  const conflicts = result.data?.conflicts;
  if (Array.isArray(conflicts))
    for (const conflict of conflicts as Array<{
      slices: string[];
      paths: string[];
      suggestion: { text: string };
      alternative?: { text: string };
    }>)
      io.stderr(
        `  - ${conflict.slices.join(" + ")}: ${conflict.paths.join(", ")}\n      fix: ${conflict.suggestion.text}${conflict.alternative ? `\n      or:  ${conflict.alternative.text}` : ""}\n`,
      );
}

function plan(argv: string[], io: Io): number {
  const flags = parseFlags(argv, { name: "value", trunk: "value" });
  if (typeof flags === "string") return usage(io, flags, PLAN_USAGE);
  if (flags.positionals.length !== 1)
    return usage(
      io,
      flags.positionals.length
        ? `unexpected argument ${flags.positionals[1]}`
        : "missing <plan.json>",
      PLAN_USAGE,
    );
  const file = path.resolve(io.cwd, flags.positionals[0]);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return usage(io, `cannot read ${file} as JSON: ${(error as Error).message}`, PLAN_USAGE);
  }
  const result = planFanout(io.cwd, {
    raw,
    name: flags.values.name ?? null,
    trunk: flags.values.trunk ?? null,
    actor: actorFromEnv(io.env),
  });
  if (!result.ok) {
    const code = failed(io, result);
    renderBlockedPlan(io, result);
    return code;
  }
  return emit(io, ok(result.data), (data: PlanOutcome) => [
    `${data.created ? "planned" : "re-planned"} fanout ${data.name} on ${data.trunk}: ${data.slices.length} slice${data.slices.length === 1 ? "" : "s"}`,
    ...data.slices.map(
      (slice) =>
        `  ${slice.id} [${slice.tier}] ${slice.branch} <- ${slice.base}${slice.dependsOn.length ? `  after ${slice.dependsOn.join(", ")}` : ""}\n      worktree ${slice.worktree}`,
    ),
    ...data.overlaps.map(
      (overlap) =>
        `  shared ${overlap.path}: ${overlap.resolution === "owner" ? `owned by ${overlap.owner}` : `serialized (${overlap.slices.join(" -> ")})`}`,
    ),
    `waves: ${data.waves.map((wave) => wave.join(", ")).join("  |  ")}`,
    `landing order: ${data.landingOrder.join(", ")}`,
    ...data.notes.map((note) => `note: ${note}`),
  ]);
}

const renderCheck = (data: CheckOutcome): string[] => [
  `fanout ${data.name} against ${data.trunkRef}: ${data.ready ? "ready to land" : "blocked"}`,
  ...data.slices.map(
    (slice) =>
      `  ${slice.status === "ready" ? "ok " : "x  "}${slice.id} (${slice.branch}) ${slice.changed} file${slice.changed === 1 ? "" : "s"} · verdict ${slice.verdict.accepted ? "accepted" : slice.verdict.basis}${slice.reasons.length ? `\n      ${slice.reasons.join("\n      ")}` : ""}`,
  ),
  ...data.conflicts.map(
    (conflict) =>
      `  conflict ${conflict.first} x ${conflict.second}: ${conflict.paths.join(", ")}\n      fix: ${conflict.resolution}`,
  ),
  `landing order: ${data.landingOrder.join(", ")}`,
  `next: ${data.next}`,
];

function check(argv: string[], io: Io): number {
  const flags = parseFlags(argv, { name: "value", base: "value" });
  if (typeof flags === "string") return usage(io, flags, CHECK_USAGE);
  const selected = selectFanout(io.cwd, flags.values.name ?? null, currentBranch(io.cwd));
  if (!selected.ok) return failed(io, selected);
  const result = checkFanout(io.cwd, selected.data, {
    only: flags.positionals,
    trunkRef: flags.values.base ?? null,
  });
  if (!result.ok) return failed(io, result);
  if (result.data.ready) return emit(io, ok(result.data), renderCheck);
  // Blocked: the full report stays in data; humans get it on stdout too.
  if (!io.json) for (const line of renderCheck(result.data)) io.stdout(`${line}\n`);
  const first = result.data.slices.find((slice) => slice.status === "blocked");
  return emit(
    io,
    fail("blocked", `slice ${first?.id ?? "?"} is not ready: ${first?.reasons[0] ?? "blocked"}`, {
      data: result.data,
      unblock: result.data.next,
    }),
  );
}

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv.filter((arg) => arg !== "--json");
  if (sub === "plan") return plan(rest, io);
  if (sub === "check") return check(rest, io);
  return usage(
    io,
    sub && !sub.startsWith("-")
      ? `unknown fanout subcommand "${sub}"`
      : "missing fanout subcommand",
    USAGE,
  );
}
