// `workit fanout plan|brief|check|status|worktree` (G1-G5): flag parsing and
// rendering; the rules live in core fanout*.ts. The CLI never spawns agents.
//
//   workit fanout plan     <plan.json> [--name <n>] [--trunk <b> | --track <t>] [--take-lead]
//   workit fanout brief    <slice> [--name <n>] [--mode new|resume] [--attempt <n>] [--host <h>]
//   workit fanout check    [<slice>…] [--name <n>] [--base <ref>] [--offline]
//   workit fanout status   [--name <n>] [--stuck-after 30m] [--offline]
//   workit fanout worktree create <slice>… [--name <plan|plan.json>] [--branch <b> [--base <b>] [--tier <t>]]
//                                          [--deps install|link] [--install-timeout 5m]
//   workit fanout worktree release <slice> [--name <n>] [--force]
//
// `--name` (alias `--plan`) takes a plan's name or its file: a file is
// registered first (as `fanout plan` would), and a name no plan has that
// matches one file in `workit dir plans` registers that file.
import { progressFor } from "../progress";
import fs from "node:fs";
import path from "node:path";
import type { ResolvedForge } from "@workit-dev/core/src/forge/resolve";
import {
  BRIEF_HOSTS,
  briefHost,
  renderBrief,
  slicePointer,
  type BriefOutcome,
} from "@workit-dev/core/src/fanout-brief";
import {
  adhocPlan,
  isPlanPath,
  planFileMatches,
  locatePlanFile,
  planHolding,
  plansHolding,
  registeredPlanFor,
} from "@workit-dev/core/src/fanout-adhoc";
import { checkFanout, type CheckOutcome } from "@workit-dev/core/src/fanout-check";
import { fanoutStatus, type StatusOutcome } from "@workit-dev/core/src/fanout-status";
import {
  DEPENDENCY_CHOICES,
  createSliceWorktree,
  resolveDependencyOptions,
  releaseSliceWorktree,
  type CreateOutcome,
  type DependencyChoice,
  type ReleaseOutcome,
} from "@workit-dev/core/src/fanout-worktree";
import {
  isAdhocPlan,
  listFanouts,
  planFanout,
  selectFanout,
  TIERS,
  type FanoutError,
  type FanoutFile,
  type PlanOutcome,
} from "@workit-dev/core/src/fanout";
import { currentBranch } from "@workit-dev/core/src/git/rev";
import { actorFromEnv } from "@workit-dev/core/src/ledger";
import { emit, fail, ok, type Io } from "../output";
import { explainPlanProblems } from "./fanout-plan";
import { connect, parseDuration, parseFlags, releaseTrunk, usage } from "./forge-common";

const PLAN_USAGE =
  "workit fanout plan <plan.json> [--name <n>] [--trunk <b> | --track <t>] [--take-lead] [--json]";
const BRIEF_USAGE =
  "workit fanout brief <slice> [--name <n>] [--mode new|resume] [--attempt <n>] [--host <h>] [--json]";
const CHECK_USAGE =
  "workit fanout check [<slice>…] [--name <n>] [--base <ref>] [--offline] [--json]";
const STATUS_USAGE = "workit fanout status [--name <n>] [--stuck-after 30m] [--offline] [--json]";
const WORKTREE_USAGE =
  "workit fanout worktree create <slice>… [--name <plan|plan.json>] [--branch <b>] [--base <b>] [--tier <t>] [--deps install|link] [--install-timeout <duration>] | worktree release <slice> [--name <n>] [--force] [--json]";
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

/**
 * Register the plan file at `file` as `workit fanout plan <file> [--name]`
 * does; a failure is already emitted and returns its exit code.
 */
