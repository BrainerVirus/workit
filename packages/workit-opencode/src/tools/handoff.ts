import path from "node:path";
import { tool, type PluginInput } from "@opencode-ai/plugin";
import { fail } from "@brainervirus/workit-core/src/core";
import {
  assertHandoffReady,
  markHandoffDestination,
  readEffectiveFlowState,
  slugFromPath,
  type FlowGateResult,
} from "@brainervirus/workit-core/src/core/flow-state";
import { WorkflowStateStore } from "@brainervirus/workit-core/src/state";
import {
  buildHandoffPrompt,
  handoffSession,
  message,
  type HandoffClient,
} from "@brainervirus/workit-core/src/core/handoff-tools";

export type { HandoffClient };

export const adaptPluginHandoffClient = (client: PluginInput["client"]): HandoffClient => ({
  session: {
    create: (input) => client.session.create(input),
    promptAsync: (input) => client.session.promptAsync(input),
  },
  tui: {
    selectSession: ({ body, query }) =>
      client.tui.publish({
        body: { type: "tui.session.select", properties: { sessionID: body.sessionID } } as never,
        query,
      }),
  },
});

const output = (value: unknown) => JSON.stringify(value, null, 2);

/**
 * Idempotent adapter-level destination marking (designed edge, Task 3 advisory):
 * core `markHandoffDestination` REJECTS an already-marked flow with
 * `recursive_handoff`, so a re-seed after a selection failure would fail at
 * stage "mark" and leave the retry stuck. If the effective state is already a
 * handoff destination the mark is a no-op success and the retry continues to
 * selection. Core `recursive_handoff` stays authoritative for a genuinely new
 * double-mark attempt: a fresh menu choice is rejected by `recordMenuChoice`
 * (CA-09) and the tool's pre-flight below rejects a fresh handoff on a marked
 * destination before any session is created.
 */
export const idempotentMarkDestination = (
  root: string,
  slug: string,
  planPath: string,
): FlowGateResult => {
  const effective = readEffectiveFlowState(root, slug);
  if (effective.ok && effective.state.handoff_destination) return { ok: true };
  return markHandoffDestination(root, slug, planPath);
};

export function createHandoffTools(client: HandoffClient, state: WorkflowStateStore) {
  return {
    workflow_handoff_session: tool({
      description:
        "Create, seed, and select a continuation session; --stay in the message skips selection",
      args: { message: tool.schema.string() },
      execute: async ({ message: userMessage }, context) => {
        const built = buildHandoffPrompt(context.directory, userMessage);
        if ("error" in built) return output(fail(built.error));
        const active = built;
        const slug = slugFromPath(active.plan);
        try {
          // CA-06/CA-07: shared preflight before ANY session creation — approved
          // docs, menu.presented && chosen === "handoff", not already a
          // destination. Logical failures create no session.
          const ready = assertHandoffReady(context.directory, active.plan);
          if (!ready.ok)
            return output(
              fail(ready.error, { code: (ready as FlowGateResult & { code?: string }).code }),
            );
          state.set(context.sessionID, { spec: active.spec, plan: active.plan, sdd: active.sdd });
          return output(
            await handoffSession(client, {
              directory: context.directory,
              title: `Workit: ${path.basename(path.dirname(active.plan))}`,
              prompt: active.prompt,
              stay: /(?:^|\s)--stay(?:\s|$)/.test(userMessage),
              // CA-07/Task 3: mark the destination ONLY after the child session
              // is seeded successfully and before any selection. A create/seed
              // failure leaves the source flow unmarked and retryable; an
              // already-marked destination is treated idempotently so a retry
              // after a selection failure succeeds instead of dying at the mark.
              afterSeed: () => idempotentMarkDestination(context.directory, slug, active.plan),
            }),
          );
        } catch (error) {
          return output(fail(message(error)));
        }
      },
    }),
  };
}
