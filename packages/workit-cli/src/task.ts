import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  OPERATION_FAMILIES,
  TaskStore,
  WorkitCore,
  compactTaskContext,
  failure,
  success,
  type Capability,
  type Caller,
  type Constraint,
  type OperationFamily,
  type OperationContext,
} from "@brainervirus/workit-core/src/core";
import { canonicalJson, type Result } from "@brainervirus/workit-core/src/core/task-contract";

export const TASK_FAMILIES = OPERATION_FAMILIES;
export const TASK_ACTIONS = {
  task: ["start", "list", "inspect", "revise", "progress", "pause", "resume", "close"],
  policy: ["assess", "preview", "explain"],
  evidence: ["record"],
  finding: ["record", "resolve"],
  decision: ["record", "revoke"],
  worker: ["assign", "report", "cancel"],
  writer: ["acquire", "release"],
  state: ["export", "import", "recover"],
} as const satisfies Record<OperationFamily, readonly string[]>;

type Stream = { write: (chunk: string) => void };
type JsonInput = string | AsyncIterable<string | Uint8Array>;

export type TaskCliDeps = {
  cwd?: string;
  root?: string;
  actor?: string;
  caller?: Caller;
  capabilities?: Capability[];
  constraints?: Constraint[];
  now?: OperationContext["now"];
  nativeRecovery?: OperationContext["nativeRecovery"];
  stdinIsTTY?: () => boolean;
  confirm?: () => Promise<boolean>;
  stdin?: JsonInput;
  out?: Stream;
  err?: Stream;
};

type Parsed = {
  family: OperationFamily;
  action: string;
  request: Record<string, unknown>;
  json: boolean;
  confirmed: boolean;
  observedConfirmation: boolean;
  handoff: boolean;
  taskId?: string;
};

type ParseResult =
  | { ok: true; parsed: Parsed }
  | { ok: false; result: Result<never>; json: boolean; usage?: string };

const outOf = (deps: TaskCliDeps) => deps.out ?? process.stdout;
const errOf = (deps: TaskCliDeps) => deps.err ?? process.stderr;
const write = (stream: Stream, value: string) =>
  stream.write(value.endsWith("\n") ? value : `${value}\n`);
const jsonResult = (stream: Stream, result: Result<unknown>) =>
  write(stream, JSON.stringify(result));

const usage = (message: string): Result<never> => failure("invalid_input", message);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const same = (left: unknown, right: unknown): boolean => {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return Object.is(left, right);
  }
};

async function readInput(input: JsonInput): Promise<string> {
  if (typeof input === "string") return input;
  let value = "";
  for await (const chunk of input)
    value += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  return value;
}

async function payloadValue(
  raw: string | undefined,
  deps: TaskCliDeps,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; result: Result<never> }> {
  if (raw === undefined) return { ok: true, value: {} };
  let source: string;
  try {
    source =
      raw === "-"
        ? await readInput(deps.stdin ?? process.stdin)
        : raw.startsWith("@")
          ? readFileSync(raw.slice(1), "utf8")
          : raw;
  } catch (error) {
    return {
      ok: false,
      result: failure("invalid_input", `unable to read payload: ${String(error)}`),
    };
  }
  try {
    const value = JSON.parse(source) as unknown;
    return isObject(value)
      ? { ok: true, value }
      : { ok: false, result: failure("invalid_input", "payload must be a JSON object") };
  } catch (error) {
    return {
      ok: false,
      result: failure("invalid_input", `payload JSON is invalid: ${String(error)}`),
    };
  }
}

const familyHas = (family: OperationFamily, action: string): boolean =>
  (TASK_ACTIONS[family] as readonly string[]).includes(action);

function inject(request: Record<string, unknown>, key: string, value: unknown): Result<null> {
  if (key in request && !same(request[key], value))
    return failure("invalid_input", `payload ${key} conflicts with the explicit flag`, {
      fields: [{ path: key, reason: "explicit flag conflicts with payload" }],
    });
  request[key] = value;
  return success(null, null, null);
}

