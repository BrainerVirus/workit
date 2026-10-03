import { fail, ok, type run } from "@brainervirus/workit-core/src/core";

export type RunResult = ReturnType<typeof run>;

/** Host runtime seam for the confirmed `workit_init_apply` action. */
export type RepoRuntime = {
  initApply(root: string, action: string, env: Record<string, string>): RunResult;
};

export const output = (value: unknown) => JSON.stringify(value, null, 2);

const diagnostics = ({ stdout, stderr, exitCode }: RunResult) => ({
  stdout,
  stderr,
  exitCode,
});

export const requireConfirmed = (confirmed: boolean) => {
  if (confirmed === true) return null;
  return output(fail("confirmed: true required"));
};

export const legacyScriptResult = (result: RunResult) => {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  } catch {
    /* handled below */
  }
  if (result.exitCode !== 0 || parsed?.error || parsed?.ok === false) {
    const error = parsed?.error
      ? String(parsed.error)
      : parsed?.ok === false
        ? "legacy operation reported failure"
        : result.stderr.trim() || result.stdout.trim() || "workflow script failed";
    return fail(error, diagnostics(result));
  }
  if (!parsed) return fail("workflow output parse failed", diagnostics(result));
  const { ok: _legacyOk, ...data } = parsed;
  return ok({ ...data, exitCode: 0, ...(result.stderr ? { stderr: result.stderr } : {}) });
};
