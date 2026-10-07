// Implicit-task verbs (design §4.1, D3): the current branch (detached HEAD:
// the worktree; outside git: the directory) is one task, created by its first
// recording. No ids to manage.
//
//   workit task status [--all] [--json]
//   workit task start "<objective>"                 # idempotent per branch
//   workit task note "<text>" [--next "<t>"] [--objective "<t>"]
//   workit task close [--outcome verified|limited|stopped] [--summary "<t>"] [--confirm]
//   workit task adopt <id>                          # bind a migrated/other task to this branch
//
// The `workit task <action> --payload …` family grammar keeps working; these
// forms are routed here by verbs/family.ts.
import { checkRoot } from "@brainervirus/workit-core/src/check-config";
import { emit, fail, ok, type EnvelopeCode, type Io } from "../output";
import { runTaskCommand } from "../task";
import { hostSessionFromEnv } from "@brainervirus/workit-core/src/host-session";

const USAGE =
  'workit task status [--all] | task start "<objective>" | task note "<text>" [--next "<t>"] [--objective "<t>"] | task close [--outcome verified|limited|stopped] [--summary "<t>"] [--confirm] | task adopt <id>';

const IMPLICIT = new Set(["status", "note", "adopt"]);

/** Whether `argv` (after `task`) is an implicit-task form rather than the family grammar. */
export function isImplicitTaskForm(argv: readonly string[]): boolean {
  const [action, first] = argv;
  if (!action) return false;
  if (IMPLICIT.has(action)) return true;
  if (action === "start") return first !== undefined && !first.startsWith("--");
  if (action === "close") return !argv.includes("--task") && !argv.includes("--payload");
  return false;
}

type Flags = { positionals: string[]; values: Map<string, string>; switches: Set<string> };

const VALUE_FLAGS = new Set(["--next", "--objective", "--outcome", "--summary"]);
const SWITCHES = new Set(["--all", "--json", "--confirm"]);

function parse(argv: readonly string[]): Flags | Error {
  const flags: Flags = { positionals: [], values: new Map(), switches: new Set() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? arg.split(/=(.*)/su) : [arg];
    if (SWITCHES.has(flag)) {
      flags.switches.add(flag);
      continue;
    }
    if (VALUE_FLAGS.has(flag)) {
      const value = inline ?? argv[++index];
      if (value === undefined || (inline === undefined && value.startsWith("--")))
        return new Error(`${flag} requires a value`);
      flags.values.set(flag, value);
      continue;
    }
    if (arg.startsWith("--")) return new Error(`unknown option ${arg}`);
    flags.positionals.push(arg);
  }
  return flags;
}

const ENGINE_CODES: Record<string, Exclude<EnvelopeCode, "ok">> = {
  busy: "busy",
  not_found: "not_found",
  invalid_input: "invalid_input",
  invalid_transition: "blocked",
  permission_denied: "blocked",
  requirements_unsatisfied: "blocked",
  needs_input: "blocked",
};
const engineFailure = (io: Io, result: { code: string; error: string }, unblock?: string) =>
  emit(
    io,
    fail(ENGINE_CODES[result.code] ?? "failed", `${result.code}: ${result.error}`, {
      data: { code: result.code },
      ...(unblock
        ? { unblock }
        : result.code === "busy"
          ? { unblock: "retry the same command" }
          : {}),
    }),
  );

const OUTCOMES: Record<string, "verified" | "accepted_limitations" | "stopped"> = {
  verified: "verified",
  limited: "accepted_limitations",
  accepted_limitations: "accepted_limitations",
  stopped: "stopped",
};

/** The checkout root implicit tasks are kept for: the workspace root, else the worktree top. */
const rootFor = (io: Io): string => io.env.WORKFLOW_WORKSPACE_ROOT || checkRoot(io.cwd);

