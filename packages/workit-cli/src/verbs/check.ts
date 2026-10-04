// `workit check` (design §2.1 S9, §2.2; D5, D14, D18): run a command and
// record what the CLI itself observed.
//
//   workit check <name> [--timeout <s>] [--task <id>] [--json]          # the configured command
//   workit check [--name <n>] [--shell] [--timeout <s>] [--task <id>] [--json] -- <cmd…>
//
// - The command runs without a shell (with --shell, pass one command string);
//   its output streams through (to stderr under --json, so stdout stays one
//   envelope) while a bounded, redacted copy goes to the log blob.
// - The run is keyed to the code (HEAD, worktree tree key, base + patch-id)
//   and recorded as `observer:"workit_cli"` evidence: always in the ledger
//   (`type:"check"`), and in the current task when there is one (--task, the
//   writer's task, or the only active task). Attestation stays null until a
//   host hook attests the run.
// - It is *configured* only when the name is in the check config
//   (workit.checks.json, else detected ecosystem defaults) and argv is exactly
//   that name's command, run from the repo top; --shell runs never are. Only
//   configured runs satisfy gates; `workit check -- true` never does.
// - The tree key is taken before and after the run: a command that changed
//   the worktree leaves stale evidence (`modifiedWorktree`).
// - Exit code: the command's own (4 on --timeout, 2 on usage). When the
//   command passed but the evidence could not be recorded, the recording
//   error's code (busy 4, unavailable 5) so a green run is never mistaken for
//   recorded evidence.
import fs from "node:fs";
import path from "node:path";
import {
  CHECKS_FILE,
  checkCommand,
  checkRoot,
  gateCheckNames,
  loadCheckConfig,
  matchesNamedCheck,
  type CheckConfig,
} from "@brainervirus/workit-core/src/check-config";
import {
  TAIL_LINES,
  redactLog,
  runCheckCommand,
  storeLog,
  tailLines,
} from "@brainervirus/workit-core/src/checks";
import { worktreeSignal, worktreeTree } from "@brainervirus/workit-core/src/git/rev";
import pkg from "../../package.json" with { type: "json" };
import {
  MAX_LINE_BYTES,
  actorFromEnv,
  appendObserved,
  codeKey,
  storeRoot,
  type CodeKey,
} from "@brainervirus/workit-core/src/ledger";
import { emit, fail, type EnvelopeCode, type Io } from "../output";

const USAGE =
  "workit check <name> | workit check [--name <n>] [--shell] [--timeout <s>] [--task <id>] [--json] -- <cmd…>";
/** Tail lines kept on the task record (the envelope carries TAIL_LINES). */
const RECORD_TAIL_LINES = 20;
const RECORD_TAIL_CHARS = 200;

type Options = {
  name: string | null;
  shell: boolean;
  timeoutMs: number;
  task: string | null;
  base: string | null;
  positionals: string[];
  command: string[] | null;
};

function parse(argv: readonly string[]): Options | Error {
  const split = argv.indexOf("--");
  const head = split >= 0 ? argv.slice(0, split) : [...argv];
  const options: Options = {
    name: null,
    shell: false,
    timeoutMs: 0,
    task: null,
    base: null,
    positionals: [],
    command: split >= 0 ? argv.slice(split + 1) : null,
  };
  for (let index = 0; index < head.length; index += 1) {
    const arg = head[index];
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? arg.split(/=(.*)/su) : [arg];
    const value = (): string | Error => {
      const next = inline ?? head[++index];
      return next === undefined || (inline === undefined && next.startsWith("--"))
        ? new Error(`${flag} requires a value`)
        : next;
    };
    if (flag === "--json") continue;
    if (flag === "--shell") {
      options.shell = true;
      continue;
    }
    if (flag === "--name" || flag === "--task" || flag === "--base" || flag === "--timeout") {
      const got = value();
      if (got instanceof Error) return got;
      if (flag === "--name") options.name = got;
      else if (flag === "--task") options.task = got;
      else if (flag === "--base") options.base = got;
      else {
        const seconds = Number(got);
        if (!Number.isFinite(seconds) || seconds <= 0)
          return new Error("--timeout must be a positive number of seconds");
        options.timeoutMs = Math.round(seconds * 1000);
      }
      continue;
    }
    if (arg.startsWith("-")) return new Error(`unknown option ${arg}`);
    options.positionals.push(arg);
  }
  return options;
}

const posix = (value: string): string => value.split(path.sep).join("/") || ".";

