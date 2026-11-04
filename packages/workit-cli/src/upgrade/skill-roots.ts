// Each agent host's own user skills directory. Kept apart from upgrade/shared.ts
// so doctor and uninstall can import it without the upgrade machinery.
import path from "node:path";
import { type SkillHost } from "@brainervirus/workit-core/src/core/ytrack-skill";

/** The XDG config base OpenCode reads (its config and skills): XDG_CONFIG_HOME, else ~/.config. */
export const configHome = (home: string, env: NodeJS.ProcessEnv): string =>
  env.XDG_CONFIG_HOME || path.join(home, ".config");

/**
 * Each host's native user skills directory (sources in
 * docs/agents/hosts.md#host-parity): the directory `ytrack skill install
 * --dir` writes `ytrack/` into.
 */
export const hostSkillsRoot = (host: SkillHost, home: string, env: NodeJS.ProcessEnv): string => {
  switch (host) {
    case "claude-code":
      return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "skills");
    case "codex":
      return path.join(env.CODEX_HOME || path.join(home, ".codex"), "skills");
    case "cursor":
      return path.join(home, ".cursor", "skills");
    case "opencode":
      return path.join(configHome(home, env), "opencode", "skills");
    case "pi":
      return path.join(env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent"), "skills");
  }
};