function registerPlan(
  io: Io,
  file: string,
  opts: { name: string | null; trunk: string | null; track: string | null; takeLead: boolean },
): { data: PlanOutcome } | { code: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return {
      code: usage(io, `cannot read ${file} as JSON: ${(error as Error).message}`, PLAN_USAGE),
    };
  }
  const trunk = resolveTrunk(io, raw, opts.trunk, opts.track);
  if ("code" in trunk) return trunk;
  const result = planFanout(io.cwd, {
    raw,
    // A plan file without a name is named after the file.
    name:
      opts.name ??
      (typeof raw === "object" &&
      raw !== null &&
      typeof (raw as { name?: unknown }).name === "string"
        ? null
        : path.basename(file, ".json")),
    trunk: trunk.trunk,
    actor: actorFromEnv(io.env),
    takeLead: opts.takeLead,
  });
  if (result.ok) return { data: result.data };
  const problems = result.data?.problems;
  if (result.data && Array.isArray(problems)) {
    const explained = explainPlanProblems(raw, problems);
    // The headline quotes the first problem: give it the same wording.
    const first = problems[0];
    if (typeof first === "string" && typeof explained[0] === "string")
      result.error = result.error.replace(first, explained[0]);
    result.data.problems = explained;
  }
  const code = failed(io, result);
  renderBlockedPlan(io, result);
  return { code };
}

/**
 * The plan a verb acts on: `--name` (the registry maps `--fanout` and
 * `--plan` onto it), else the one this branch or this lead session belongs
 * to (#641). A `--name` that is a plan file registers it first; a name no
 * plan has registers the one `workit dir plans` file that starts with it.
 * A failure is emitted here and returns its exit code.
 */
function pickFanout(io: Io, values: { name?: string }, slice?: string): FanoutFile | number {
  const select = (name: string | null): FanoutFile | number => {
    const selected = selectFanout(
      io.cwd,
      name,
      currentBranch(io.cwd),
      io.env.WORKIT_SESSION_ID?.trim() || null,
    );
    return selected.ok ? selected.data : failed(io, selected);
  };
  const name = values.name?.trim() || null;
  let file = name && isPlanPath(io.cwd, name) ? locatePlanFile(io.cwd, name) : null;
  if (name && !file) {
    const known = selectFanout(io.cwd, name, null, null);
    const matches = known.ok || known.code !== "not_found" ? [] : planFileMatches(io.cwd, name);
    if (matches.length !== 1) return select(name);
    file = matches[0];
  }
  if (!file) {
    // `brief <slice>`, `worktree release <slice>`: the one plan holding it.
    const holders = slice === undefined ? [] : plansHolding(io.cwd, slice);
    return holders.length === 1 ? holders[0] : select(null);
  }
  // A plan this file already registered is used as stored: re-registering
  // would reset a `--trunk` given at plan time or add a twin plan.
  let raw: unknown = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // registerPlan names the read error.
  }
  const stored = raw === null ? null : registeredPlanFor(io.cwd, raw, file);
  const fields = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const ids = Array.isArray(fields.slices)
    ? fields.slices.map((entry) => (entry as { id?: unknown } | null)?.id)
    : [];
  if (stored && ids.every((id) => stored.slices.some((one) => one.id === id))) return stored;
  // A file that grew slices re-registers under the stored name and trunk.
  const registered = registerPlan(io, file, {
    name: stored?.name ?? null,
    trunk: stored && typeof fields.trunk !== "string" ? stored.trunk : null,
    track: null,
    takeLead: false,
  });
  if ("code" in registered) return registered.code;
  if (!io.json) io.stderr(`workit: registered fanout ${registered.data.name} from ${file}\n`);
  return select(registered.data.name);
}

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
  const flags = parseFlags(argv, {
    name: "value",
    trunk: "value",
    track: "value",
    "take-lead": "boolean",
  });
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
  const registered = registerPlan(io, path.resolve(io.cwd, flags.positionals[0]), {
    name: flags.values.name ?? null,
    trunk: flags.values.trunk ?? null,
    track,
    takeLead: flags.booleans.has("take-lead"),
  });
  if ("code" in registered) return registered.code;
  const result = { data: registered.data };
  // Another active plan makes a bare `ledger standing add` ambiguous (#775).
  const rivals = selectFanout(io.cwd, null, null, null);
  const others =
    !rivals.ok && Array.isArray(rivals.data?.candidates)
      ? rivals.data.candidates.map(String).filter((name) => name !== result.data.name)
      : [];
  if (others.length)
    result.data.notes.push(
      `other active plans (${others.join(", ")}): add a standing order for this one with workit ledger standing add "<order>" --fanout ${result.data.name}`,
    );
  return emit(io, ok(result.data), (data: PlanOutcome) => [
    `${data.created ? "planned" : "re-planned"} fanout ${data.name} on ${data.trunk}${data.fanIn === "integration" ? " (integration branch: one PR)" : ""}: ${data.slices.length} slice${data.slices.length === 1 ? "" : "s"}`,
    ...data.slices.map(
      (slice) =>
        `  ${slice.id} [${slice.tier}] ${slice.branch} <- ${slice.base}${slice.dependsOn.length ? `  after ${slice.dependsOn.join(", ")}` : ""}\n      worktree ${slice.worktree}`,
    ),
    ...data.overlaps.map(
      (overlap) =>
        `  shared ${overlap.path}: ${
          overlap.resolution === "owner"
            ? `owned by ${overlap.owner}`
            : overlap.resolution === "regenerated"
              ? `regenerated at fan-in (${overlap.writer})`
              : `serialized (${overlap.slices.join(" -> ")})`
        }`,
    ),
    `waves: ${data.waves.map((wave) => wave.join(", ")).join("  |  ")}`,
    `landing order: ${data.landingOrder.join(", ")}`,
    ...data.notes.map((note) => `note: ${note}`),
    ...data.warnings.map((warning) => `warning: ${warning}`),
  ]);
}

