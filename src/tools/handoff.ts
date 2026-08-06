import path from "node:path";
import { fileURLToPath } from "node:url";
import { tool, type PluginInput } from "@opencode-ai/plugin";
import { fail, ok, type Result } from "../core";
import { assertFlowGates } from "../core/flow-state";
import { resolveWorkflowPaths, buildHandoffContract } from "../core/handoff-context";
import { WorkflowStateStore } from "../state";

type ApiResponse<T> = { data?: T; error?: unknown };
type ApiResult<T> = Promise<ApiResponse<T>>;
type ApiVoidResult = Promise<ApiResponse<void> | void>;
type ApiUnknownResult = Promise<ApiResponse<unknown> | void>;

export type HandoffClient = {
  session: {
    create(input: {
      body: { title: string };
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

export const adaptPluginHandoffClient = (client: PluginInput["client"]): HandoffClient => ({
  session: {
    create: (input) => client.session.create(input),
    promptAsync: (input) => client.session.promptAsync(input),
  },
  tui: {
    selectSession: ({ body, query }) => client.tui.publish({
      body: { type: "tui.session.select", properties: { sessionID: body.sessionID } } as never,
      query,
    }),
  },
});

export type HandoffRequest = {
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
      body: { title: request.title },
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

const output = (value: unknown) => JSON.stringify(value, null, 2);

export type HandoffContextResult =
  | { prompt: string; spec: string; plan: string; sdd: string }
  | { error: string };

export const buildHandoffPrompt = (root: string, message: string): HandoffContextResult => {
  const resolved = resolveWorkflowPaths(root, message);
  if ("error" in resolved) return { error: resolved.error };
  const templatePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../templates/execution-contract.md",
  );
  const contract = buildHandoffContract({ root, spec: resolved.spec, plan: resolved.plan, templatePath });
  if ("error" in contract) return { error: contract.error };
  const sdd = `docs/superpowers/sdd/${path.basename(resolved.plan, ".md")}`;
  return { prompt: contract.prompt, spec: resolved.spec, plan: resolved.plan, sdd };
};



export function createHandoffTools(
  client: HandoffClient,
  state: WorkflowStateStore,
) {
  return {
    workflow_handoff_session: tool({
      description: "Create, seed, and select a continuation session; --stay in the message skips selection",
      args: { message: tool.schema.string() },
      execute: async ({ message: userMessage }, context) => {
        const built = buildHandoffPrompt(context.directory, userMessage);
        if ("error" in built) return output(fail(built.error));
        const active = built;
        try {
          const gate = assertFlowGates(context.directory, active.plan);
          if (!gate.ok) return output(fail(gate.error));
          state.set(context.sessionID, { spec: active.spec, plan: active.plan, sdd: active.sdd });
          return output(await handoffSession(client, {
            directory: context.directory,
            title: `Continue ${path.basename(active.plan, ".md")}`,
            prompt: active.prompt,
            stay: /(?:^|\s)--stay(?:\s|$)/.test(userMessage),
          }));
        } catch (error) {
          return output(fail(message(error)));
        }
      },
    }),
  };
}
