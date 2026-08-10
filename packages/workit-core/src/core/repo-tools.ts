import { fail, ok, run } from "../core";

export type RunResult = ReturnType<typeof run>;

export type RepoRuntime = {
  git(root: string, args: string[]): RunResult;
  verifyProject(root: string, dryRun: boolean): RunResult;
  prContext(root: string, range: string | undefined): RunResult;
  changelogContext(root: string, range: string | undefined): RunResult;
  docsContext(root: string, range: string | undefined): RunResult;
  releaseContext(root: string, range: string): RunResult;
  prCreate(root: string, env: Record<string, string>): RunResult;
  initApply(root: string, action: string, env: Record<string, string>): RunResult;
  initStatus(root: string): RunResult;
  toolkitStatus(root: string): RunResult | Promise<RunResult>;
};

export const normalizeLegacyResult = (value: Record<string, unknown>) => {
  if (value.error) return fail(String(value.error));
  if (value.ok === false) return fail("legacy operation reported failure");
  const { ok: _legacyOk, ...data } = value;
  return ok(data);
};
