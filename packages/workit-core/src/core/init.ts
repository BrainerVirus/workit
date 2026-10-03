import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { configDir, isConfigObject } from "./config";
import { PLUGIN_ROOT } from "./scripts";
import { writeFileExclusive } from "./safe-write";
import { resolveWorkspace, workspacesPath } from "./workspaces";
import { applyWorkspaceBranchPolicy } from "./setup";
import { vcsConfig, vcsVerifyToken } from "./vcs-config";
import { youTrackTokenCreateUrl, youTrackVerifyToken } from "./youtrack";

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

const isPlaceholder = (text: string): boolean =>
  text === TOKEN_PLACEHOLDER || text.startsWith(TOKEN_PLACEHOLDER);

const modeOk = (p: string): boolean =>
  process.platform === "win32" || (fs.statSync(p).mode & 0o777) === 0o600;

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

const resolvePath = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Port of scripts/init/status.sh — filesystem init state. */
export function initStatusData(configDirPath = configDir()): Record<string, any> {
  const ytJson = path.join(configDirPath, "youtrack.json");
  const vcsJson = path.join(configDirPath, "vcs.json");
  const items: Array<Record<string, any>> = [];

  let youtrackConfig: Record<string, any> | null = null;
  let youtrackTokenCreate: Record<string, any> | null = null;
  const ytParsed = readJson(ytJson);
  if (ytParsed) {
    const base = String(ytParsed.baseUrl ?? "").replace(/\/+$/, "");
    const meeting = String(ytParsed.meetingIssue ?? "");
    const tokenFile = String(ytParsed.tokenFile ?? "");
    const meetingIssues = [];
    const rawMeetings = (ytParsed.meetingIssues ?? {}) as Record<string, any>;
    if (rawMeetings && typeof rawMeetings === "object") {
      for (const [key, item] of Object.entries(rawMeetings)) {
        const iss = String(item?.issue ?? "");
        meetingIssues.push({
          key,
          issue: iss,
          label: item?.label ?? iss,
          workItemText: item?.workItemText ?? "Reuniones",
          url: item?.url ?? (base && iss ? `${base}/issue/${iss}` : null),
        });
      }
    }
    const expanded = tokenFile ? path.resolve(tokenFile) : null;
    const resolvedTokenFile =
      expanded && fs.existsSync(expanded)
        ? resolvePath(expanded)
        : expanded
          ? path.isAbsolute(expanded)
            ? expanded
            : path.resolve(configDirPath, expanded)
          : null;
    youtrackConfig = {
      config_edit_path: resolvePath(ytJson),
      baseUrl: base,
      meetingIssue: meeting,
      meetingIssues,
      meetingIssueUrl: base && meeting ? `${base}/issue/${meeting}` : null,
      locale: ytParsed.locale,
      tokenFile: resolvedTokenFile,
      tokenDefaults: ytParsed.tokenDefaults,
      timeLogging: {
        meetings: {
          options: meetingIssues,
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
    };
    youtrackTokenCreate = youTrackTokenCreateUrl().data;
    if (youtrackTokenCreate && !(youtrackConfig as Record<string, any>).error) {
      youtrackConfig.tokenCreate = youtrackTokenCreate;
    }
  } else if (fs.existsSync(ytJson)) {
    // Distinguish parse failure (legacy message, path in config_edit_path) from a
    // parseable non-object, which gets the shared shape diagnostic with the path.
    let parseFailed = false;
    try {
      JSON.parse(fs.readFileSync(ytJson, "utf8"));
    } catch {
      parseFailed = true;
    }
    youtrackConfig = {
      config_edit_path: resolvePath(ytJson),
      error: parseFailed ? "invalid youtrack.json" : `${resolvePath(ytJson)} is not a JSON object`,
    };
  }

  items.push({
    id: "youtrack_json",
    label: "YouTrack config",
    ok: fs.existsSync(ytJson) && youtrackConfig !== null && !("error" in youtrackConfig),
    path: fs.existsSync(ytJson) ? resolvePath(ytJson) : path.resolve(ytJson),
    config_edit_path: resolvePath(ytJson),
    fix: "workit_init_apply action=youtrack_scaffold",
  });

  const ytTokenPath = youtrackConfig?.tokenFile ?? path.join(configDirPath, "youtrack.token");
  const tokenText = fs.existsSync(ytTokenPath) ? fs.readFileSync(ytTokenPath, "utf8").trim() : "";
  const placeholder = fs.existsSync(ytTokenPath) && isPlaceholder(tokenText);
  const tokenOk =
    fs.existsSync(ytTokenPath) &&
    modeOk(ytTokenPath) &&
    Boolean(tokenText) &&
    !isPlaceholder(tokenText);

  const youtrackTokenItem: Record<string, any> = {
    id: "youtrack_token",
    label: "YouTrack API token (mode 600, not placeholder)",
    ok: tokenOk,
    path: fs.existsSync(ytTokenPath) ? resolvePath(ytTokenPath) : path.resolve(ytTokenPath),
    token_edit_path: fs.existsSync(ytTokenPath)
      ? resolvePath(ytTokenPath)
      : path.resolve(ytTokenPath),
    placeholder,
    fix: `Open ${resolvePath(ytTokenPath)} — replace ${TOKEN_PLACEHOLDER} with your permanent token, save, then /wk-status`,
  };
  if (youtrackTokenCreate) {
    if (youtrackTokenCreate.createUrl)
      youtrackTokenItem.token_create_url = youtrackTokenCreate.createUrl;
    if (youtrackTokenCreate.docsUrl)
      youtrackTokenItem.token_create_docs_url = youtrackTokenCreate.docsUrl;
    if (youtrackTokenCreate.scopes) youtrackTokenItem.token_scopes = youtrackTokenCreate.scopes;
    if (youtrackTokenCreate.tokenName) youtrackTokenItem.token_name = youtrackTokenCreate.tokenName;
    if (youtrackTokenCreate.steps) youtrackTokenItem.token_create_steps = youtrackTokenCreate.steps;
    youtrackTokenItem.token_prefill_supported = youtrackTokenCreate.prefillSupported ?? false;
  }
  items.push(youtrackTokenItem);

  let vcsCfg: Record<string, any> | null = null;
  const vcsParsed = readJson(vcsJson);
  if (vcsParsed) {
    const rawProvider = vcsParsed.provider;
    const effective = vcsConfig("resolve", process.env.WORKFLOW_WORKSPACE_ROOT ?? process.cwd());
    const provider =
      effective?.ok && typeof effective.provider === "string"
        ? effective.provider
        : typeof rawProvider === "string" && rawProvider.trim()
          ? rawProvider.toLowerCase()
          : null;
    vcsCfg = {
      config_edit_path: resolvePath(vcsJson),
      provider,
      defaultTargetBranch: effective.ok
        ? effective.defaultTargetBranch
        : (vcsParsed.defaultTargetBranch ?? "develop"),
      pr: vcsParsed.pr ?? {},
      gitlab: vcsParsed.gitlab,
      github: vcsParsed.github,
      skill: "/wk-pr",
      switchHint: 'Set "provider" to "gitlab" or "github" in vcs.json',
    };
  } else if (fs.existsSync(vcsJson)) {
    vcsCfg = { config_edit_path: resolvePath(vcsJson), error: "invalid vcs.json" };
  }

  items.push({
    id: "vcs_json",
    label: "VCS config (GitLab / GitHub)",
    ok: fs.existsSync(vcsJson) && vcsCfg !== null && !("error" in vcsCfg),
    path: fs.existsSync(vcsJson) ? resolvePath(vcsJson) : path.resolve(vcsJson),
    config_edit_path: resolvePath(vcsJson),
    fix: "workit_init_apply action=vcs_scaffold",
  });

  return {
    config_dir: configDirPath,
    plugin_root: PLUGIN_ROOT,
    token_placeholder: TOKEN_PLACEHOLDER,
    youtrack_config: youtrackConfig,
    vcs_config: vcsCfg,
    items,
    ready: false,
  };
}

/** Port of scripts/init/toolkit-status.sh — filesystem + API health check. */
export async function toolkitStatusData(configDirPath = configDir()): Promise<Record<string, any>> {
  const status = initStatusData(configDirPath);
  const tokenItem = status.items.find((i: Record<string, any>) => i.id === "youtrack_token") ?? {};
  const placeholder = Boolean(tokenItem.placeholder);

  const vcsCfg = (status.vcs_config ?? {}) as Record<string, any>;
  const provider =
    typeof vcsCfg.provider === "string" && vcsCfg.provider.trim()
      ? vcsCfg.provider.toLowerCase()
      : null;
  const vcsJsonOk = Boolean(status.items.find((i: Record<string, any>) => i.id === "vcs_json")?.ok);

  const verify = placeholder
    ? { ok: false, error: "token still placeholder YOUR_TOKEN_HERE" }
    : await youTrackVerifyToken();
  const vcsVerify =
    provider === null
      ? {
          ok: false,
          error: "vcs provider unconfigured — set provider to gitlab or github in vcs.json",
        }
      : await vcsVerifyToken();
  const youTrackHealth = ("data" in verify ? verify.data : verify) as Record<string, any>;

  status.youtrack_verify = verify;
  status.youtrack_ok = placeholder ? false : Boolean(youTrackHealth.ok);
  status.vcs_verify = vcsVerify;
  status.vcs_ok = vcsJsonOk && Boolean((vcsVerify as Record<string, any>).ok);

  const fsReady = status.items.every((i: Record<string, any>) => i.required === false || i.ok);
  status.ready = fsReady && Boolean(status.youtrack_ok) && (!vcsJsonOk || Boolean(status.vcs_ok));

  if (placeholder) {
    const tokenPath = tokenItem.token_edit_path ?? tokenItem.path ?? "";
    const createUrl = tokenItem.token_create_url ?? status.youtrack_config?.tokenCreate?.createUrl;
    status.token_edit_path = tokenPath;
    if (createUrl) status.token_create_url = createUrl;
    status.next_step = createUrl
      ? "Open the YouTrack create-token URL, New token (name workit, scope YouTrack), paste into the token file, save, then run /wk-status"
      : "Open the YouTrack token file, replace YOUR_TOKEN_HERE, save, then run /wk-status";
  } else if (!status.youtrack_ok) {
    status.next_step = "Fix YouTrack token or re-run /wk-init";
  } else if (vcsJsonOk && !status.vcs_ok) {
    status.next_step = `Run ${provider === "gitlab" ? "glab" : "gh"} auth login/switch, then /wk-status`;
  } else if (status.ready) {
    status.next_step = "All checks passed";
  }
  return status;
}

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

export function initStatus(): Record<string, any> {
  const data = initStatusData();
  const workspaces: Record<string, any> = { path: workspacesPath(), resolved: null };
  try {
    workspaces.resolved = resolveWorkspace(process.cwd());
  } catch (error) {
    workspaces.error = error instanceof Error ? error.message : String(error);
  }
  return {
    ...data,
    workspaces,
  };
}

export async function toolkitStatus(): Promise<Record<string, any>> {
  return toolkitStatusData();
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
