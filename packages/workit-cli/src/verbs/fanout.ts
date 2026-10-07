// `workit fanout plan|brief|check|status|worktree` (G1-G5): flag parsing and
// rendering; the rules live in core fanout*.ts. The CLI never spawns agents.
//
//   workit fanout plan     <plan.json> [--name <n>] [--trunk <b> | --track <t>]
//   workit fanout brief    <slice> [--name <n>] [--mode new|resume] [--attempt <n>]
//   workit fanout check    [<slice>…] [--name <n>] [--base <ref>] [--offline]
//   workit fanout status   [--name <n>] [--stuck-after 30m] [--offline]
//   workit fanout worktree create|release <slice> [--name <n>] [--force]
import fs from "node:fs";
import path from "node:path";
import type { ResolvedForge } from "@brainervirus/workit-core/src/forge/resolve";
import { renderBrief, type BriefOutcome } from "@brainervirus/workit-core/src/fanout-brief";
import { checkFanout, type CheckOutcome } from "@brainervirus/workit-core/src/fanout-check";
import { fanoutStatus, type StatusOutcome } from "@brainervirus/workit-core/src/fanout-status";
import {
  createSliceWorktree,
  releaseSliceWorktree,
  type CreateOutcome,
  type ReleaseOutcome,
} from "@brainervirus/workit-core/src/fanout-worktree";
import {
  planFanout,
  selectFanout,
  type FanoutError,
  type PlanOutcome,
} from "@brainervirus/workit-core/src/fanout";
import { currentBranch } from "@brainervirus/workit-core/src/git/rev";
import { actorFromEnv } from "@brainervirus/workit-core/src/ledger";
import { emit, fail, ok, type Io } from "../output";
import { connect, parseDuration, parseFlags, releaseTrunk, usage } from "./forge-common";

const PLAN_USAGE =
  "workit fanout plan <plan.json> [--name <n>] [--trunk <b> | --track <t>] [--json]";
const BRIEF_USAGE =
  "workit fanout brief <slice> [--name <n>] [--mode new|resume] [--attempt <n>] [--json]";
const CHECK_USAGE =
  "workit fanout check [<slice>…] [--name <n>] [--base <ref>] [--offline] [--json]";
const STATUS_USAGE = "workit fanout status [--name <n>] [--stuck-after 30m] [--offline] [--json]";
const WORKTREE_USAGE =
  "workit fanout worktree create <slice> [--name <n>] | worktree release <slice> [--name <n>] [--force] [--json]";
const USAGE = "workit fanout plan|brief|check|status|worktree ... (workit help fanout)";

/** The forge for PR lookups, or why there is none (offline is never an error). */
function forgeFor(io: Io, offline: boolean): { forge: ResolvedForge | null; error: string | null } {
  if (offline) return { forge: null, error: "--offline" };
  const connected = connect(io, null);
  return connected.ok
    ? { forge: connected.data, error: null }
    : { forge: null, error: connected.error };
}

const failed = (io: Io, result: FanoutError): number =>
  emit(io, fail(result.code, result.error, { unblock: result.unblock, data: result.data ?? {} }));

