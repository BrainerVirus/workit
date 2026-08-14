import path from "node:path";
import { tool, type PluginInput } from "@opencode-ai/plugin";
import { fail } from "@brainervirus/workit-core/src/core";
import {
  assertFlowGates,
  markHandoffDestination,
  slugFromPath,
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
        try {
          const gate = assertFlowGates(context.directory, active.plan);
          if (!gate.ok) return output(fail(gate.error));
          state.set(context.sessionID, { spec: active.spec, plan: active.plan, sdd: active.sdd });
          return output(
            await handoffSession(client, {
              directory: context.directory,
              title: `Continue ${path.basename(path.dirname(active.plan))}`,
              prompt: active.prompt,
              stay: /(?:^|\s)--stay(?:\s|$)/.test(userMessage),
              // CA-07/Task 3: mark the destination ONLY after the child session
              // is seeded successfully and before any selection. A create/seed
              // failure leaves the source flow unmarked and retryable; an
              // already-marked destination rejects with recursive_handoff.
              afterSeed: () =>
                markHandoffDestination(context.directory, slugFromPath(active.plan), active.plan),
            }),
          );
        } catch (error) {
          return output(fail(message(error)));
        }
      },
    }),
  };
}
