// Hook-process runner for one adapter: stdin JSON → parse → handle → render →
// stdout, under the hook's own deadline (deadline.ts). It names no host, so a
// host bundle that imports it carries only its own adapter (run.ts maps host
// names to every adapter).
import { dispatchWithin, hookBudget, readWithin, skippedHook, type HookDeadline } from "./deadline";
import { recordHookRun } from "./hook-runs";
import type { HostAdapter } from "./protocol";

type Sink = { write(chunk: string): unknown };

/** Runs one hook invocation and returns the process exit code. A broken
 * payload never throws: the host's fail policy decides what is written. Past
 * the deadline the host gets a minimal result naming the skip. `host` is the
 * name the run is recorded under (the adapter's own host by default). */
export async function runAdapterHook(
  adapter: HostAdapter,
  stdin: AsyncIterable<unknown> | Iterable<unknown>,
  stdout: Sink,
  stderr: Sink = process.stderr,
  env: NodeJS.ProcessEnv = process.env,
  deadline: HookDeadline = {},
  host: string = adapter.descriptor.host,
): Promise<number> {
  const budget = hookBudget(env, deadline, adapter.descriptor.host);
  const text = await readWithin(stdin, budget);
  let raw: unknown;
  try {
    raw = text === null ? undefined : JSON.parse(text || "{}");
  } catch {
    raw = undefined;
  }
  const native = (raw as { hook_event_name?: unknown } | null | undefined)?.hook_event_name;
  recordHookRun(host, typeof native === "string" ? native : null, env);
  const result =
    text === null
      ? skippedHook(adapter, undefined, env, budget, "input")
      : await dispatchWithin(adapter, raw, env, budget, deadline.dispatch);
  if (result.skipped) stderr.write(`[workit] ${result.error}\n`);
  else if (raw === undefined || result.error)
    stderr.write(
      `[workit] hook input rejected: ${raw === undefined ? "invalid JSON hook input" : result.error}\n`,
    );
  stdout.write(`${JSON.stringify(result.json)}\n`);
  return result.exitCode;
}