/** The task store root: WORKFLOW_WORKSPACE_ROOT, else the nearest `.workit/workspace.json` up to the repo top. */
function taskStoreRoot(io: Io, top: string): string | null {
  const explicit = io.env.WORKFLOW_WORKSPACE_ROOT;
  if (explicit)
    return fs.existsSync(path.join(explicit, ".workit", "workspace.json")) ? explicit : null;
  let dir = io.cwd;
  for (;;) {
    if (fs.existsSync(path.join(dir, ".workit", "workspace.json"))) return dir;
    const parent = path.dirname(dir);
    if (dir === top || parent === dir) return null;
    dir = parent;
  }
}

type TaskOutcome = {
  task: { id: string; created: false } | null;
  note: string | null;
  evidenceId: string | null;
  satisfies: string[];
  stillUnsatisfied: Array<{ requirement: string; ruleId: string; reason: string; unblock: string }>;
  error: { code: EnvelopeCode; message: string } | null;
};

const ENGINE_CODES: Record<string, EnvelopeCode> = {
  busy: "busy",
  not_found: "not_found",
  invalid_input: "invalid_input",
  permission_denied: "blocked",
};

async function recordInTask(
  io: Io,
  storeDir: string,
  requested: string | null,
  observation: Record<string, unknown>,
  unblockFor: (dimension: string) => string,
): Promise<TaskOutcome> {
  const empty: TaskOutcome = {
    task: null,
    note: null,
    evidenceId: null,
    satisfies: [],
    stillUnsatisfied: [],
    error: null,
  };
  // The engine pulls zod; load it only when a task store exists.
  const { TaskStore, WorkitCore } = await import("@brainervirus/workit-core/src/core");
  const store = new TaskStore(storeDir);
  let taskId = requested;
  if (!taskId) {
    const workspace = store.readWorkspace();
    const index = store.listTaskIndex();
    if (!workspace.ok || !index.ok) {
      const failed = !workspace.ok ? workspace : (index as Extract<typeof index, { ok: false }>);
      return {
        ...empty,
        note: "the task store is unreadable; recorded to the ledger only",
        error: { code: "unavailable", message: `task store: ${failed.code}: ${failed.error}` },
      };
    }
    const active = index.data.filter((entry) => entry.status === "active");
    const writerTask = workspace.data?.writer?.owner.taskId ?? null;
    const owned = active.find((entry) => entry.id === writerTask);
    if (owned) taskId = owned.id;
    else if (active.length === 1) taskId = active[0].id;
    else
      return {
        ...empty,
        note: active.length
          ? `${active.length} active tasks and none holds the writer; pass --task <id> to attach the evidence (recorded to the ledger only)`
          : "no active task; recorded to the ledger only",
      };
  }
  const core = new WorkitCore(store, {
    root: store.root,
    caller: { host: "workit_cli", actor: io.env.WORKIT_SESSION_ID?.trim() || "cli" },
    provenanceKind: "host_observed",
    capabilities: [],
    constraints: [],
    now: () => new Date().toISOString(),
  });
  const recorded = core.observeCheck({
    taskId,
    observation: observation as Parameters<typeof core.observeCheck>[0]["observation"],
  });
  if (!recorded.ok)
    return {
      ...empty,
      task: { id: taskId, created: false },
      error: {
        code: ENGINE_CODES[recorded.code] ?? "unavailable",
        message: `${recorded.code}: ${recorded.error}`,
      },
    };
  const outcome: TaskOutcome = {
    ...empty,
    task: { id: taskId, created: false },
    evidenceId: recorded.data.id,
  };
  const view = core.task({ schemaVersion: 1, action: "inspect", taskId, view: "summary" });
  const task = store.readTask(taskId);
  if (!view.ok || !task.ok) return outcome;
  const requirements = (view.data as { requirements?: unknown }).requirements;
  if (!Array.isArray(requirements)) return outcome;
  for (const item of requirements as Array<{
    requirementId: string;
    status: string;
    evidenceIds: string[];
    reason: string;
  }>) {
    const requirement = task.data.policy?.requirements.find(
      (entry) => entry.id === item.requirementId,
    );
    if (!requirement) continue;
    if (item.status === "satisfied" && item.evidenceIds.includes(recorded.data.id))
      outcome.satisfies.push(requirement.id);
    else if (
      (item.status === "unsatisfied" || item.status === "unavailable") &&
      (requirement.dimension === "testing" || requirement.dimension === "verification") &&
      requirement.before === "close"
    )
      outcome.stillUnsatisfied.push({
        requirement: requirement.id,
        ruleId: requirement.ruleId,
        reason: item.reason,
        unblock: unblockFor(requirement.dimension),
      });
  }
  return outcome;
}