async function parseTaskArgs(argv: string[], deps: TaskCliDeps): Promise<ParseResult> {
  const familyName = argv[0];
  if (familyName === "handoff") return parseHandoffArgs(argv.slice(1), deps);
  if (!familyName || !(TASK_FAMILIES as readonly string[]).includes(familyName))
    return {
      ok: false,
      result: usage(`unknown operation family: ${familyName ?? ""}`),
      json: argv.includes("--json"),
    };
  const family = familyName as OperationFamily;
  const actionName = argv[1];
  const action = actionName?.replace(/-/g, "_");
  if (!action || !familyHas(family, action))
    return {
      ok: false,
      result: usage(`unknown action for ${family}: ${actionName ?? ""}`),
      json: argv.includes("--json"),
    };

  let payload: string | undefined;
  let taskId: string | undefined;
  let revision: string | undefined;
  let workspaceRevision: string | null | undefined;
  let view: string | undefined;
  let json = false;
  let confirmed = false;
  const seen = new Set<string>();
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json" || token === "--confirm") {
      if (seen.has(token))
        return { ok: false, result: usage(`duplicate argument: ${token}`), json };
      seen.add(token);
      if (token === "--json") json = true;
      else confirmed = true;
      continue;
    }
    if (!["--payload", "--task", "--revision", "--workspace-revision", "--view"].includes(token))
      return { ok: false, result: usage(`unknown argument: ${token}`), json };
    const value = argv[++i];
    if (value === undefined || (value.trim() === "" && token !== "--workspace-revision"))
      return { ok: false, result: usage(`${token} requires a value`), json };
    if (seen.has(token)) return { ok: false, result: usage(`duplicate argument: ${token}`), json };
    seen.add(token);
    if (token === "--payload") payload = value;
    else if (token === "--task") taskId = value;
    else if (token === "--revision") revision = value;
    else if (token === "--workspace-revision") workspaceRevision = value === "null" ? null : value;
    else view = value;
  }
  const loaded = await payloadValue(payload, deps);
  if (!loaded.ok) return { ok: false, result: loaded.result, json };
  const request = loaded.value;
  if (!("schemaVersion" in request)) request.schemaVersion = 1;
  for (const [key, value] of [
    ["action", action],
    ...(taskId === undefined ? [] : [["taskId", taskId] as const]),
    ...(revision === undefined ? [] : [["expectedRevision", revision] as const]),
    ...(workspaceRevision === undefined
      ? []
      : [["expectedWorkspaceRevision", workspaceRevision] as const]),
    ...(view === undefined ? [] : [["view", view] as const]),
  ] as const) {
    const checked = inject(request, key, value);
    if (!checked.ok) return { ok: false, result: checked, json };
  }
  return {
    ok: true,
    parsed: {
      family,
      action,
      request,
      json,
      confirmed,
      observedConfirmation: false,
      handoff: false,
    },
  };
}

async function parseHandoffArgs(argv: string[], deps: TaskCliDeps): Promise<ParseResult> {
  let taskId: string | undefined;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") {
      if (seen.has(token))
        return { ok: false, result: usage(`duplicate argument: ${token}`), json };
      seen.add(token);
      json = true;
      continue;
    }
    if (token !== "--task") return { ok: false, result: usage(`unknown argument: ${token}`), json };
    if (taskId !== undefined || argv[i + 1] === undefined || argv[i + 1].trim() === "")
      return { ok: false, result: usage("--task requires one non-empty value"), json };
    if (seen.has(token)) return { ok: false, result: usage(`duplicate argument: ${token}`), json };
    seen.add(token);
    taskId = argv[++i];
  }
  if (!taskId) return { ok: false, result: usage("handoff requires --task <id>"), json };
  void deps;
  return {
    ok: true,
    parsed: {
      family: "state",
      action: "export",
      request: { schemaVersion: 1, action: "export", taskId },
      json,
      confirmed: false,
      observedConfirmation: false,
      handoff: true,
      taskId,
    },
  };
}

const dispatch = (core: WorkitCore, family: OperationFamily, request: unknown): Result<unknown> => {
  switch (family) {
    case "task":
      return core.task(request);
    case "policy":
      return core.policy(request);
    case "evidence":
      return core.evidence(request);
    case "finding":
      return core.finding(request);
    case "decision":
      return core.decision(request);
    case "worker":
      return core.worker(request);
    case "writer":
      return core.writer(request);
    case "state":
      return core.state(request);
  }
};

const contextFor = (
  root: string,
  deps: TaskCliDeps,
  provenanceKind: OperationContext["provenanceKind"] = "agent_reported",
): OperationContext => ({
  root,
  caller: deps.caller ?? { host: "workit_cli", actor: deps.actor ?? "cli" },
  provenanceKind,
  capabilities: deps.capabilities ?? [],
  constraints: deps.constraints ?? [],
  now: deps.now ?? (() => new Date().toISOString()),
  nativeRecovery: deps.nativeRecovery,
});

