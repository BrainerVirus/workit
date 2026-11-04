// `workit setup` and `workit upgrade` install the ytrack agent skill into each
// Workit host's skills directory when YouTrack is in use (youtrack-cli #16).
import {
  configDir as workitConfigDir,
  stateDir as workitStateDir,
} from "@brainervirus/workit-core/src/core/workit-paths.mjs";
import {
  syncYtrackSkill,
  youTrackInUse,
  YTRACK_UPGRADE,
  type SkillHost,
} from "@brainervirus/workit-core/src/core/ytrack-skill";
import { ytrackRunner } from "@brainervirus/workit-core/src/core/youtrack-ytrack";
import path from "node:path";
import { detectHosts } from "../admin/detect-hosts";
import { configHome, type HostOutcome } from "./shared";

const SKILL_HOSTS: readonly SkillHost[] = ["claude-code", "codex", "cursor", "opencode", "pi"];
// `ytrack skill` is offline; a stuck binary still never holds the run long.
const YTRACK_SKILL_TIMEOUT_MS = 30_000;

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

/** The hosts among `among` that have Workit installed. */
export const workitHosts = (
  among: readonly string[],
  home: string,
  env: NodeJS.ProcessEnv,
): SkillHost[] => {
  const found = detectHosts({ home, env });
  return SKILL_HOSTS.filter((host) => among.includes(host) && found[host].configured);
};

/**
 * Install or refresh the ytrack skill for `hosts`, as one `ytrack` result
 * row; null when YouTrack is unused, ytrack is not on PATH (doctor's
 * `youtrack` row says so) or there is no host.
 */
export function refreshYtrackSkill(options: {
  hosts: readonly string[];
  home: string;
  env: NodeJS.ProcessEnv;
}): HostOutcome | null {
  const { env, home } = options;
  const hosts = SKILL_HOSTS.filter((host) => options.hosts.includes(host));
  if (hosts.length === 0 || !youTrackInUse(workitConfigDir(env), env)) return null;
  const sync = syncYtrackSkill({
    roots: hosts.map((host) => ({ host, root: hostSkillsRoot(host, home, env) })),
    stateDir: workitStateDir(env),
    run: ytrackRunner(env, null, YTRACK_SKILL_TIMEOUT_MS),
  });
  if (sync.state === "missing") return null;
  if (sync.state === "unsupported")
    return {
      host: "ytrack",
      status: "skipped",
      reason: `ytrack${sync.version ? ` ${sync.version}` : ""} has no \`ytrack skill\`: the agent skill needs a newer ytrack`,
      fix: YTRACK_UPGRADE,
    };
  const names = (status: string) =>
    sync.results.filter((result) => result.status === status).map((result) => result.host);
  const failed = sync.results.filter((result) => result.status === "failed");
  const installed = names("installed");
  const current = names("current");
  const parts = [
    ...(installed.length ? [`installed for ${installed.join(", ")}`] : []),
    ...(current.length ? [`current for ${current.join(", ")}`] : []),
    ...failed.map((result) => `not installed for ${result.host}: ${result.error}`),
  ];
  const reason = `skill ${sync.version} ${parts.join("; ")}`;
  // A directory ytrack refuses (another skill named ytrack) is the person's
  // to resolve: the row says so without failing the run.
  if (failed.length)
    return {
      host: "ytrack",
      status: "skipped",
      reason,
      fix: failed.map((result) => result.command).join("; "),
    };
  return {
    host: "ytrack",
    status: installed.length ? "updated" : "current",
    reason,
    ...(installed.length
      ? {
          details: sync.results
            .filter((result) => result.status === "installed")
            .map((result) => result.path),
        }
      : {}),
  };
}