function brief(argv: string[], io: Io): number {
  const flags = parseFlags(argv, {
    name: "value",
    mode: "value",
    attempt: "value",
    host: "value",
  });
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
  const hosts = BRIEF_HOSTS.join(", ");
  const asked = flags.values.host;
  const host = asked === undefined ? null : briefHost(asked);
  if (asked !== undefined && !host)
    return usage(io, `--host takes one of ${hosts} (got ${asked})`, BRIEF_USAGE);
  const actor = actorFromEnv(io.env);
  // Without --host the brief follows the lead's host; a missing, `cli` or
  // misspelled one silently renders the plain-terminal identity and no
  // model or trailer, so say so.
  if (!host && !briefHost(actor.host))
    io.stderr(
      `workit: warning: no known host for this brief (WORKIT_HOST is ${io.env.WORKIT_HOST?.trim() || "unset"}): it renders a plain-terminal worker; pass --host <${hosts}> for the worker's host\n`,
    );
  const selected = pickFanout(io, flags.values, flags.positionals[0]);
  if (typeof selected === "number") return selected;
  const result = renderBrief(io.cwd, selected, {
    slice: flags.positionals[0],
    mode,
    attempt,
    actor,
    host,
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
  const selected = pickFanout(io, flags.values);
  if (typeof selected === "number") return selected;
  const result = progressFor(io).runSync(
    "Checking the fan-out slices",
    () =>
      checkFanout(io.cwd, selected, {
        only: flags.positionals,
        trunkRef: flags.values.base ?? null,
        forge: forgeFor(io, flags.booleans.has("offline")).forge,
      }),
    (r) => (r.ok ? "done" : "failed"),
  );
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
    ...data.stacks.map(
      (stack) => `stack ${stack.name ?? "(not recorded yet)"}: ${stack.slices.join(" -> ")}`,
    ),
    `landing order: ${data.landingOrder.length ? data.landingOrder.join(", ") : "(none ready)"}`,
    ...(data.spawnable.length ? [`spawnable: ${data.spawnable.join(", ")}`] : []),
    `next: ${data.next}`,
    ...data.notes.map((note) => `note: ${note}`),
  ];
};

function status(argv: string[], io: Io): number {
  const flags = parseFlags(argv, { name: "value", "stuck-after": "value", offline: "boolean" });
  if (typeof flags === "string") return usage(io, flags, STATUS_USAGE);
  // `fanout status <plan>`: one positional is the plan's name (or file).
  if (flags.positionals.length > (flags.values.name === undefined ? 1 : 0))
    return usage(io, `unexpected argument ${flags.positionals.at(-1)}`, STATUS_USAGE);
  if (flags.positionals.length === 1) flags.values.name = flags.positionals[0];
  const raw = flags.values["stuck-after"];
  const stuckAfterMs = raw === undefined ? null : parseDuration(raw);
  if (stuckAfterMs === 0 || (raw !== undefined && stuckAfterMs === null))
    return usage(io, "--stuck-after takes a duration such as 30m, 45m or 2h", STATUS_USAGE);
  // A read-only query: no plan recorded is an answer, not an error.
  const all = flags.values.name === undefined ? listFanouts(io.cwd) : null;
  if (all?.ok && all.data.length === 0)
    return emit(io, ok({ plans: [] }), () => [
      "no fanout plan is recorded here (plan one: workit fanout plan <plan.json>)",
    ]);
  const selected = pickFanout(io, flags.values);
  if (typeof selected === "number") return selected;
  const forge = forgeFor(io, flags.booleans.has("offline"));
  const result = progressFor(io).runSync(
    "Reading the fan-out status",
    () =>
      fanoutStatus(io.cwd, selected, {
        forge: forge.forge,
        forgeError: forge.error,
        stuckAfterMs,
      }),
    (r) => (r.ok ? "done" : "failed"),
  );
  if (!result.ok) return failed(io, result);
  return emit(io, ok(result.data), renderStatus);
}

type MadeSlice = CreateOutcome & { prompt: string; spawn: string };

/** How the worktree got node_modules, in one line; LINKED stands out because it can drift. */
const depsLine = (data: MadeSlice): string[] => {
  const { mode, from, command, fallback } = data.deps;
  if (mode === "installed") return [`  deps own install${command ? ` (${command})` : ""}`];
  if (mode === "linked")
    return [
      `  deps LINKED from ${from ?? "the main checkout"}${fallback ? ` (${fallback})` : ""}: shared packages can drift from this worktree's lockfile`,
    ];
  return command ? [`  deps none: run ${data.install ?? command} first`] : [];
};

/** One made slice: what `create` did, then its WORKTREE line and the spawn that carries it. */
const renderMade = (data: MadeSlice): string[] => [
  `${data.created ? "created" : "kept"} worktree for slice ${data.slice} (${data.mode}): ${data.path}`,
  `  branch ${data.branch} <- ${data.base} at ${short(data.head)}`,
  ...depsLine(data),
  ...(data.stack ? [`  stack ${data.stack.name}: ${data.stack.slices.join(" -> ")}`] : []),
  `  scratch ${data.scratch}  (put it in the worker brief: temp files go here)`,
  ...data.notes.map((note) => `note: ${note}`),
  `WORKTREE: ${data.path}`,
  data.spawn,
];

const findSliceMissing = (fanout: string, slice: string): FanoutError => ({
  ok: false,
  code: "invalid_input",
  error: `${slice}: not a slice of fanout ${fanout}`,
});

/**
 * `worktree create <slice>…`: each slice's worktree from the plan (`--name`
 * names it or its file), or one unplanned slice (`--branch`, or a slice no
 * registered plan holds) through a one-slice plan (fanout-adhoc.ts). Stops at the first slice that fails,
 * after printing the ones made.
 */
function createWorktrees(io: Io, slices: string[], flags: Record<string, string>): number {
  const branch = flags.branch?.trim() || null;
  // One slice, no plan named, none holding it and no real plan this checkout
  // would pick (so a typo in a planned slice stays an error): an unplanned
  // slice on its default branch, as with --branch (the call agents make first).
  const picked =
    branch === null && flags.name === undefined && slices.length === 1
      ? selectFanout(io.cwd, null, currentBranch(io.cwd), io.env.WORKIT_SESSION_ID?.trim() || null)
      : null;
  const unplanned =
    picked !== null &&
    planHolding(io.cwd, slices[0]) === null &&
    // Only "no plan here" makes an unplanned slice; an ambiguous pick stays an error.
    (picked.ok ? isAdhocPlan(picked.data) : picked.code === "not_found");
  if (branch === null && !unplanned && (flags.base !== undefined || flags.tier !== undefined))
    return usage(io, "--base and --tier go with an unplanned slice (--branch <b>)", WORKTREE_USAGE);
  if (branch !== null && slices.length !== 1)
    return usage(
      io,
      "--branch makes one unplanned slice; plan two or more in a plan file",
      WORKTREE_USAGE,
    );
  if (branch !== null && flags.name !== undefined)
    return usage(io, "pass --name <plan> or --branch <b>, not both", WORKTREE_USAGE);
  if (flags.tier !== undefined && !(TIERS as readonly string[]).includes(flags.tier))
    return usage(io, `--tier takes one of ${TIERS.join(", ")} (got ${flags.tier})`, WORKTREE_USAGE);
  if (flags.deps !== undefined && !(DEPENDENCY_CHOICES as readonly string[]).includes(flags.deps))
    return usage(
      io,
      `--deps takes ${DEPENDENCY_CHOICES.join(" or ")} (got ${flags.deps})`,
      WORKTREE_USAGE,
    );
  const timeoutMs =
    flags["install-timeout"] === undefined ? undefined : parseDuration(flags["install-timeout"]);
  if (timeoutMs === null || timeoutMs === 0)
    return usage(io, "--install-timeout takes a duration such as 90s or 5m", WORKTREE_USAGE);
  // The flags win over the workspace's fanout.deps and fanout.installTimeout.
  const resolved = resolveDependencyOptions(
    io.cwd,
    { choice: flags.deps as DependencyChoice | undefined, timeoutMs },
    io.env,
  );
  if (!resolved.ok) return usage(io, resolved.error, WORKTREE_USAGE);
  const dependencies = resolved.options;
  const actor = actorFromEnv(io.env);
  let chosen: FanoutFile | number;
  if (branch === null && !unplanned) chosen = pickFanout(io, flags);
  else {
    const adhoc = adhocPlan(io.cwd, {
      slice: slices[0],
      branch,
      base: flags.base?.trim() || null,
      tier: flags.tier ?? null,
      actor,
    });
    chosen = adhoc.ok ? adhoc.data : failed(io, adhoc);
  }
  if (typeof chosen === "number") return chosen;
  const made: MadeSlice[] = [];
  const byId = new Map(chosen.slices.map((one) => [one.id, one]));
  for (const slice of slices) {
    const result = createSliceWorktree(io.cwd, chosen, {
      slice,
      actor,
      forge: () => forgeFor(io, false).forge,
      dependencies,
    });
    if (!result.ok) {
      if (!io.json) for (const line of made.flatMap(renderMade)) io.stdout(`${line}\n`);
      return failed(io, result);
    }
    const found = byId.get(slice);
    if (!found) return failed(io, findSliceMissing(chosen.name, slice));
    made.push({
      ...result.data,
      notes: [...resolved.notes, ...result.data.notes],
      ...slicePointer(io.cwd, chosen, found, result.data.path, actor.host),
    });
  }
  return made.length === 1
    ? emit(io, ok(made[0]), renderMade)
    : emit(io, ok({ worktrees: made }), (data: { worktrees: MadeSlice[] }) =>
        data.worktrees.flatMap(renderMade),
      );
}

async function worktree(argv: string[], io: Io): Promise<number> {
  const [action, ...rest] = argv;
  const flags = parseFlags(rest, {
    name: "value",
    force: "boolean",
    branch: "value",
    base: "value",
    tier: "value",
    deps: "value",
    "install-timeout": "value",
  });
  if (typeof flags === "string") return usage(io, flags, WORKTREE_USAGE);
  if (action !== "create" && action !== "release")
    return usage(
      io,
      action ? `unknown worktree action "${action}"` : "missing create or release",
      WORKTREE_USAGE,
    );
  if (flags.positionals.length === 0) return usage(io, "missing <slice>", WORKTREE_USAGE);
  if (action === "create") {
    if (flags.booleans.has("force"))
      return usage(io, "--force applies to release only", WORKTREE_USAGE);
    return createWorktrees(io, [...new Set(flags.positionals)], flags.values);
  }
  if (flags.positionals.length !== 1)
    return usage(io, `unexpected argument ${flags.positionals[1]}`, WORKTREE_USAGE);
  for (const only of ["branch", "base", "tier", "deps", "install-timeout"])
    if (flags.values[only] !== undefined)
      return usage(io, `--${only} applies to create only`, WORKTREE_USAGE);
  const selected = pickFanout(io, flags.values, flags.positionals[0]);
  if (typeof selected === "number") return selected;
  const actor = actorFromEnv(io.env);
  const result = await releaseSliceWorktree(io.cwd, selected, {
    slice: flags.positionals[0],
    force: flags.booleans.has("force"),
    actor,
    env: io.env,
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
    ...data.scratch.map((dir) => `  removed scratch ${dir}`),
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
