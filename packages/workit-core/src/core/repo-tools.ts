import { run } from "../core";

export type RunResult = ReturnType<typeof run>;

/** Host runtime seam for the confirmed `workit_init_apply` action. */
export type RepoRuntime = {
  initApply(root: string, action: string, env: Record<string, string>): RunResult;
};