const CONSENT_ACTIONS = new Set([
  "task.pause",
  "task.resume",
  "task.close",
  "worker.cancel",
  "writer.acquire",
  "writer.release",
  "state.import",
  "state.recover",
]);

const needsConsent = (parsed: Parsed): boolean =>
  CONSENT_ACTIONS.has(`${parsed.family}.${parsed.action}`);

async function observeConsent(
  deps: TaskCliDeps,
): Promise<{ accepted: boolean; observed: boolean }> {
  const tty = deps.stdinIsTTY ? deps.stdinIsTTY() : process.stdin.isTTY === true;
  if (!tty) return { accepted: false, observed: false };
  if (deps.confirm) return { accepted: await deps.confirm(), observed: true };
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("Proceed? [y/N] ");
    return { accepted: /^y(es)?$/i.test(answer.trim()), observed: true };
  } finally {
    prompt.close();
  }
}

function printHuman(result: Result<unknown>, deps: TaskCliDeps, handoff = false): void {
  const stream = result.ok ? outOf(deps) : errOf(deps);
  if (!result.ok) {
    write(stream, `${result.code}: ${result.error}`);
    for (const field of result.details.fields ?? [])
      write(stream, `  ${field.path}: ${field.reason}`);
    return;
  }
  const data = result.data as any;
  if (handoff && data?.bundle && data?.context) {
    write(stream, "Task export");
    write(stream, JSON.stringify(data.bundle, null, 2));
    write(stream, "Destination context");
    write(stream, JSON.stringify(data.context, null, 2));
    return;
  }
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows) {
    if (row && typeof row === "object" && "id" in row && "status" in row)
      write(stream, `${row.id} ${row.status}${row.objective ? ` — ${row.objective}` : ""}`);
    else write(stream, JSON.stringify(row, null, 2));
    for (const gap of row?.requirements?.filter((item: any) => item.status !== "satisfied") ?? [])
      write(stream, `policy gap: ${gap.reason}`);
  }
}

export async function runTaskCommand(argv: string[], deps: TaskCliDeps = {}): Promise<number> {
  const parsed = await parseTaskArgs(argv, deps);
  if (!parsed.ok) {
    if (parsed.json) jsonResult(outOf(deps), parsed.result);
    else
      write(
        errOf(deps),
        parsed.usage ?? (parsed.result.ok ? "invalid input" : parsed.result.error),
      );
    return parsed.usage ? 2 : 1;
  }
  const root = deps.root ?? process.env.WORKFLOW_WORKSPACE_ROOT ?? deps.cwd ?? process.cwd();
  let observedConfirmation = parsed.parsed.observedConfirmation;
  if (needsConsent(parsed.parsed) && !parsed.parsed.confirmed) {
    const consent = await observeConsent(deps);
    if (!consent.accepted) {
      const result = failure("needs_input", "explicit consent is required for this operation", {
        operation: `${parsed.parsed.family}.${parsed.parsed.action}`,
      });
      if (parsed.parsed.json) jsonResult(outOf(deps), result);
      else printHuman(result, deps);
      return 1;
    }
    observedConfirmation = consent.observed;
  }
  const core = new WorkitCore(
    new TaskStore(root),
    contextFor(root, deps, observedConfirmation ? "host_observed" : "agent_reported"),
  );
  let result: Result<unknown>;
  if (parsed.parsed.handoff) {
    const exported = dispatch(core, "state", parsed.parsed.request);
    if (!exported.ok) result = exported;
    else {
      const viewed = dispatch(core, "task", {
        schemaVersion: 1,
        action: "inspect",
        taskId: parsed.parsed.taskId,
        view: "full",
      });
      if (!viewed.ok) result = viewed;
      else
        result = success(exported.revision, exported.workspaceRevision, {
          bundle: exported.data,
          context: JSON.parse(compactTaskContext(viewed.data as any)),
        });
    }
  } else if (
    parsed.parsed.family === "task" &&
    parsed.parsed.action === "resume" &&
    Array.isArray(parsed.parsed.request.authorityRefs) &&
    parsed.parsed.request.authorityRefs.length === 0
  ) {
    result = failure("needs_input", "resume requires explicit authority consent", {
      operation: "task.resume",
    });
  } else result = dispatch(core, parsed.parsed.family, parsed.parsed.request);
  if (parsed.parsed.json) jsonResult(outOf(deps), result);
  else printHuman(result, deps, parsed.parsed.handoff);
  return result.ok ? 0 : 1;
}
