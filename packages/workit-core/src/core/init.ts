import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { configDir, isConfigObject } from "./config";
import { applyWorkspaceBranchPolicy } from "./workspace-branch-policy";
import {
  findYtrack,
  ytrackLogin,
  ytrackMissingUnblock,
  ytrackReadiness,
  ytrackRunner,
} from "./youtrack-ytrack";

// AR-07/CA-37: a parseable non-object (null, scalar, array) is not a config
// file — never display it as configured (fail-open) nor as unconfigured.
const readJson = (p: string): Record<string, any> | null => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
    return isConfigObject(parsed) ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
};

/** Provider for a fresh vcs.json: explicit env, else origin remote, else null
 *  (no silent default — a tool for everyone must not assume a provider). */
export const resolveInitProvider = (cwd?: string): string | null => {
  const env = process.env.WORKIT_VCS_PROVIDER?.trim();
  if (env) return env.toLowerCase();
  const root = cwd ?? process.env.WORKIT_WORKSPACE_ROOT ?? process.cwd();
  try {
    const out = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
    });
    if (out.status === 0) {
      const url = (out.stdout ?? "").trim();
      if (/github\.com[:/]/.test(url)) return "github";
      if (/gitlab\.com[:/]/.test(url)) return "gitlab";
    }
  } catch {
    /* no git: unresolvable, caller omits the field */
  }
  return null;
};

// Port of scripts/init/apply.sh write_youtrack_json — env overrides honored.
// Neutral draft (same shape as the setup wizard's): no organization URL, issue
// IDs, mentions, greetings or timezone, and no token: YouTrack goes through
// ytrack, which keeps its own token in the OS keyring. The work-item date uses
// the process timezone unless the user adds an explicit `timezone`.
const youtrackJsonContent = (): Record<string, any> => {
  const meetingIssue = process.env.WORKIT_YT_MEETING_ISSUE;
  return {
    baseUrl: process.env.WORKIT_YT_BASE_URL ?? "https://youtrack.example.com",
    ...(meetingIssue
      ? {
          meetingIssue,
          meetingIssues: { general: { issue: meetingIssue, label: "General meetings" } },
        }
      : {}),
  };
};

/** ytrack's state for youtrack.json's baseUrl: what the init result reports. */
const ytrackCheck = (env: NodeJS.ProcessEnv, baseUrl: string): Record<string, any> => {
  const host = baseUrl || null;
  const ready = ytrackReadiness(ytrackRunner(env, host), host);
  return ready.ok
    ? { ok: true, version: ready.version, login: ready.login }
    : {
        ok: false,
        reason: ready.reason,
        error: ready.error,
        unblock: ready.unblock,
      };
};

const vcsJsonContent = (): Record<string, any> => {
  // Explicit provider at init: env wins, else the checkout's origin remote
  // (same RL-03b rule as vcs-config). Unresolvable means the field is
  // omitted — never a silent assumption downstream.
  const provider = resolveInitProvider();
  return {
    ...(provider ? { provider } : {}),
    defaultTargetBranch: process.env.WORKIT_VCS_TARGET_BRANCH ?? "develop",
    gitlab: {
      host: process.env.WORKIT_GITLAB_HOST ?? "gitlab.com",
      apiUrl: process.env.WORKIT_GITLAB_API_URL ?? "https://gitlab.com/api/v4",
    },
    github: {
      host: process.env.WORKIT_GITHUB_HOST ?? "github.com",
    },
    pr: { squashOnMerge: true, removeSourceBranch: true, pushBranch: true, confirmSkip: true },
  };
};

