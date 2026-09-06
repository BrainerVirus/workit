import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";
import { TaskStore, WorkitCore } from "@brainervirus/workit-core/src/core";
import { assertProductWriteAllowed } from "@brainervirus/workit-core/src/core/workers";
import { createLogger } from "@brainervirus/workit-core/src/core/logger";
import { EVENT, errorDetail } from "@brainervirus/workit-core/src/core/boundary";
import { getWorkitBootstrap } from "./bootstrap";
import {
  createWorkitTools,
  NativeReceiptStore,
  nativeWorkerFor,
  observeQuestion,
  sameWorkspace,
  sessionParent,
  type DirectChildren,
} from "./tools/workit";
import { compactContextFor, loadProvenance, workerContextFor } from "./runtime";

const root = fileURLToPath(new URL("../assets/", import.meta.url));
const skillsPath = path.join(root, "skills");
const logger = createLogger({
  appLog: () => undefined,
});

type SessionClient = {
  session?: {
    get?: (input: { path: { id: string } }) => Promise<{ data?: SessionInfo }>;
  };
};

type SessionInfo = { id?: string; parentID?: string; directory?: string };

const sessionData = async (client: SessionClient | undefined, sessionID: string) => {
  if (!client) return null;
  try {
    return (await client.session?.get?.({ path: { id: sessionID } }))?.data ?? {};
  } catch {
    return null;
  }
};

const trustedSession = (
  directory: string,
  sessionID: string,
  session: unknown,
): session is SessionInfo =>
  typeof session === "object" &&
  session !== null &&
  (session as SessionInfo).id === sessionID &&
  typeof (session as SessionInfo).directory === "string" &&
  sameWorkspace(directory, (session as SessionInfo).directory) &&
  sessionParent(session) !== null;

const mutationSurface = new Set(["write", "edit", "apply_patch", "patch"]);
const shellMutation =
  /(?:^|[;&|]\s*|\s)(?:rm|mv|cp|mkdir|rmdir|touch|install|tee|chmod|chown|git\s+add)\b|>>?|<<?/;

