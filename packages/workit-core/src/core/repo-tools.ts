import { fail, ok, run } from "../core";

type RunResult = ReturnType<typeof run>;

export type RepoRuntime = {
  runScript(root: string, script: string, args: string[], env?: Record<string, string>): RunResult;
  git(root: string, args: string[]): RunResult;
};

export const normalizeLegacyResult = (value: Record<string, unknown>) => {
  if (value.error) return fail(String(value.error));
  if (value.ok === false) return fail("legacy operation reported failure");
  const { ok: _legacyOk, ...data } = value;
  return ok(data);
};
