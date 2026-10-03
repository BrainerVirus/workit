import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { configDir, isConfigObject } from "./config";
import { writeFileExclusive } from "./safe-write";
import { applyWorkspaceBranchPolicy } from "./setup";
import { youTrackTokenCreateUrl } from "./youtrack";

const TOKEN_PLACEHOLDER = "YOUR_TOKEN_HERE";

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
  const env = process.env.WORKFLOW_VCS_PROVIDER?.trim();
  if (env) return env.toLowerCase();
  const root = cwd ?? process.env.WORKFLOW_WORKSPACE_ROOT ?? process.cwd();
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
// IDs, mentions, greetings or timezone. The work-item date uses the process
// timezone unless the user adds an explicit `timezone` to youtrack.json.
const youtrackJsonContent = (dir: string): Record<string, any> => {
  const meetingIssue = process.env.WORKFLOW_YT_MEETING_ISSUE;
  return {
    baseUrl: process.env.WORKFLOW_YT_BASE_URL ?? "https://youtrack.example.com",
    tokenFile: process.env.WORKFLOW_YT_TOKEN_FILE ?? path.join(dir, "youtrack.token"),
    ...(meetingIssue
      ? {
          meetingIssue,
          meetingIssues: { general: { issue: meetingIssue, label: "General meetings" } },
        }
      : {}),
    tokenDefaults: {
      name: "workit",
      description: "OpenCode workit — /wk-issue-update and /wk-meetings",
      scopes: ["YouTrack"],
      profileTab: "account-security",
    },
  };
};

const vcsJsonContent = (): Record<string, any> => {
  // Explicit provider at init: env wins, else the checkout's origin remote
  // (same RL-03b rule as vcs-config). Unresolvable means the field is
  // omitted — never a silent assumption downstream.
  const provider = resolveInitProvider();
  return {
    ...(provider ? { provider } : {}),
    defaultTargetBranch: process.env.WORKFLOW_VCS_TARGET_BRANCH ?? "develop",
    gitlab: {
      host: process.env.WORKFLOW_GITLAB_HOST ?? "gitlab.com",
      apiUrl: process.env.WORKFLOW_GITLAB_API_URL ?? "https://gitlab.com/api/v4",
    },
    github: {
      host: process.env.WORKFLOW_GITHUB_HOST ?? "github.com",
    },
    pr: { squashOnMerge: true, removeSourceBranch: true, pushBranch: true, confirmSkip: true },
  };
};

/** Port of scripts/init/apply.sh — confirmed scaffold actions. */
export function initApplyData(
  action: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, any> {
  const dir = String(env.WORKFLOW_TOOLKIT_CONFIG ?? configDir());
  fs.mkdirSync(dir, { recursive: true });

  switch (action) {
    case "youtrack_json": {
      const out = path.join(dir, "youtrack.json");
      fs.writeFileSync(out, JSON.stringify(youtrackJsonContent(dir), null, 2) + "\n", "utf8");
      return { action, ok: true, path: out };
    }
    case "youtrack_token_placeholder": {
      const p = path.join(dir, "youtrack.token");
      // wx + EEXIST-as-preserved (CA-13): an existing real token is never
      // clobbered — shared with the CLI wizard's ensureToken via safe-write.
      const preserved = writeFileExclusive(p, TOKEN_PLACEHOLDER + "\n", 0o600) === "preserved";
      const abs = path.resolve(p);
      return {
        action,
        ok: true,
        path: abs,
        token_edit_path: abs,
        placeholder: TOKEN_PLACEHOLDER,
        preserved,
        instruction: `Open ${abs} in your editor, replace YOUR_TOKEN_HERE with your YouTrack permanent token, save, then run /wk-status`,
      };
    }
    case "youtrack_scaffold": {
      const jsonOut = path.join(dir, "youtrack.json");
      const tokenOut = path.join(dir, "youtrack.token");
      fs.writeFileSync(jsonOut, JSON.stringify(youtrackJsonContent(dir), null, 2) + "\n", "utf8");
      const preserved =
        writeFileExclusive(tokenOut, TOKEN_PLACEHOLDER + "\n", 0o600) === "preserved";
      const configPath = path.resolve(jsonOut);
      const tokenPath = path.resolve(tokenOut);
      const prev = process.env.WORKFLOW_YOUTRACK_CONFIG;
      process.env.WORKFLOW_YOUTRACK_CONFIG = configPath;
      let tokenCreate: Record<string, any> = {};
      try {
        const cfg = readJson(configPath) ?? {};
        const base = String(cfg.baseUrl ?? "").replace(/\/+$/, "");
        const meeting = String(cfg.meetingIssue ?? "");
        tokenCreate = youTrackTokenCreateUrl().data;
        return {
          action,
          ok: true,
          youtrack_json: configPath,
          youtrack_token: tokenPath,
          token_edit_path: tokenPath,
          token_create_url: tokenCreate.createUrl,
          token_create: tokenCreate,
          config_edit_path: configPath,
          placeholder: TOKEN_PLACEHOLDER,
          preserved,
          youtrack_config: {
            config_edit_path: configPath,
            baseUrl: base,
            meetingIssue: meeting,
            meetingIssueUrl: base && meeting ? `${base}/issue/${meeting}` : null,
            locale: cfg.locale,
            tokenCreate,
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
          instruction: `Open the create-token URL, New token → name workit, scope YouTrack, paste into ${tokenPath}, then /wk-status.`,
        };
      } finally {
        if (prev === undefined) delete process.env.WORKFLOW_YOUTRACK_CONFIG;
        else process.env.WORKFLOW_YOUTRACK_CONFIG = prev;
      }
    }
    case "vcs_scaffold": {
      const jsonOut = path.join(dir, "vcs.json");
      fs.writeFileSync(jsonOut, JSON.stringify(vcsJsonContent(), null, 2) + "\n", "utf8");
      const configPath = path.resolve(jsonOut);
      const prev = process.env.WORKFLOW_VCS_CONFIG;
      process.env.WORKFLOW_VCS_CONFIG = configPath;
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
              ? `No provider resolved — set provider to gitlab or github in ${configPath}, then /wk-status.`
              : `Run ${provider === "gitlab" ? "glab" : "gh"} auth login, then /wk-status.`,
        };
      } finally {
        if (prev === undefined) delete process.env.WORKFLOW_VCS_CONFIG;
        else process.env.WORKFLOW_VCS_CONFIG = prev;
      }
    }
    case "branch_policy": {
      const root = env.WORKFLOW_WORKSPACE_ROOT?.trim()
        ? env.WORKFLOW_WORKSPACE_ROOT
        : process.cwd();
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

export { TOKEN_PLACEHOLDER };
