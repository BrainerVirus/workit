import { realpathSync } from "node:fs";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";
import {
  externalActionRequest,
  externalActionSchema,
} from "@brainervirus/workit-core/src/core/external-action";
import type { ExternalActionRequest } from "@brainervirus/workit-core/src/core/external-action";
import { failure } from "@brainervirus/workit-core/src/core/task-contract";
import { readExternalContext } from "@brainervirus/workit-core/src/core/external-action-effects";

const contextVariant = externalActionSchema.options.find(
  (variant) => variant.shape.operation.value === "context.read",
)! as any;
type ContextPayload = Extract<ExternalActionRequest, { operation: "context.read" }>["payload"];

export const createContextTool = () =>
  tool({
    description:
      "Read Git, pull request, YouTrack, issue, changelog, release, or affected-file context.",
    args: contextVariant.shape.payload.shape,
    execute: async (args, context) => {
      const parsed = externalActionRequest({ operation: "context.read", payload: args });
      if (!parsed.ok) return JSON.stringify(parsed, null, 2);
      let root: string;
      try {
        const payload = parsed.data.payload as ContextPayload;
        const cwd = payload.cwd;
        root = realpathSync(cwd ? path.resolve(context.directory, cwd) : context.directory);
      } catch {
        return JSON.stringify(
          failure("invalid_input", "action target directory cannot be resolved", {
            outcome: "not_started",
          }),
          null,
          2,
        );
      }
      return JSON.stringify(
        await readExternalContext(root, parsed.data.payload as ContextPayload),
        null,
        2,
      );
    },
  });
