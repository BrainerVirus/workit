import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";
import { TaskStore } from "@brainervirus/workit-core/src/core";
import { assertProductWriteAllowed } from "@brainervirus/workit-core/src/core/workers";
import { createLogger } from "@brainervirus/workit-core/src/core/logger";
import { EVENT, errorDetail } from "@brainervirus/workit-core/src/core/boundary";
import { getWorkitBootstrap } from "./bootstrap";
import { createWorkitTools, NativeReceiptStore, observeQuestion } from "./tools/workit";
import { compactContextFor, loadProvenance, workerContextFor } from "./runtime";

const root = fileURLToPath(new URL("../assets/", import.meta.url));
const skillsPath = path.join(root, "skills");
const logger = createLogger({
  appLog: () => undefined,
});

type SessionClient = {
  session?: {
    get?: (input: {
      path: { id: string };
    }) => Promise<{ data?: { parentID?: string; directory?: string } }>;
  };
};

const sessionData = async (client: SessionClient | undefined, sessionID: string) => {
  if (!client) return {};
  try {
    return (await client.session?.get?.({ path: { id: sessionID } }))?.data ?? {};
  } catch {
    return null;
  }
};

const mutationSurface = new Set(["write", "edit", "apply_patch", "patch"]);
const shellMutation =
  /(?:^|[;&|]\s*|\s)(?:rm|mv|cp|mkdir|rmdir|touch|install|tee|chmod|chown|sed|perl|git\s+(?:add|commit|clean|reset|checkout|switch|merge|rebase|push|pull|apply))\b|>>?|<<?/;

const writePaths = (tool: string, args: Record<string, unknown>): string[] => {
  if (tool === "bash") return ["."];
  const values = [args.path, args.file, args.filename, args.target, args.paths].flatMap((value) =>
    Array.isArray(value) ? value : [value],
  );
  const paths = values.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return paths.length ? paths : ["."];
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
  const store = new TaskStore(directory);
  const workspace = store.readWorkspace();
  if (!workspace.ok) throw new Error(`${workspace.code}: ${workspace.error}`);
  const listed = store.listTasks();
  if (!listed.ok) throw new Error(`${listed.code}: ${listed.error}`);
  const worker = listed.data
    .flatMap((task) => task.workers)
    .find(
      (entry) => entry.data.session?.kind === "host" && entry.data.session.handle === sessionID,
    );
  if (worker && worker.data.assignment.role !== "implementer")
    throw new Error("permission_denied: read-only worker cannot write product files");
  if (!workspace.data?.writer) return;
  const task = store.readTask(workspace.data.writer.owner.taskId);
  if (!task.ok) throw new Error(`${task.code}: ${task.error}`);
  if (workspace.data.writer.state === "uncertain")
    throw new Error("recovery_required: checkout writer requires recovery");
  if (
    workspace.data.writer.owner.session.kind !== "host" ||
    workspace.data.writer.owner.session.handle !== sessionID
  )
    throw new Error("writer_conflict: checkout is owned by another validated actor");
  const observed = await sessionData(client, sessionID);
  if (observed === null)
    throw new Error("permission_denied: OpenCode session observation unavailable");
  const workerId = worker?.id ?? null;
  const result = assertProductWriteAllowed({
    task: task.data,
    workspace: workspace.data,
    caller: {
      host: "opencode",
      actor: sessionID,
      session: { kind: "host", host: "opencode", handle: sessionID },
      workerId,
    },
    paths: writePaths(toolName, args),
    store,
  });
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
};

const plugin: Plugin = async ({ client, directory }) => {
  const receipts = new NativeReceiptStore();
  const directChildren = new Map<string, string>();
  const uncertainWorkers = new Set<string>();
  const bootstrapped = new Set<string>();
  const compacted = new Set<string>();
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
  return {
    tool: tools,
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
          else uncertainWorkers.add(child);
        }
        const state = String(
          metadata?.status ?? metadata?.state ?? output.output ?? "",
        ).toLowerCase();
        if (/(?:cancel|interrupt|unknown|uncertain)/.test(state))
          uncertainWorkers.add(typeof child === "string" ? child : input.callID);
      }
    },
    "tool.execute.before": async (input, output) => {
      if (input.tool === "task") {
        if (uncertainWorkers.size > 0)
          throw new Error("recovery_required: a cancelled worker remains uncertain");
        const session = await sessionData(client, input.sessionID);
        if (!client || session === null || session.parentID)
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
      if (compacted.has(sessionID)) return;
      const context = compactContextFor(directory, sessionID);
      if (context) {
        if (output.context.some((entry) => entry.includes("<workit-task-context>"))) {
          compacted.add(sessionID);
          return;
        }
        output.context.push(`<workit-task-context>${context}</workit-task-context>`);
        compacted.add(sessionID);
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      const first = output.messages.find((message) => message.info.role === "user");
      if (!first || !first.parts.length) return;
      const sessionID = first.info.sessionID;
      if (bootstrapped.has(sessionID)) return;
      const anchor = first.parts[0];
      const session = await sessionData(client, sessionID);
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
