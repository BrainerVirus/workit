import { realpathSync } from "node:fs";
import path from "node:path";
import {
  parseContextRead,
  readExternalContext,
} from "@brainervirus/workit-core/src/core/context-read";
import { failure } from "@brainervirus/workit-core/src/core/task-contract";
import type { NativeTool } from "./workit";

export const createContextTool = (): NativeTool => ({
  description:
    "Read Git, pull request, YouTrack, issue, changelog, release, or affected-file context.",
  execute: async (args, context) => {
    const parsed = parseContextRead(args);
    if (!parsed.ok) return JSON.stringify(parsed, null, 2);
    let root: string;
    try {
      const cwd = parsed.data.cwd;
      root = realpathSync(cwd ? path.resolve(context.directory, cwd) : context.directory);
    } catch {
      return JSON.stringify(
        failure("invalid_input", "context target directory cannot be resolved"),
        null,
        2,
      );
    }
    return JSON.stringify(await readExternalContext(root, parsed.data), null, 2);
  },
});
