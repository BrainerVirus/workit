// The workit CLI the OpenCode agent's shell runs (#648). The plugin runs in
// OpenCode's own process, so the env changes from core/cli-locate apply to
// every shell OpenCode starts: the owned launcher's dir goes first on PATH,
// ahead of any stale global `workit`. With no owned install nothing changes
// (today's PATH `workit`; `workit doctor` row cli_installs names the fix).
import {
  type LocatedCli,
  locateWorkitCli,
  useOwnedWorkitCli,
  workitCliEnv,
} from "@brainervirus/workit-core/src/core/cli-locate";

/** Apply the owned CLI to this process's env at plugin load; returns what was located. */
export const useOwnedCliInOpencode = (env: NodeJS.ProcessEnv = process.env): LocatedCli =>
  useOwnedWorkitCli({ env });

/** The env a `shell.env` hook adds for one shell call, from the env it would start with. */
export const opencodeShellEnv = (env: NodeJS.ProcessEnv = process.env): Record<string, string> =>
  workitCliEnv(locateWorkitCli({ env }), env);