function renderBlockedPlan(io: Io, result: FanoutError): void {
  if (io.json || (result.code !== "blocked" && result.code !== "invalid_input")) return;
  const problems = result.data?.problems;
  if (Array.isArray(problems)) for (const problem of problems) io.stderr(`  - ${problem}\n`);
  const clashes = result.data?.caseCollisions;
  if (Array.isArray(clashes))
    for (const clash of clashes as Array<{ slice: string; path: string; trunk: string }>)
      io.stderr(`  - ${clash.slice}: ${clash.path} ~ trunk's ${clash.trunk}\n`);
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

/**
 * The trunk: --trunk, else the plan's `trunk`, else the release track's PR
 * target when tracks are configured (as `stack plan`; an undetermined line
 * blocks), else core's default (origin's default branch, else main).
 * --track picks the track and must agree with a `trunk` the plan names.
 */
function resolveTrunk(
  io: Io,
  raw: unknown,
  flag: string | null,
  track: string | null,
): { trunk: string | null } | { code: number } {
  if (flag !== null) return { trunk: flag };
  const named =
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as { trunk?: unknown }).trunk === "string"
      ? (raw as { trunk: string }).trunk.trim() || null
      : null;
  if (named !== null && track === null) return { trunk: null };
  const derived = releaseTrunk(io, track, null);
  if ("error" in derived)
    return {
      code: emit(
        io,
        fail("blocked", derived.error, {
          unblock: "workit fanout plan <plan.json> --track <name>  # or --trunk <branch>",
        }),
      ),
    };
  if (named !== null && derived.trunk !== named)
    return {
      code: usage(
        io,
        `the plan names trunk ${named}; --track ${track} targets ${derived.trunk ?? "(none)"}`,
        PLAN_USAGE,
      ),
    };
  return { trunk: derived.tracked || track !== null ? derived.trunk : null };
}

function plan(argv: string[], io: Io): number {
  const flags = parseFlags(argv, { name: "value", trunk: "value", track: "value" });
  if (typeof flags === "string") return usage(io, flags, PLAN_USAGE);
  const track = flags.values.track ?? null;
  if (track !== null && flags.values.trunk !== undefined)
    return usage(io, "pass --trunk or --track, not both (--track picks the trunk)", PLAN_USAGE);
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
  const trunk = resolveTrunk(io, raw, flags.values.trunk ?? null, track);
  if ("code" in trunk) return trunk.code;
  const result = planFanout(io.cwd, {
    raw,
    name: flags.values.name ?? null,
    trunk: trunk.trunk,
    actor: actorFromEnv(io.env),
  });
  if (!result.ok) {
    const code = failed(io, result);
    renderBlockedPlan(io, result);
    return code;
  }
  return emit(io, ok(result.data), (data: PlanOutcome) => [
    `${data.created ? "planned" : "re-planned"} fanout ${data.name} on ${data.trunk}${data.fanIn === "integration" ? " (integration branch: one PR)" : ""}: ${data.slices.length} slice${data.slices.length === 1 ? "" : "s"}`,
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
    ...data.warnings.map((warning) => `warning: ${warning}`),
  ]);
}

function brief(argv: string[], io: Io): number {
  const flags = parseFlags(argv, { name: "value", mode: "value", attempt: "value" });
  if (typeof flags === "string") return usage(io, flags, BRIEF_USAGE);
  if (flags.positionals.length !== 1)
    return usage(
      io,
      flags.positionals.length ? `unexpected argument ${flags.positionals[1]}` : "missing <slice>",
      BRIEF_USAGE,
    );
  const mode = flags.values.mode ?? null;
  if (mode !== null && mode !== "new" && mode !== "resume")
    return usage(io, "--mode takes new or resume", BRIEF_USAGE);
  const rawAttempt = flags.values.attempt;
  const attempt = rawAttempt === undefined ? null : Number(rawAttempt);
  if (attempt !== null && !(Number.isInteger(attempt) && attempt >= 1 && attempt <= 9))
    return usage(io, "--attempt takes a number from 1 to 9", BRIEF_USAGE);
  const selected = selectFanout(io.cwd, flags.values.name ?? null, currentBranch(io.cwd));
  if (!selected.ok) return failed(io, selected);
  const result = renderBrief(io.cwd, selected.data, {
    slice: flags.positionals[0],
    mode,
    attempt,
    actor: actorFromEnv(io.env),
  });
  if (!result.ok) return failed(io, result);
  return emit(io, ok(result.data), (data: BriefOutcome) => data.text.trimEnd());
}

