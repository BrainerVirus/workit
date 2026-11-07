// The workit CLI the Pi agent's bash tool runs (#648). The extension runs in
// Pi's own process and Pi's bash tool inherits process.env, so applying the
// env changes from core/cli-locate at extension load puts the owned
// launcher's dir first on PATH, ahead of any stale global `workit`. With no
// owned install nothing changes (today's PATH `workit`; `workit doctor` row
// cli_installs names the fix).
import { type LocatedCli, useOwnedWorkitCli } from "@workit-dev/core/src/core/cli-locate";

/** Apply the owned CLI to this process's env; returns what was located. */
export const useOwnedCliInPi = (env: NodeJS.ProcessEnv = process.env): LocatedCli =>
  useOwnedWorkitCli({ env });