/** Port of scripts/init/apply.sh — confirmed scaffold actions. */
export function initApplyData(
  action: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, any> {
  const dir = String(env.WORKIT_CONFIG ?? configDir());
  fs.mkdirSync(dir, { recursive: true });

  switch (action) {
    case "youtrack_json": {
      const out = path.join(dir, "youtrack.json");
      fs.writeFileSync(out, JSON.stringify(youtrackJsonContent(), null, 2) + "\n", "utf8");
      return { action, ok: true, path: out };
    }
    case "youtrack_token_placeholder": {
      // Kept as a name so an older host's call gets a clear answer, not "unknown action".
      return {
        action,
        ok: false,
        error:
          "Workit no longer uses a YouTrack token file: YouTrack goes through ytrack, which keeps its token in the OS keyring",
        unblock: findYtrack(env) ? ytrackLogin(null) : ytrackMissingUnblock(null),
      };
    }
    case "youtrack_scaffold": {
      const jsonOut = path.join(dir, "youtrack.json");
      fs.writeFileSync(jsonOut, JSON.stringify(youtrackJsonContent(), null, 2) + "\n", "utf8");
      const configPath = path.resolve(jsonOut);
      const cfg = readJson(configPath) ?? {};
      const base = String(cfg.baseUrl ?? "").replace(/\/+$/, "");
      const meeting = String(cfg.meetingIssue ?? "");
      const ytrack = ytrackCheck(env, base);
      return {
        action,
        ok: true,
        youtrack_json: configPath,
        config_edit_path: configPath,
        ytrack,
        youtrack_config: {
          config_edit_path: configPath,
          baseUrl: base,
          meetingIssue: meeting,
          meetingIssueUrl: base && meeting ? `${base}/issue/${meeting}` : null,
          locale: cfg.locale,
          timeLogging: {
            meetings: {
              issue: meeting,
              skill: "/wk-meetings",
              logsTime: true,
              postsComment: false,
            },
            taskWork: {
              issueSource: "active spec/plan **YouTrack:** field or --issue",
              skill: "/wk-issue-update",
              logsTime: true,
              postsComment: true,
            },
          },
        },
        instruction: ytrack.ok
          ? `Set baseUrl in ${configPath} if needed; ytrack is logged in, so \`workit doctor\` should pass.`
          : `Set baseUrl in ${configPath}, then ${ytrack.unblock}, then \`workit doctor\`.`,
      };
    }
    case "vcs_scaffold": {
      const jsonOut = path.join(dir, "vcs.json");
      fs.writeFileSync(jsonOut, JSON.stringify(vcsJsonContent(), null, 2) + "\n", "utf8");
      const configPath = path.resolve(jsonOut);
      const prev = process.env.WORKIT_VCS_CONFIG;
      process.env.WORKIT_VCS_CONFIG = configPath;
      try {
        const cfg = readJson(configPath) ?? {};
        const rawProvider = cfg.provider;
        const provider = typeof rawProvider === "string" && rawProvider.trim() ? rawProvider : null;
        return {
          action,
          ok: true,
          vcs_json: configPath,
          config_edit_path: configPath,
          vcs_config: {
            config_edit_path: configPath,
            provider,
            defaultTargetBranch: cfg.defaultTargetBranch,
            pr: cfg.pr,
            switchHint: 'Change "provider" to "github" when you migrate; authenticate with gh/glab',
            skill: "/wk-pr",
          },
          instruction:
            provider === null
              ? `No provider resolved — set provider to gitlab or github in ${configPath}, then \`workit doctor\`.`
              : `Run ${provider === "gitlab" ? "glab" : "gh"} auth login, then \`workit doctor\`.`,
        };
      } finally {
        if (prev === undefined) delete process.env.WORKIT_VCS_CONFIG;
        else process.env.WORKIT_VCS_CONFIG = prev;
      }
    }
    case "branch_policy": {
      const root = env.WORKIT_WORKSPACE_ROOT?.trim() ? env.WORKIT_WORKSPACE_ROOT : process.cwd();
      return applyWorkspaceBranchPolicy({ workspace_root: root, env });
    }
    default: {
      return {
        error: `unknown action ${action} (youtrack_scaffold|youtrack_json|youtrack_token_placeholder|vcs_scaffold)`,
      };
    }
  }
}

export function initApply({
  action,
  confirmed,
  env,
}: {
  action: string;
  confirmed: boolean;
  env?: Record<string, string>;
}): Record<string, any> {
  if (!confirmed) return { error: "confirmed: true required" };
  return { data: initApplyData(action, env ? { ...process.env, ...env } : process.env) };
}
