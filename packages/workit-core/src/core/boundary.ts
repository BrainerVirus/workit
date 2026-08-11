import type { JsonValue } from "./logger";

// Named diagnostic boundary events (DG-04) shared by all adapters so event
// names stay consolidated across OpenCode, Cursor, and the CLI.
export const EVENT = {
  initialization: "initialization",
  provenance: "provenance",
  assets: "assets",
  configurationSource: "configuration_source",
  hooks: "hooks",
  mcpConnection: "mcp_connection",
  migration: "migration",
  installSteps: "install_steps",
  uncaughtFailure: "uncaught_failure",
  toolsFailed: "tools_failed",
  doctor: "doctor",
} as const;

// Safe error metadata for log events: name + message only. The message passes
// through the logger's value redaction (tokens, key=value secrets, URL queries,
// home prefixes); the raw stack never enters a context.
export const errorDetail = (err: unknown): Record<string, JsonValue> => {
  if (err instanceof Error) {
    return { error_name: err.name, error: err.message };
  }
  return { error_name: "unknown", error: String(err) };
};
