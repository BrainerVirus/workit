import {
  capabilitiesFor,
  codexAdapter,
  codexDescriptor,
  dispatchHook,
  runHookProcess,
  type CodexHost,
} from "@brainervirus/workit-core/hooks";
import { PROCESS_START } from "@brainervirus/workit-core/src/hooks/deadline";
import { budgetHooks } from "@brainervirus/workit-core/src/hooks/budget-signal";

export {
  detectCodexSurface,
  parseCodexHookInput,
  type CodexHookEvent,
  type CodexHookInput,
  type CodexHost,
} from "@brainervirus/workit-core/hooks";

type Availability = Partial<
  Record<"sessionStart" | "preToolUse" | "subagentStart" | "subagentStop", boolean>
>;

// An override value that is neither Desktop-shaped nor absent is almost
// certainly a spoofed or stale environment: warn loudly on stderr and fall
// back to CLI provenance instead of misclassifying silently.
export function warnOnSurfaceFallback(env: NodeJS.ProcessEnv = process.env): void {
  const override = env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  if (override !== undefined && override !== "Codex Desktop" && !env.CODEX_ELECTRON_RESOURCES_PATH)
    process.stderr.write(
      `[workit] unrecognized CODEX_INTERNAL_ORIGINATOR_OVERRIDE=${JSON.stringify(override)} — treating surface as codex_cli\n`,
    );
}

/** Engine capabilities from the Codex descriptor; only the dispatcher handling
 * an event may attest that its hook ran. */
export const codexCapabilities = (host: CodexHost, availability: Availability = {}) =>
  capabilitiesFor(codexDescriptor(host), {
    "session.start": availability.sessionStart,
    "shell.pre": availability.preToolUse,
    "subagent.start": availability.subagentStart,
    "subagent.stop": availability.subagentStop,
  });

/** Codex counts calls in its launcher, so its adapter carries the tool-call budget (HookDeps.budget). */
const adapter = { ...codexAdapter, budget: budgetHooks };

export const handleCodexHook = (raw: unknown): Record<string, unknown> =>
  dispatchHook(adapter, raw, process.env).json;

export const runCodexHook = async (
  stdin: AsyncIterable<unknown> | Iterable<unknown> = process.stdin,
): Promise<void> => {
  warnOnSurfaceFallback();
  // The adapter itself, not the surface name (HOOK_ADAPTERS carries no budget):
  // the parse still names the surface (codex_cli or codex_desktop) from the env.
  process.exitCode = await runHookProcess(
    adapter,
    stdin,
    process.stdout,
    process.stderr,
    process.env,
    { startedAt: PROCESS_START },
  );
};

if (import.meta.main) await runCodexHook();