const renderCheck = (data: CheckOutcome): string[] => [
  `fanout ${data.name} against ${data.trunkRef}: ${data.ready ? "ready to land" : "blocked"}`,
  ...data.slices.map((slice) =>
    slice.status === "landed"
      ? `  -- ${slice.id} (${slice.branch}) landed (${slice.landed?.how}${slice.landed?.pr ? ` #${slice.landed.pr}` : ""})`
      : `  ${slice.status === "ready" ? "ok " : "x  "}${slice.id} (${slice.branch}) ${slice.changed} file${slice.changed === 1 ? "" : "s"} · verdict ${slice.verdict.accepted ? "accepted" : slice.verdict.basis}${slice.reasons.length ? `\n      ${slice.reasons.join("\n      ")}` : ""}`,
  ),
  ...data.conflicts.map(
    (conflict) =>
      `  conflict ${conflict.first} x ${conflict.second}: ${conflict.paths.join(", ")}\n      fix: ${conflict.resolution}`,
  ),
  `landing order: ${data.landingOrder.join(", ")}`,
  `next: ${data.next}`,
  ...data.notes.map((note) => `note: ${note}`),
];

function check(argv: string[], io: Io): number {
  const flags = parseFlags(argv, { name: "value", base: "value", offline: "boolean" });
  if (typeof flags === "string") return usage(io, flags, CHECK_USAGE);
  const selected = selectFanout(io.cwd, flags.values.name ?? null, currentBranch(io.cwd));
  if (!selected.ok) return failed(io, selected);
  const result = checkFanout(io.cwd, selected.data, {
    only: flags.positionals,
    trunkRef: flags.values.base ?? null,
    forge: forgeFor(io, flags.booleans.has("offline")).forge,
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

const short = (sha: string | null): string => (sha ? sha.slice(0, 7) : "-");

const renderStatus = (data: StatusOutcome): string[] => {
  const counts = new Map<string, number>();
  for (const slice of data.slices) counts.set(slice.state, (counts.get(slice.state) ?? 0) + 1);
  return [
    `fanout ${data.name} on ${data.trunk}: ${[...counts].map(([state, count]) => `${count} ${state.replace("_", " ")}`).join(", ")} · forge ${data.forge.available ? "on" : "off"}`,
    ...data.slices.map((slice) => {
      const parts = [
        slice.branchExists ? short(slice.head) : "no branch",
        slice.lastCommitAt && slice.idleMinutes !== null ? `idle ${slice.idleMinutes} min` : null,
        slice.pr ? `PR #${slice.pr.number} ${slice.pr.state}` : null,
        slice.ci === "unknown" ? null : `CI ${slice.ci}`,
        `verdict ${slice.verdict.accepted ? "accepted" : slice.verdict.basis === "none" ? "missing" : slice.verdict.basis}`,
      ].filter(Boolean);
      const label = slice.state === "stuck" ? "STUCK" : slice.state.replace("_", " ");
      const detail = slice.landed
        ? `landed (${slice.landed.how}${slice.landed.pr ? ` #${slice.landed.pr}` : ""})`
        : parts.join(" · ");
      const why = slice.state === "landed" ? [] : [...slice.reasons, ...slice.notes];
      return `  ${label.padEnd(11)} ${slice.id} (${slice.branch}) ${detail}${why.length ? `\n      ${why.join("\n      ")}` : ""}`;
    }),
    `landing order: ${data.landingOrder.length ? data.landingOrder.join(", ") : "(none ready)"}`,
    ...(data.spawnable.length ? [`spawnable: ${data.spawnable.join(", ")}`] : []),
    `next: ${data.next}`,
    ...data.notes.map((note) => `note: ${note}`),
  ];
};

function status(argv: string[], io: Io): number {
  const flags = parseFlags(argv, { name: "value", "stuck-after": "value", offline: "boolean" });
  if (typeof flags === "string") return usage(io, flags, STATUS_USAGE);
  if (flags.positionals.length)
    return usage(io, `unexpected argument ${flags.positionals[0]}`, STATUS_USAGE);
  const raw = flags.values["stuck-after"];
  const stuckAfterMs = raw === undefined ? null : parseDuration(raw);
  if (stuckAfterMs === 0 || (raw !== undefined && stuckAfterMs === null))
    return usage(io, "--stuck-after takes a duration such as 30m, 45m or 2h", STATUS_USAGE);
  const selected = selectFanout(io.cwd, flags.values.name ?? null, currentBranch(io.cwd));
  if (!selected.ok) return failed(io, selected);
  const forge = forgeFor(io, flags.booleans.has("offline"));
  const result = fanoutStatus(io.cwd, selected.data, {
    forge: forge.forge,
    forgeError: forge.error,
    stuckAfterMs,
  });
  if (!result.ok) return failed(io, result);
  return emit(io, ok(result.data), renderStatus);
}

function worktree(argv: string[], io: Io): number {
  const [action, ...rest] = argv;
  const flags = parseFlags(rest, { name: "value", force: "boolean" });
  if (typeof flags === "string") return usage(io, flags, WORKTREE_USAGE);
  if (action !== "create" && action !== "release")
    return usage(
      io,
      action ? `unknown worktree action "${action}"` : "missing create or release",
      WORKTREE_USAGE,
    );
  if (flags.positionals.length !== 1)
    return usage(
      io,
      flags.positionals.length ? `unexpected argument ${flags.positionals[1]}` : "missing <slice>",
      WORKTREE_USAGE,
    );
  if (action === "create" && flags.booleans.has("force"))
    return usage(io, "--force applies to release only", WORKTREE_USAGE);
  const selected = selectFanout(io.cwd, flags.values.name ?? null, currentBranch(io.cwd));
  if (!selected.ok) return failed(io, selected);
  const actor = actorFromEnv(io.env);
  if (action === "create") {
    const result = createSliceWorktree(io.cwd, selected.data, {
      slice: flags.positionals[0],
      actor,
    });
    if (!result.ok) return failed(io, result);
    return emit(io, ok(result.data), (data: CreateOutcome) => [
      `${data.created ? "created" : "kept"} worktree for slice ${data.slice} (${data.mode}): ${data.path}`,
      `  branch ${data.branch} <- ${data.base} at ${short(data.head)}`,
      `  scratch ${data.scratch}  (put it in the worker brief: temp files go here)`,
      ...data.notes.map((note) => `note: ${note}`),
    ]);
  }
  const result = releaseSliceWorktree(io.cwd, selected.data, {
    slice: flags.positionals[0],
    force: flags.booleans.has("force"),
    actor,
  });
  if (!result.ok) {
    const code = failed(io, result);
    const dirty = result.data?.dirty;
    if (!io.json && Array.isArray(dirty))
      for (const line of dirty as string[]) io.stderr(`  ${line}\n`);
    return code;
  }
  return emit(io, ok(result.data), (data: ReleaseOutcome) => [
    data.removed
      ? `released slice ${data.slice}: removed ${data.path}${data.dirty.length ? ` (dropped ${data.dirty.length} uncommitted change${data.dirty.length === 1 ? "" : "s"}, recorded in the ledger)` : ""}; branch ${data.branch} kept`
      : `slice ${data.slice}: nothing released`,
    ...data.notes.map((note) => `note: ${note}`),
  ]);
}

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv.filter((arg) => arg !== "--json");
  if (sub === "plan") return plan(rest, io);
  if (sub === "brief") return brief(rest, io);
  if (sub === "check") return check(rest, io);
  if (sub === "status") return status(rest, io);
  if (sub === "worktree") return worktree(rest, io);
  return usage(
    io,
    sub && !sub.startsWith("-")
      ? `unknown fanout subcommand "${sub}"`
      : "missing fanout subcommand",
    USAGE,
  );
}