const unquote = (value: string): string => value.replace(/^(["'])(.*)\1$/, "$2");

const shellWritePaths = (command: string): string[] => {
  const paths: string[] = [];
  const segments = command.split(/&&|\|\||[;|]/);
  for (const segment of segments) {
    for (const match of segment.matchAll(/(?:^|\s)(?:>>|>)\s*([^\s;&|]+)/g))
      paths.push(unquote(match[1]));
    const tokens = segment.split(/\s+/).map(unquote).filter(Boolean);
    const head = tokens[0]?.split("/").pop() ?? "";
    const commandNames = new Set([
      "rm",
      "mv",
      "cp",
      "mkdir",
      "rmdir",
      "touch",
      "install",
      "tee",
      "chmod",
      "chown",
    ]);
    if (commandNames.has(head))
      paths.push(...tokens.slice(1).filter((token) => !token.startsWith("-") && token !== "--"));
    if (head === "git" && tokens[1] === "add")
      paths.push(...tokens.slice(2).filter((token) => !token.startsWith("-") && token !== "--"));
  }
  return [...new Set(paths)];
};

const normalizeWritePath = (directory: string, value: string): string => {
  if (!path.isAbsolute(value)) return value;
  const relative = path.relative(path.resolve(directory), path.resolve(value));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : value;
};

const patchWritePaths = (patchText: unknown): string[] => {
  if (typeof patchText !== "string") return [];
  const paths: string[] = [];
  for (const line of patchText.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    const move = line.match(/^\*\*\* Move to: (.+)$/);
    if (match?.[1]) paths.push(match[1].trim());
    else if (move?.[1]) paths.push(move[1].trim());
  }
  return paths;
};

const writePaths = (directory: string, tool: string, args: Record<string, unknown>): string[] => {
  if (tool === "bash") return shellWritePaths(String(args.command ?? ""));
  if (tool === "apply_patch")
    return patchWritePaths(args.patchText).map((value) => normalizeWritePath(directory, value));
  const values = [args.path, args.file, args.filename, args.target, args.paths].flatMap((value) =>
    Array.isArray(value) ? value : [value],
  );
  if (tool === "write" || tool === "edit") values.push(args.filePath);
  const paths = values.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return paths.map((value) => normalizeWritePath(directory, value));
};

const enforceWriter = async (
  client: SessionClient,
  directory: string,
  sessionID: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> => {
  const known =
    mutationSurface.has(toolName) ||
    (toolName === "bash" && shellMutation.test(String(args.command ?? "")));
  if (!known) return;
  const paths = writePaths(directory, toolName, args);
  // A shell command is only in the enforced class when a simple target can be
  // identified. Opaque shell writes remain agent-guided by design.
  if (toolName !== "bash" && paths.length === 0)
    throw new Error("invalid_input: product write target is required");
  if (toolName === "bash" && paths.length === 0) return;
  const store = new TaskStore(directory);
  const workspace = store.readWorkspace();
  if (!workspace.ok) throw new Error(`${workspace.code}: ${workspace.error}`);
  if (!workspace.data) return;
  const listed = store.listTasks();
  if (!listed.ok) throw new Error(`${listed.code}: ${listed.error}`);
  const observed = await sessionData(client, sessionID);
  if (observed === null)
    throw new Error("permission_denied: OpenCode session observation unavailable");
  const workerMatches = listed.data.flatMap((task) =>
    task.status === "active"
      ? task.workers
          .filter(
            (entry) =>
              entry.data.session?.kind === "host" && entry.data.session.handle === sessionID,
          )
          .map((entry) => ({ task, entry }))
      : [],
  );
  const activeTasks = listed.data.filter(
    (task) => task.status === "active" && task.workspaceId === workspace.data?.id,
  );
  if (activeTasks.length > 0 && !trustedSession(directory, sessionID, observed))
    throw new Error("permission_denied: trusted OpenCode session observation is required");
  if (workerMatches.length === 0 && observed.parentID)
    throw new Error("permission_denied: OpenCode session parentage is not a coordinator");
  if (workerMatches.length === 1) {
    const coordinator = workerMatches[0].task.intent.provenance.session;
    if (
      coordinator?.kind !== "host" ||
      coordinator.host !== "opencode" ||
      observed.parentID !== coordinator.handle
    )
      throw new Error("permission_denied: OpenCode worker parentage is not validated");
  }
  const task =
    (workspace.data.writer &&
      activeTasks.find((candidate) => candidate.id === workspace.data?.writer?.owner.taskId)) ||
    (workerMatches.length === 1 ? workerMatches[0].task : null) ||
    (activeTasks.length === 1 ? activeTasks[0] : null);
  if (!task) return;
  const worker = workerMatches.find((candidate) => candidate.task.id === task.id)?.entry;
  if (worker && worker.data.assignment.role !== "implementer")
    throw new Error("permission_denied: read-only worker cannot write product files");
  const workerId = worker?.id ?? null;
  const result = assertProductWriteAllowed({
    task,
    workspace: workspace.data,
    caller: {
      host: "opencode",
      actor: sessionID,
      session: { kind: "host", host: "opencode", handle: sessionID },
      workerId,
    },
    paths,
    store,
  });
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
};

const plugin: Plugin = async ({ client, directory }) => {
  const receipts = new NativeReceiptStore();
  const directChildren: DirectChildren = new Map();
  const lifecycleBindings = new Map<
    string,
    { parentID: string; taskId: string; workerId: string }
  >();
  // Fallback only for a task result that names no session. Once a trusted
  // session exists, lifecycle authority is persisted in core state.
  const unresolvedTaskLaunches = new Set<string>();
  const bootstrapped = new Set<string>();
  try {
    logger.info(EVENT.initialization, { host: "opencode", plugin_root: root });
    logger.info(
      EVENT.provenance,
      loadProvenance(logger, new URL("../package.json", import.meta.url)),
    );
  } catch (error) {
    logger.warn(EVENT.hooks, { boundary: "initialization", ...errorDetail(error) });
  }
  const tools = createWorkitTools({ client, receipts, directChildren });
  const observeLifecycle = async (
    sessionID: string,
    parentID: string,
    state: "running" | "stopped" | "unknown",
    binding?: { taskId: string; workerId: string },
    initial = false,
  ) => {
    const store = new TaskStore(directory);
    const listed = store.listTasks();
    const workspace = store.readWorkspace();
    if (!listed.ok || !workspace.ok || !workspace.data) return;
    const persisted = listed.data.flatMap((task) =>
      task.status === "active"
        ? task.workers
            .filter(
              (entry) =>
                entry.id === binding?.workerId ||
                (entry.data.session?.kind === "host" && entry.data.session.handle === sessionID),
            )
            .map((entry) => ({ task, entry }))
        : [],
    );
    const matches = persisted.filter(({ entry }) => entry.data.session?.kind === "host");
    const selected = binding
      ? persisted.find(
          ({ task, entry }) => task.id === binding.taskId && entry.id === binding.workerId,
        )
      : matches.length === 1
        ? matches[0]
        : undefined;
    if (!selected) return;
    if (selected.entry.provenance.session?.kind !== "host") return;
    if (!binding) {
      // ponytail: running lifecycle overwrites worker provenance with the child
      // session; task intent is the persisted coordinator parent after restart.
      const coordinator = selected.task.intent.provenance.session;
      if (coordinator?.kind !== "host" || coordinator.host !== "opencode") return;
      parentID = coordinator.handle;
    }
    if (!initial) {
      const observed = await sessionData(client, sessionID);
      if (!trustedSession(directory, sessionID, observed) || observed.parentID !== parentID) return;
    }
    directChildren.set(sessionID, parentID);
    const core = new WorkitCore(store, {
      root: directory,
      caller: { host: "opencode", actor: parentID },
      capabilities: [],
      constraints: [],
      now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      nativeWorker: nativeWorkerFor(directChildren, parentID),
    });
    const result = core.observeWorkerLifecycle({
      taskId: selected.task.id,
      workerId: selected.entry.id,
      expectedRevision: selected.task.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      state,
      session: { kind: "host", host: "opencode", handle: sessionID },
      observation: { event: state, sessionID },
    });
    if (result.ok) {
      lifecycleBindings.set(sessionID, {
        parentID,
        taskId: selected.task.id,
        workerId: selected.entry.id,
      });
    }
  };
  const bindCreatedSession = async (info: SessionInfo) => {
    if (
      typeof info.id !== "string" ||
      typeof info.parentID !== "string" ||
      !sameWorkspace(directory, info.directory)
    )
      return;
    const store = new TaskStore(directory);
    const workspace = store.readWorkspace();
    const listed = store.listTasks();
    if (!workspace.ok || !workspace.data || !listed.ok) return;
    const candidates = listed.data.flatMap((task) =>
      task.status === "active" && task.workspaceId === workspace.data?.id
        ? task.workers
            .filter(
              (entry) =>
                entry.data.state === "assigned" &&
                entry.data.session === null &&
                entry.provenance.session?.kind === "host" &&
                entry.provenance.session.host === "opencode" &&
                entry.provenance.session.handle === info.parentID,
            )
            .map((entry) => ({ task, entry }))
        : [],
    );
    if (candidates.length !== 1) return;
    directChildren.set(info.id, info.parentID);
    await observeLifecycle(
      info.id,
      info.parentID,
      "running",
      {
        taskId: candidates[0].task.id,
        workerId: candidates[0].entry.id,
      },
      true,
    );
  };
  return {
    tool: tools,
    event: async ({ event }) => {
      if (event.type === "session.created") {
        await bindCreatedSession(event.properties.info);
        return;
      }
      if (
        event.type !== "session.status" &&
        event.type !== "session.idle" &&
        event.type !== "session.error" &&
        event.type !== "session.deleted"
      )
        return;
      const properties = event.properties as {
        sessionID?: unknown;
        info?: { id?: unknown };
      };
      const sessionID =
        typeof properties.sessionID === "string"
          ? properties.sessionID
          : typeof properties.info?.id === "string"
            ? properties.info.id
            : undefined;
      if (typeof sessionID !== "string") return;
      const binding = lifecycleBindings.get(sessionID);
      const state =
        event.type === "session.status"
          ? event.properties.status.type === "busy"
            ? "running"
            : event.properties.status.type === "idle"
              ? "stopped"
              : "unknown"
          : event.type === "session.idle"
            ? "stopped"
            : event.type === "session.deleted"
              ? "stopped"
              : "unknown";
      await observeLifecycle(sessionID, binding?.parentID ?? "", state, binding);
    },
    "tool.execute.after": async (input, output) => {
      observeQuestion(receipts, input, output);
      if (input.tool === "task") {
        const metadata = output.metadata as
          | { sessionID?: unknown; sessionId?: unknown; status?: unknown; state?: unknown }
          | undefined;
        const child = metadata?.sessionID ?? metadata?.sessionId;
        if (typeof child === "string") {
          const childSession = await sessionData(client, child);
          if (childSession?.parentID === input.sessionID)
            directChildren.set(child, input.sessionID);
        }
        const state = String(
          metadata?.status ?? metadata?.state ?? output.output ?? "",
        ).toLowerCase();
        if (/(?:cancel|interrupt|unknown|uncertain)/.test(state))
          unresolvedTaskLaunches.add(input.sessionID);
      }
    },
    "tool.execute.before": async (input, output) => {
      if (input.tool === "task") {
        const listed = new TaskStore(directory).listTasks();
        if (
          listed.ok &&
          listed.data.some((task) =>
            task.workers.some(
              (worker) => worker.data.state === "cancelling" || worker.data.state === "unknown",
            ),
          )
        )
          throw new Error("recovery_required: a cancelled worker remains uncertain");
        if (unresolvedTaskLaunches.delete(input.sessionID))
          throw new Error("recovery_required: a cancelled worker remains uncertain");
        const session = await sessionData(client, input.sessionID);
        if (!client || !trustedSession(directory, input.sessionID, session) || session.parentID)
          throw new Error(
            "delegation_lineage_denied: native task workers must be direct children of the coordinator",
          );
      }
      await enforceWriter(client, directory, input.sessionID, input.tool, output.args ?? {});
    },
    config: async (config) => {
      const mutable = config as typeof config & {
        skills?: { paths?: string[] };
        permission?: unknown;
        agent?: Record<string, { permission?: unknown }>;
      };
      const paths = [...(mutable.skills?.paths ?? [])];
      if (existsSync(skillsPath) && !paths.includes(skillsPath)) paths.push(skillsPath);
      mutable.skills ??= {};
      mutable.skills.paths = paths;
      const permission = mutable.permission;
      const current: Record<string, any> =
        typeof permission === "string"
          ? { "*": permission }
          : typeof permission === "object" && permission !== null
            ? { ...(permission as Record<string, unknown>) }
            : {};
      const bash: Record<string, any> =
        typeof current.bash === "string"
          ? { "*": current.bash }
          : typeof current.bash === "object" && current.bash !== null
            ? { ...(current.bash as Record<string, unknown>) }
            : {};
      bash["*git *worktree*"] = "deny";
      current.bash = bash;
      mutable.permission = current;
      for (const agent of Object.values(mutable.agent ?? {})) {
        if (!agent) continue;
        const agentPermission = agent.permission;
        const agentConfig: Record<string, any> =
          typeof agentPermission === "string"
            ? { "*": agentPermission }
            : typeof agentPermission === "object" && agentPermission !== null
              ? { ...(agentPermission as Record<string, unknown>) }
              : {};
        const agentBash: Record<string, any> =
          typeof agentConfig.bash === "string"
            ? { "*": agentConfig.bash }
            : typeof agentConfig.bash === "object" && agentConfig.bash !== null
              ? { ...(agentConfig.bash as Record<string, unknown>) }
              : {};
        agentBash["*git *worktree*"] = "deny";
        agentConfig.bash = agentBash;
        agent.permission = agentConfig;
      }
    },
    "experimental.session.compacting": async ({ sessionID }, output) => {
      const context = compactContextFor(directory, sessionID);
      if (context) {
        if (output.context.some((entry) => entry.includes("<workit-task-context>"))) return;
        output.context.push(`<workit-task-context>${context}</workit-task-context>`);
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      const first = output.messages.find((message) => message.info.role === "user");
      if (!first || !first.parts.length) return;
      const sessionID = first.info.sessionID;
      if (bootstrapped.has(sessionID)) return;
      const anchor = first.parts[0];
      const session = await sessionData(client, sessionID);
      if (!trustedSession(directory, sessionID, session)) return;
      const workerContext = session?.parentID
        ? workerContextFor(directory, sessionID, session.parentID, directChildren)
        : null;
      const bootstrap = session && !session.parentID ? getWorkitBootstrap() : null;
      const context = compactContextFor(directory, sessionID);
      if (
        bootstrap &&
        !first.parts.some((part) => part.type === "text" && part.text.includes("<workit-contract>"))
      ) {
        first.parts.unshift({ ...anchor, type: "text", text: bootstrap } as never);
      }
      if (
        context &&
        !first.parts.some(
          (part) => part.type === "text" && part.text.includes("<workit-task-context>"),
        )
      ) {
        first.parts.unshift({
          ...anchor,
          type: "text",
          text: `<workit-task-context>${context}</workit-task-context>`,
        } as never);
      }
      if (
        workerContext &&
        !first.parts.some(
          (part) => part.type === "text" && part.text.includes("<workit-worker-context>"),
        )
      ) {
        first.parts.unshift({
          ...anchor,
          type: "text",
          text: `<workit-worker-context>${workerContext}</workit-worker-context>`,
        } as never);
      }
      bootstrapped.add(sessionID);
    },
  };
};

export default plugin;
