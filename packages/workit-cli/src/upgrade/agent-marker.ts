// The agent-shell marker the user-only verbs check (grant raises, workspace
// seal, the setup wizard's reseal). Kept free of imports so a light module
// such as admin/setup.ts reads it without the grant verb's import graph.

/** Agent hosts that export a marker into the shells they run (best effort). */
const AGENT_ENV = [
  "CLAUDECODE",
  "OPENCODE",
  "CURSOR_AGENT",
  "PI_CODING_AGENT",
  "AI_AGENT",
  "AGENT",
];

export const agentMarker = (env: NodeJS.ProcessEnv): string | undefined =>
  AGENT_ENV.find((name) => env[name]) ??
  Object.keys(env).find((name) => name.startsWith("CODEX_") && env[name]);
