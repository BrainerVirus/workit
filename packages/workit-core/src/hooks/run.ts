// Hook-process entry: stdin JSON → parse → handle → render → stdout.
import { dispatchHook } from "./handle";
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
 * payload never throws: the host's fail policy decides what is written. */
export async function runHookProcess(
  host: ProcessHost | HostAdapter,
  stdin: AsyncIterable<unknown> | Iterable<unknown>,
  stdout: Sink,
  stderr: Sink = process.stderr,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const adapter = typeof host === "string" ? HOOK_ADAPTERS[host] : host;
  let text = "";
  for await (const chunk of stdin) text += String(chunk);
  let raw: unknown;
  try {
    raw = JSON.parse(text || "{}");
  } catch {
    raw = undefined;
  }
  const result = dispatchHook(adapter, raw, env);
  if (raw === undefined || result.error)
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
  } else process.exitCode = await runHookProcess(host, process.stdin, process.stdout);
}
