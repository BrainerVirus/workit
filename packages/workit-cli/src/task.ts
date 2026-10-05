import { readFileSync } from "node:fs";
import path from "node:path";
import { checkRoot } from "@brainervirus/workit-core/src/check-config";
import { sameDirectoryIdentity } from "@brainervirus/workit-core/src/core/task-store";
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

/**
 * The checkout root for a CLI command: explicit root, WORKFLOW_WORKSPACE_ROOT,
 * then the worktree top of cwd (cwd outside git), so every verb run anywhere
 * in a checkout shares its workspace record and implicit task.
 */
export const workspaceRootFor = (deps: { root?: string; cwd?: string } = {}): string => {
  const explicit = deps.root || process.env.WORKFLOW_WORKSPACE_ROOT;
  if (explicit) return explicit;
  const cwd = deps.cwd ?? process.cwd();
  const top = checkRoot(cwd);
  // Keep the caller's spelling when cwd is the top itself.
  return sameDirectoryIdentity(top, path.resolve(cwd)) ? cwd : top;
};
export const TASK_ACTIONS = {
  task: ["start", "list", "inspect", "revise", "progress", "pause", "resume", "close"],
  policy: ["assess", "preview", "explain"],
  evidence: ["record"],
  finding: ["record", "resolve"],
  decision: ["record", "revoke"],
  worker: ["assign", "report", "cancel"],
  state: ["export", "import"],
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
  afterExport?: () => void;
  stdin?: JsonInput;
  out?: Stream;
  err?: Stream;
};

type Parsed = {
  family: OperationFamily;
  action: string;
  request: Record<string, unknown>;
  json: boolean;
  handoff: boolean;
  taskId?: string;
  actor?: string;
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
const parseUsage = (message: string, json: boolean): ParseResult => ({
  ok: false,
  result: usage(message),
  json,
  usage: message,
});
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const same = (left: unknown, right: unknown): boolean => {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return Object.is(left, right);
  }
};

const decodeUtf8 = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

async function readInput(input: JsonInput): Promise<string> {
  if (typeof input === "string") return input;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let value = "";
  for await (const chunk of input)
    value += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  value += decoder.decode();
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
          ? decodeUtf8(readFileSync(raw.slice(1)))
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
  const jsonRequested = argv.includes("--json");
  const familyName = argv[0];
  if (familyName === "handoff") return parseHandoffArgs(argv.slice(1), deps);
  if (!familyName || !(TASK_FAMILIES as readonly string[]).includes(familyName))
    return parseUsage(`unknown operation family: ${familyName ?? ""}`, jsonRequested);
  const family = familyName as OperationFamily;
  const actionName = argv[1];
  const action = actionName?.replace(/-/g, "_");
  if (!action || !familyHas(family, action))
    return parseUsage(`unknown action for ${family}: ${actionName ?? ""}`, jsonRequested);

  let payload: string | undefined;
  let taskId: string | undefined;
  let revision: string | undefined;
  let workspaceRevision: string | null | undefined;
  let view: string | undefined;
  let actor: string | undefined;
  let json = jsonRequested;
  const seen = new Set<string>();
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json" || token === "--confirm") {
      if (seen.has(token)) return parseUsage(`duplicate argument: ${token}`, json);
      seen.add(token);
      // --confirm is accepted and ignored (≤4.x consent flag; D2).
      if (token === "--json") json = true;
      continue;
    }
    if (
      !["--payload", "--task", "--revision", "--workspace-revision", "--view", "--actor"].includes(
        token,
      )
    )
      return parseUsage(`unknown argument: ${token}`, json);
    const value = argv[++i];
    if (value === undefined || (value.trim() === "" && token !== "--workspace-revision"))
      return parseUsage(`${token} requires a value`, json);
    if (seen.has(token)) return parseUsage(`duplicate argument: ${token}`, json);
    seen.add(token);
    if (token === "--payload") payload = value;
    else if (token === "--task") taskId = value;
    else if (token === "--revision") revision = value;
    else if (token === "--workspace-revision") workspaceRevision = value === "null" ? null : value;
    else if (token === "--actor") actor = value;
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
      handoff: false,
      actor,
    },
  };
}

async function parseHandoffArgs(argv: string[], deps: TaskCliDeps): Promise<ParseResult> {
  let taskId: string | undefined;
  let json = argv.includes("--json");
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") {
      if (seen.has(token)) return parseUsage(`duplicate argument: ${token}`, json);
      seen.add(token);
      json = true;
      continue;
    }
    if (token !== "--task") return parseUsage(`unknown argument: ${token}`, json);
    if (taskId !== undefined || argv[i + 1] === undefined || argv[i + 1].trim() === "")
      return parseUsage("--task requires one non-empty value", json);
    if (seen.has(token)) return parseUsage(`duplicate argument: ${token}`, json);
    seen.add(token);
    taskId = argv[++i];
  }
  if (!taskId) return parseUsage("handoff requires --task <id>", json);
  void deps;
  return {
    ok: true,
    parsed: {
      family: "state",
      action: "export",
      request: { schemaVersion: 1, action: "export", taskId },
      json,
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
});

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
  const root = workspaceRootFor(deps);
  const core = new WorkitCore(
    new TaskStore(root),
    // --actor overrides the provenance actor (e.g. a Codex session id the
    // hook can match); otherwise the ambient actor.
    contextFor(
      root,
      parsed.parsed.actor !== undefined ? { ...deps, actor: parsed.parsed.actor } : deps,
    ),
  );
  let result: Result<unknown>;
  if (parsed.parsed.handoff) {
    const exported = dispatch(core, "state", parsed.parsed.request);
    if (!exported.ok) result = exported;
    else {
      deps.afterExport?.();
      const viewed = dispatch(core, "task", {
        schemaVersion: 1,
        action: "inspect",
        taskId: parsed.parsed.taskId,
        view: "full",
      });
      if (!viewed.ok) result = viewed;
      else if (
        viewed.revision !== exported.revision ||
        viewed.workspaceRevision !== exported.workspaceRevision
      )
        result = failure("revision_conflict", "task changed while preparing handoff", {
          operation: "handoff",
          ...(exported.revision ? { expectedRevision: exported.revision } : {}),
          ...(viewed.revision ? { actualRevision: viewed.revision } : {}),
          expectedWorkspaceRevision: exported.workspaceRevision,
          actualWorkspaceRevision: viewed.workspaceRevision,
        });
      else
        result = success(exported.revision, exported.workspaceRevision, {
          bundle: exported.data,
          context: JSON.parse(compactTaskContext(viewed.data as any)),
        });
    }
  } else result = dispatch(core, parsed.parsed.family, parsed.parsed.request);
  if (parsed.parsed.json) jsonResult(outOf(deps), result);
  else printHuman(result, deps, parsed.parsed.handoff);
  return result.ok ? 0 : 1;
}
