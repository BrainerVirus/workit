import {
  capabilitiesFor,
  codexAdapter,
  codexDescriptor,
  detectCodexSurface,
  dispatchHook,
  runHookProcess,
  type CodexHost,
} from "@brainervirus/workit-core/hooks";

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

export const handleCodexHook = (raw: unknown): Record<string, unknown> =>
  dispatchHook(codexAdapter, raw, process.env).json;

export const runCodexHook = async (
  stdin: AsyncIterable<unknown> | Iterable<unknown> = process.stdin,
): Promise<void> => {
  warnOnSurfaceFallback();
  process.exitCode = await runHookProcess(detectCodexSurface(process.env), stdin, process.stdout);
};

if (import.meta.main) await runCodexHook();
