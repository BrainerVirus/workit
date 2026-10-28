// Hook-process entry by host name: maps each process host to its adapter and
// runs it (process.ts). Host bundles import process.ts with their own adapter,
// so they carry none of the others.
import { PROCESS_START, type HookDeadline } from "./deadline";
import { claudeCodeAdapter } from "./hosts/claude-code";
import { codexAdapter } from "./hosts/codex";
import { cursorAdapter } from "./hosts/cursor";
import { runAdapterHook } from "./process";
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
export const runHookProcess = (
  host: ProcessHost | HostAdapter,
  stdin: AsyncIterable<unknown> | Iterable<unknown>,
  stdout: Sink,
  stderr: Sink = process.stderr,
  env: NodeJS.ProcessEnv = process.env,
  deadline: HookDeadline = {},
): Promise<number> =>
  typeof host === "string"
    ? runAdapterHook(HOOK_ADAPTERS[host], stdin, stdout, stderr, env, deadline, host)
    : runAdapterHook(host, stdin, stdout, stderr, env, deadline);

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
