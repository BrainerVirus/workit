import path from "node:path";
import { fileURLToPath } from "node:url";
import { tool } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { fail, ok, run, type Result } from "../core";
import { WorkflowStateStore } from "../state";

type ApiResponse<T> = { data?: T; error?: unknown };
type ApiResult<T> = Promise<ApiResponse<T>>;
type ApiVoidResult = Promise<ApiResponse<void> | void>;
type ApiUnknownResult = Promise<ApiResponse<unknown> | void>;

export type HandoffClient = {
  session: {
    create(input: {
      body: { parentID: string; title: string };
      query: { directory: string };
    }): ApiResult<{ id: string }>;
    promptAsync(input: {
      path: { id: string };
      query: { directory: string };
      body: { parts: [{ type: "text"; text: string }] };
    }): ApiVoidResult;
  };
  tui: {
    selectSession(input: {
      body: { sessionID: string };
      query: { directory: string };
    }): ApiUnknownResult;
  };
};

type V2HandoffClient = {
  session: {
    create(input: NonNullable<Parameters<OpencodeClient["session"]["create"]>[0]>): ApiResult<{ id: string }>;
    promptAsync(input: Parameters<OpencodeClient["session"]["promptAsync"]>[0]): ApiVoidResult;
  };
  tui: {
    selectSession(input: NonNullable<Parameters<OpencodeClient["tui"]["selectSession"]>[0]>): ApiUnknownResult;
  };
};

export const adaptHandoffClient = (client: V2HandoffClient): HandoffClient => ({
  session: {
    create: ({ body, query }) => client.session.create({ ...body, directory: query.directory }),
    promptAsync: ({ path: requestPath, query, body }) => client.session.promptAsync({
      sessionID: requestPath.id,
      directory: query.directory,
      parts: body.parts,
    }),
  },
  tui: {
    selectSession: ({ body, query }) => client.tui.selectSession({
      sessionID: body.sessionID,
      directory: query.directory,
    }),
  },
});

export type HandoffRequest = {
  parentID: string;
  directory: string;
  title: string;
  prompt: string;
  stay: boolean;
};

type HandoffData = {
  sessionID?: string;
  seeded?: boolean;
  selected?: boolean;
  stage?: "create" | "seed" | "select";
};

const message = (error: unknown) => error instanceof Error
  ? error.message
  : typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);
const apiError = (response: ApiResponse<unknown> | void) => response?.error;

export async function handoffSession(
  client: HandoffClient,
  request: HandoffRequest,
): Promise<Result<HandoffData>> {
  let sessionID: string | undefined;
  try {
    const created = await client.session.create({
      body: { parentID: request.parentID, title: request.title },
      query: { directory: request.directory },
    });
    if (apiError(created)) throw apiError(created);
    sessionID = created.data?.id;
    if (!sessionID) return fail("session create returned no ID", { stage: "create" });
  } catch (error) {
    return fail(message(error), { stage: "create" });
  }

  try {
    const seeded = await client.session.promptAsync({
      path: { id: sessionID },
      query: { directory: request.directory },
      body: { parts: [{ type: "text", text: request.prompt }] },
    });
    if (apiError(seeded)) throw apiError(seeded);
  } catch (error) {
    return fail(message(error), { sessionID, seeded: false, selected: false, stage: "seed" });
  }

  if (request.stay) return ok({ sessionID, seeded: true, selected: false });

  try {
    const selected = await client.tui.selectSession({
      body: { sessionID },
      query: { directory: request.directory },
    });
    if (apiError(selected)) throw apiError(selected);
    if (selected?.data !== true) throw new Error("session selection unavailable");
    return ok({ sessionID, seeded: true, selected: true });
  } catch (error) {
    return fail(message(error), { sessionID, seeded: true, selected: false, stage: "select" });
  }
}

type RunResult = ReturnType<typeof run>;
export type HandoffRuntime = {
  runScript(root: string, script: string, args: string[]): RunResult;
};

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts");
const defaultRuntime: HandoffRuntime = {
  runScript: (root, script, args) => run(root, path.join(scripts, script), args),
};
const output = (value: unknown) => JSON.stringify(value, null, 2);

const handoffContext = (stdout: string) => {
  const prompt = stdout.match(/^PROMPT_START\n([\s\S]*?)\nPROMPT_END\s*$/)?.[1];
  if (!prompt) throw new Error("handoff context returned no prompt");
  const field = (name: string) => prompt.match(new RegExp(`^\\*\\*${name}:\\*\\*\\s+\`?([^\`\\n]+)`, "m"))?.[1].trim() ?? "";
  const spec = field("Spec");
  const plan = field("Plan");
  const sdd = field("SDD");
  if (!spec || !plan || !sdd) throw new Error("handoff context returned incomplete workflow paths");
  return { prompt, spec, plan, sdd };
};

export function createHandoffTools(
  client: HandoffClient,
  state: WorkflowStateStore,
  runtime: HandoffRuntime = defaultRuntime,
) {
  return {
    workflow_handoff_session: tool({
      description: "Create, seed, and optionally select a continuation session",
      args: { message: tool.schema.string(), stay: tool.schema.boolean().optional() },
      execute: async ({ message: userMessage, stay }, context) => {
        const resolved = runtime.runScript(context.directory, "collect-handoff-context.sh", [userMessage]);
        if (resolved.exitCode !== 0) {
          return output(fail(resolved.stderr.trim() || resolved.stdout.trim() || "handoff context failed"));
        }
        try {
          const active = handoffContext(resolved.stdout);
          state.set(context.sessionID, { spec: active.spec, plan: active.plan, sdd: active.sdd });
          return output(await handoffSession(client, {
            parentID: context.sessionID,
            directory: context.directory,
            title: `Continue ${path.basename(active.plan, ".md")}`,
            prompt: active.prompt,
            stay: stay === true,
          }));
        } catch (error) {
          return output(fail(message(error)));
        }
      },
    }),
  };
}
