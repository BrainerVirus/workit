// Hook-process entry: stdin JSON → parse → handle → render → stdout, under
// the hook's own deadline (deadline.ts).
import {
  dispatchWithin,
  hookBudget,
  PROCESS_START,
  readWithin,
  skippedHook,
  type HookDeadline,
} from "./deadline";
import { claudeCodeAdapter } from "./hosts/claude-code";
import { codexAdapter } from "./hosts/codex";
import { cursorAdapter } from "./hosts/cursor";
import type { HostAdapter, HostId } from "./protocol";

type ProcessHost = Exclude<HostId, "opencode" | "pi">;

export const HOOK_ADAPTERS: Record<ProcessHost, HostAdapter> = {
  claude_code: claudeCodeAdapter,
  codex_cli: codexAdapter,
  codex_desktop: codexAdapter,
  cursor: cursorAdapter,
};

type Sink = { write(chunk: string): unknown };

/** Runs one hook invocation and returns the process exit code. A broken
 * payload never throws: the host's fail policy decides what is written. Past
 * the deadline the host gets a minimal result naming the skip. */
export async function runHookProcess(
  host: ProcessHost | HostAdapter,
  stdin: AsyncIterable<unknown> | Iterable<unknown>,
  stdout: Sink,
  stderr: Sink = process.stderr,
  env: NodeJS.ProcessEnv = process.env,
  deadline: HookDeadline = {},
): Promise<number> {
  const adapter = typeof host === "string" ? HOOK_ADAPTERS[host] : host;
  const budget = hookBudget(env, deadline);
  const text = await readWithin(stdin, budget);
  let raw: unknown;
  try {
    raw = text === null ? undefined : JSON.parse(text || "{}");
  } catch {
    raw = undefined;
  }
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

if (import.meta.main) {
  const host = process.argv[2] as ProcessHost;
  if (!Object.hasOwn(HOOK_ADAPTERS, host)) {
    process.stderr.write(`usage: run.ts <${Object.keys(HOOK_ADAPTERS).join("|")}>\n`);
    process.exitCode = 64;
  } else {
    process.exitCode = await runHookProcess(
      host,
      process.stdin,
      process.stdout,
      process.stderr,
      process.env,
      { startedAt: PROCESS_START },
    );
    // A payload that never ended must not keep the process alive past its answer.
    process.stdin.destroy();
  }
}