/** Environment variables that change how checks run; recorded by name and value. */
const FINGERPRINT_VARS = ["CI", "NODE_ENV", "npm_config_script_shell", "NODE_OPTIONS", "SHELL"];

/** A minimal environment fingerprint for the observation (values redacted, bounded). */
function environmentFingerprint(env: NodeJS.ProcessEnv) {
  const vars: Record<string, string | null> = {};
  for (const name of FINGERPRINT_VARS) {
    const value = env[name];
    vars[name] = value === undefined ? null : redactLog(value).slice(0, 200);
  }
  return { platform: process.platform, arch: process.arch, vars };
}

/** A ledger row stays under MAX_LINE_BYTES: long argv entries are cut. */
function boundedArgv(argv: readonly string[]): { argv: string[]; truncated: boolean } {
  let cut = argv.map((item) => (item.length > 200 ? `${item.slice(0, 200)}…` : item));
  if (cut.length > 24) cut = [...cut.slice(0, 24), `… ${argv.length - 24} more`];
  const truncated = cut.length !== argv.length || cut.some((item, index) => item !== argv[index]);
  return { argv: cut, truncated };
}

export async function run(argv: string[], io: Io): Promise<number> {
  const options = parse(argv);
  if (options instanceof Error)
    return emit(io, fail("invalid_input", options.message, { unblock: USAGE }));
  const config: CheckConfig = loadCheckConfig(io.cwd);
  const top = checkRoot(io.cwd);
  let command: string[];
  let runCwd = io.cwd;
  let name = options.name;
  if (options.command === null) {
    // `workit check <name>`: the configured command, from the repo top.
    if (options.positionals.length !== 1 || options.name || options.shell)
      return emit(
        io,
        fail("invalid_input", "pass a check name, or a command after --", { unblock: USAGE }),
      );
    name = options.positionals[0];
    if (config.error)
      return emit(io, fail("invalid_input", `check config is invalid: ${config.error}`));
    const check = config.checks.find((item) => item.name === name);
    if (!check)
      return emit(
        io,
        fail("not_found", `no configured check named "${name}"`, {
          data: { configured: config.checks.map((item) => item.name), source: config.source },
          unblock: config.checks.length
            ? `workit check ${config.checks.map((item) => item.name).join("|")}`
            : `add {"checks":{"${name}":"<command>"}} to workit.checks.json, or run workit check --name ${name} -- <cmd…>`,
        }),
      );
    command = check.argv;
    runCwd = config.root;
  } else {
    if (options.positionals.length)
      return emit(
        io,
        fail("invalid_input", `unexpected argument ${options.positionals[0]} before --`, {
          unblock: USAGE,
        }),
      );
    command = options.command;
    if (!command.length)
      return emit(io, fail("invalid_input", "no command after --", { unblock: USAGE }));
    if (options.shell && command.length !== 1)
      return emit(
        io,
        fail(
          "invalid_input",
          '--shell takes the command as one string: workit check --shell -- "<cmd>"',
        ),
      );
  }
  const relCwd = posix(path.relative(top, runCwd));
  const configured = !options.shell && matchesNamedCheck(config, name, command, relCwd);
  const actor = actorFromEnv(io.env);
  const branchKey: CodeKey = codeKey(io.cwd, { base: options.base });
  // codeKey keys the tree only on a checked-out branch; a detached HEAD is
  // still a worktree whose state the run observed.
  const detached = branchKey.tree === null ? worktreeTree(io.cwd) : null;
  const key: CodeKey = detached
    ? { ...branchKey, tree: detached.key, dirty: detached.dirty }
    : branchKey;
  const signal = key.tree === null ? null : worktreeSignal(io.cwd);

  const result = await runCheckCommand(command, {
    cwd: runCwd,
    shell: options.shell,
    timeoutMs: options.timeoutMs,
    env: io.env,
    onStdout: io.json ? io.stderr : io.stdout,
    onStderr: io.stderr,
  });
  // Fail safe: a command that changed the worktree leaves stale evidence.
  const treeAfter = key.tree === null ? null : (worktreeTree(io.cwd)?.key ?? null);
  const modifiedWorktree = key.tree !== null && treeAfter !== key.tree;
  const store = storeRoot(io.cwd);
  const blob = store.ok ? storeLog(store.value.root, result.log) : null;
  const tail = tailLines(result.log, TAIL_LINES);
  const passed = result.exitCode === 0 && !result.timedOut;
  const bounded = boundedArgv(command);
  const row = {
    type: "check",
    actor,
    ...key,
    name,
    configured,
    argv: bounded.argv,
    shell: options.shell,
    cwd: relCwd,
    result: passed ? "passed" : "failed",
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    logDigest: blob?.digest ?? null,
    logRef: blob?.ref ?? null,
    attestation: null,
  };
  // Keep the row inside the ledger's single-write bound.
  const ledger = appendObserved(
    io.cwd,
    JSON.stringify(row).length + 200 > MAX_LINE_BYTES
      ? { ...row, argv: [bounded.argv[0], "…"] }
      : row,
  );
  const observation = {
    observer: "workit_cli",
    name,
    configured,
    argv: command,
    shell: options.shell,
    cwd: relCwd,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    head: key.head,
    tree: key.tree,
    dirty: key.dirty,
    signal,
    treeAfter,
    modifiedWorktree,
    base: key.base,
    patchId: key.patchId,
    environment: environmentFingerprint(io.env),
    logDigest: blob?.digest ?? null,
    logRef: blob?.ref ?? null,
    logTail: tailLines(result.log, RECORD_TAIL_LINES).map((line) =>
      line.length > RECORD_TAIL_CHARS ? `${line.slice(0, RECORD_TAIL_CHARS)}…` : line,
    ),
    ledgerRowId: ledger.ok ? String(ledger.value.id) : null,
    attestation: null,
  };
  const unblockFor = (dimension: string): string => {
    const version = (pkg as { version: string }).version;
    if (config.error) return `fix ${CHECKS_FILE}, then ${checkCommand("<name>", version)}`;
    const names = gateCheckNames(config, dimension);
    return names.length
      ? checkCommand(names[0], version)
      : `add ${CHECKS_FILE} (e.g. {"checks":{"test":"<your test command>"}}), then ${checkCommand("test", version)}`;
  };
  const storeDir = taskStoreRoot(io, top);
  const task: TaskOutcome = storeDir
    ? await recordInTask(io, storeDir, options.task, observation, unblockFor)
    : {
        task: null,
        note: options.task
          ? "no workit task store here; recorded to the ledger only"
          : "no active task; recorded to the ledger only",
        evidenceId: null,
        satisfies: [],
        stillUnsatisfied: [],
        error: null,
      };

  const data = {
    evidenceId: task.evidenceId,
    ledgerRowId: observation.ledgerRowId,
    name,
    argv: command,
    configured,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    head: key.head,
    tree: key.tree,
    dirty: key.dirty,
    modifiedWorktree,
    base: key.base,
    patchId: key.patchId,
    logDigest: observation.logDigest,
    logRef: observation.logRef,
    logTail: tail,
    outputBytes: result.outputBytes,
    logTruncated: result.truncated,
    task: task.task,
    ...(task.note ? { taskNote: task.note } : {}),
    satisfies: task.satisfies,
    stillUnsatisfied: task.stillUnsatisfied,
    attested: false,
  };
  const recordError = !ledger.ok
    ? { code: ledger.code as EnvelopeCode, message: `ledger: ${ledger.error}` }
    : task.error;
  const code: EnvelopeCode = !passed ? "failed" : recordError ? recordError.code : "ok";
  const error = !passed
    ? result.timedOut
      ? `timed out after ${options.timeoutMs} ms`
      : result.spawnError
        ? `cannot start ${command[0]}: ${result.spawnError}`
        : `exited ${result.exitCode}`
    : recordError?.message;
  const label = name ?? command.join(" ");
  const summary = `workit check ${label}: ${passed ? "passed" : (error ?? "failed")} in ${result.durationMs} ms (${configured ? "configured" : "ad-hoc"}${name && !configured && config.checks.some((item) => item.name === name) ? `; not the configured command for "${name}"` : ""}); ${task.evidenceId ? `evidence ${task.evidenceId} on task ${task.task?.id}` : (task.note ?? (task.error ? `task: ${task.error.message}` : "ledger only"))}${observation.logRef ? `; log ${observation.logRef}` : ""}`;
  if (io.json)
    io.stdout(
      `${JSON.stringify({ ok: code === "ok", code, data, ...(error ? { error } : {}), ...(task.stillUnsatisfied[0] ? { unblock: task.stillUnsatisfied[0].unblock } : {}) })}\n`,
    );
  else {
    io.stderr(`${summary}\n`);
    if (recordError && passed) io.stderr(`workit: ${recordError.message}\n`);
    for (const gap of task.stillUnsatisfied)
      io.stderr(`  still unsatisfied: ${gap.ruleId}: ${gap.reason}\n`);
  }
  if (!passed) return result.timedOut ? 4 : result.exitCode || 1;
  if (recordError)
    return recordError.code === "busy" ? 4 : recordError.code === "invalid_input" ? 2 : 5;
  return 0;
}
