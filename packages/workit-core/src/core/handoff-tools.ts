import path from "node:path";
import { fail, ok, type Result } from "../core";
import { resolveWorkflowPaths, buildHandoffContract } from "./handoff-context";
import { assetRoot } from "./package-root";
import type { FlowGateResult } from "./flow-state";

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

export type HandoffRequest = {
  directory: string;
  title: string;
  prompt: string;
  stay: boolean;
  /**
   * Destination marking hook (CA-07): invoked only after `promptAsync` succeeds
   * and before any optional selection. The adapter supplies the core
   * `markHandoffDestination` binding so destination state is marked atomically
   * after the child session is seeded — never before creation/seed succeed and
   * never undone by a later selection failure.
   */
  afterSeed?: () => FlowGateResult | Promise<FlowGateResult>;
};

type HandoffData = {
  sessionID?: string;
  seeded?: boolean;
  selected?: boolean;
  stage?: "create" | "seed" | "mark" | "select";
};

export const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : String(error);
export const apiError = (response: ApiResponse<unknown> | void) => response?.error;

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

  if (request.afterSeed) {
    try {
      const marked = await request.afterSeed();
      if (!marked.ok) {
        return fail(marked.error, { sessionID, seeded: true, selected: false, stage: "mark" });
      }
    } catch (error) {
      return fail(message(error), { sessionID, seeded: true, selected: false, stage: "mark" });
    }
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

export type HandoffContextResult =
  | { prompt: string; spec: string; plan: string; sdd: string }
  | { error: string };

export const buildHandoffPrompt = (root: string, message: string): HandoffContextResult => {
  const resolved = resolveWorkflowPaths(root, message);
  if ("error" in resolved) return { error: resolved.error };
  const templatePath = path.join(assetRoot(), "templates", "execution-contract.md");
  const contract = buildHandoffContract({
    root,
    spec: resolved.spec,
    plan: resolved.plan,
    templatePath,
  });
  if ("error" in contract) return { error: contract.error };
  const sdd = `docs/${path.basename(path.dirname(resolved.plan))}/sdd`;
  return { prompt: contract.prompt, spec: resolved.spec, plan: resolved.plan, sdd };
};