export async function run(argv: string[], io: Io): Promise<number> {
  const [action, ...rest] = argv;
  const flags = parse(rest);
  if (flags instanceof Error)
    return emit(io, fail("invalid_input", flags.message, { unblock: USAGE }));
  // The engine pulls zod; load it only for these verbs.
  const { TaskStore, WorkitCore } = await import("@brainervirus/workit-core/src/core");
  const root = rootFor(io);
  const store = new TaskStore(root);
  const actor = hostSessionFromEnv(io.env).session ?? "cli";
  const context = {
    root: store.root,
    caller: { host: "workit_cli" as const, actor },
    provenanceKind: "agent_reported" as const,
    capabilities: [],
    constraints: [],
    now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  const core = new WorkitCore(store, context);
  const provenance = {
    kind: "agent_reported" as const,
    host: "workit_cli" as const,
    session: { kind: "host" as const, host: "workit_cli" as const, handle: actor },
    workerId: null,
  };
  const key = store.currentKey();
  if (!key.ok) return emit(io, fail("unavailable", key.error));
  const where = key.data.branch ? `branch ${key.data.branch}` : key.data.key;

  if (action === "status") {
    if (flags.switches.has("--all")) {
      const all = store.listStoreIndex();
      if (!all.ok) return engineFailure(io, all);
      const tasks = all.data
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((entry) => ({
          id: entry.id,
          status: entry.status,
          key: entry.key,
          legacy: entry.legacy,
          objective: entry.objective,
          updatedAt: entry.updatedAt,
          progress: entry.progress,
          current: entry.key === key.data.key && entry.status !== "closed",
        }));
      return emit(io, ok({ key: key.data, tasks }), (data) =>
        data.tasks.length
          ? data.tasks.map(
              (task) =>
                `${task.current ? "*" : " "} ${task.id} ${task.status}${task.key ? ` [${task.key}]` : task.legacy ? " [2.x; adopt with workit task adopt <id>]" : ""} — ${task.objective}`,
            )
          : ["no tasks in this store"],
      );
    }
    const found = store.implicitTask({ provenance, create: false });
    if (!found.ok) return engineFailure(io, found);
    // Duplicates bound to this key (the oldest is used), each with the exact
    // command that settles it. (A task follows its branch through
    // `git branch -m` by itself.)
    const report = store.keyReport();
    const notes: Array<{ id: string; kind: "duplicate"; key: string | null; hint: string }> = [];
    if (report.ok)
      for (const entry of report.data.bound.slice(1))
        notes.push({
          id: entry.id,
          kind: "duplicate",
          key: entry.key,
          hint: `workit task close --task ${entry.id} --payload '{"outcome":"stopped","summary":"duplicate"}' --confirm`,
        });
    const noteLines = notes.map(
      (note) => `duplicate open task ${note.id} on ${note.key} (not used); close it: ${note.hint}`,
    );
    if (!found.data)
      return emit(io, ok({ key: key.data, task: null, notes }), () => [
        `no task for ${where} yet; it is created by the first note, check or recording (or: workit task start "<objective>")`,
        ...noteLines,
      ]);
    const summary = core.task({
      schemaVersion: 1,
      action: "inspect",
      taskId: found.data.task.id,
      view: "summary",
    });
    if (!summary.ok) return engineFailure(io, summary);
    const task = found.data.task;
    return emit(io, ok({ key: key.data, task: summary.data, notes }), () => [
      `${task.id} ${task.status} — ${task.intent.data.objective} (${where})`,
      ...(task.progress.summary ? [`progress: ${task.progress.summary}`] : []),
      ...(task.progress.nextAction ? [`next: ${task.progress.nextAction}`] : []),
      `evidence ${task.evidence.length} · findings ${task.findings.filter((item) => item.data.disposition === "open").length} open · decisions ${task.decisions.length}`,
      ...noteLines,
    ]);
  }

  if (action === "start" || action === "note") {
    const text = flags.positionals.join(" ").trim();
    if (!text)
      return emit(
        io,
        fail(
          "invalid_input",
          `task ${action} needs ${action === "start" ? "an objective" : "a note"}`,
          {
            unblock: USAGE,
          },
        ),
      );
    const objective = action === "start" ? text : (flags.values.get("--objective") ?? undefined);
    const found = store.implicitTask({ provenance, objective, create: true });
    if (!found.ok) return engineFailure(io, found);
    let task = found.data!.task;
    if (!found.data!.created && objective && objective !== task.intent.data.objective) {
      const revised = core.task({
        schemaVersion: 1,
        action: "revise",
        taskId: task.id,
        intent: { ...task.intent.data, objective },
        reason: "objective updated",
      });
      if (!revised.ok) return engineFailure(io, revised);
    }
    if (action === "note") {
      const current = store.readTask(task.id);
      if (!current.ok) return engineFailure(io, current);
      const progressed = core.task({
        schemaVersion: 1,
        action: "progress",
        taskId: task.id,
        progress: {
          summary: text,
          nextAction: flags.values.get("--next") ?? current.data.progress.nextAction,
          blockers: current.data.progress.blockers,
        },
      });
      if (!progressed.ok) return engineFailure(io, progressed);
    }
    const latest = store.readTask(task.id);
    if (latest.ok) task = latest.data;
    return emit(
      io,
      ok({
        key: key.data,
        created: found.data!.created,
        task: {
          id: task.id,
          status: task.status,
          objective: task.intent.data.objective,
          progress: task.progress,
        },
      }),
      (data) =>
        `${data.created ? "started" : action === "start" ? "already tracking" : "noted on"} ${task.id} — ${task.intent.data.objective} (${where})`,
    );
  }

  if (action === "close") {
    const outcomeFlag = flags.values.get("--outcome") ?? "verified";
    const outcome = OUTCOMES[outcomeFlag];
    if (!outcome)
      return emit(
        io,
        fail("invalid_input", "--outcome is verified, limited or stopped", { unblock: USAGE }),
      );
    const found = store.implicitTask({ provenance, create: false });
    if (!found.ok) return engineFailure(io, found);
    if (!found.data) return emit(io, fail("not_found", `no open task for ${where}`));
    const task = found.data.task;
    const summary =
      flags.values.get("--summary") ?? (task.progress.summary || `closed (${outcomeFlag})`);
    return runTaskCommand(
      [
        "task",
        "close",
        "--task",
        task.id,
        "--payload",
        JSON.stringify({ outcome, summary }),
        ...(flags.switches.has("--confirm") ? ["--confirm"] : []),
        ...(io.json ? ["--json"] : []),
      ],
      { root: store.root },
    );
  }

  if (action === "adopt") {
    const [id] = flags.positionals;
    if (!id || flags.positionals.length !== 1)
      return emit(io, fail("invalid_input", "task adopt takes one task id", { unblock: USAGE }));
    const adopted = store.adoptTask(id);
    if (!adopted.ok) return engineFailure(io, adopted, "workit task status --all");
    return emit(
      io,
      ok({ key: key.data, task: { id: adopted.data.id, status: adopted.data.status } }),
      () => `${adopted.data.id} now tracks ${where}`,
    );
  }

  return emit(io, fail("invalid_input", `unknown task action ${action ?? ""}`, { unblock: USAGE }));
}
