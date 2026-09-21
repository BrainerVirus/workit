import { fail, ok } from "@brainervirus/workit-core/src/core";
import type { RunResult } from "@brainervirus/workit-core/src/core/repo-tools";

export const output = (value: unknown) => JSON.stringify(value, null, 2);

export const diagnostics = ({ stdout, stderr, exitCode }: RunResult) => ({
  stdout,
  stderr,
  exitCode,
});

export const requireConfirmed = (confirmed: boolean) => {
  if (confirmed === true) return null;
  return output(fail("confirmed: true required"));
};

export function scriptResult<T extends object>(result: RunResult, parse: (stdout: string) => T) {
  if (result.exitCode !== 0) {
    return fail(
      result.stderr.trim() || result.stdout.trim() || "workflow script failed",
      diagnostics(result),
    );
  }
  try {
    return ok({
      ...parse(result.stdout),
      exitCode: 0,
      ...(result.stderr ? { stderr: result.stderr } : {}),
    });
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "workflow output parse failed",
      diagnostics(result),
    );
  }
}

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
