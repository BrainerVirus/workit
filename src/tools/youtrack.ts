import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tool, type ToolContext } from "@opencode-ai/plugin";
import { fail, ok, resolveInside, type Result } from "../core";
import { configGuardError, describeConfigGaps } from "../core/config-guard";
import {
  buildDraft as legacyBuildDraft,
  context as legacyContext,
  logTime as legacyLogTime,
  parseDuration as legacyParseDuration,
  parseIssueRef,
  postUpdate as legacyPostUpdate,
  verifyYouTrackToken,
} from "../core/youtrack";

const ISSUE_RE = /^[A-Z]+-\d+$/;
const output = (value: unknown) => JSON.stringify(value, null, 2);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// Both override names point at the config dir itself, same precedence as
// src/core/config.ts and scripts/init/status.sh: WORKFLOW_TOOLKIT_CONFIG → WORKFLOW_TOOLKIT_CONFIG_DIR → XDG.
export const configPath = (env: NodeJS.ProcessEnv = process.env, home = os.homedir()) =>
  path.join(
    env.WORKFLOW_TOOLKIT_CONFIG
    ?? env.WORKFLOW_TOOLKIT_CONFIG_DIR
    ?? path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "workflow-toolkit"),
    "youtrack.json",
  );

export function readCredentials(env: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  const resolvedConfig = configPath(env, home);
  const config = JSON.parse(readFileSync(resolvedConfig, "utf8")) as { tokenFile?: string };
  const tokenFile = config.tokenFile ?? "youtrack.token";
  const tokenPath = path.resolve(path.dirname(resolvedConfig), tokenFile.replace(/^~(?=\/)/, home));
  if (process.platform !== "win32" && (statSync(tokenPath).mode & 0o777) !== 0o600) throw new Error("youtrack.token mode must be 0600");
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!token) throw new Error("youtrack.token is empty");
  return { configPath: resolvedConfig, token };
}

export const redact = (text: string, token: string) =>
  token ? text.split(token).join("[REDACTED]") : text;

type MaybePromise<T> = T | Promise<T>;
type LegacyValue = Record<string, unknown> | void;
export type NotApplied = { ok: false; error: string; outcome: "not_applied" };

export type YouTrackOperations = {
  verifyToken(): MaybePromise<LegacyValue>;
  context(input: Record<string, unknown>): MaybePromise<LegacyValue>;
  parseDuration(text: string, workspaceRoot: string): MaybePromise<LegacyValue>;
  postComment(issueId: string, markdown: string, workspaceRoot?: string): MaybePromise<LegacyValue>;
  logTime(input: Record<string, unknown>): MaybePromise<LegacyValue>;
};

const unwrap = (value: LegacyValue) => {
  if (!value) return {};
  if (value.error) throw new Error(String(value.error));
  if (value.ok === false) throw new Error(String(value.error ?? "YouTrack operation failed"));
  return (value.data as Record<string, unknown> | undefined) ?? value;
};

const defaultOperations: YouTrackOperations = {
  verifyToken: () => unwrap(verifyYouTrackToken()),
  context: (input) => legacyContext(input as never),
  parseDuration: (text, workspaceRoot) => legacyParseDuration(text, workspaceRoot),
  postComment: (issueId, markdown, workspaceRoot) => legacyPostUpdate({
    confirmed: true, issueId, markdown, workspace_root: workspaceRoot,
  } as never),
  logTime: (input) => legacyLogTime(input as never),
};

type PostInput = {
  confirmed: boolean;
  issueId: string;
  markdown: string;
  minutes?: number;
  workspace_root?: string;
};

type PostData = {
  issueId: string;
  postedComment: boolean;
  loggedMinutes: number;
  outcome?: "unknown" | "not_applied";
  instructions?: string;
  retry?: "workflow_youtrack_post" | "workflow_youtrack_log_time";
};

const notApplied = (value: LegacyValue): value is NotApplied =>
  value?.ok === false && value.outcome === "not_applied";

const withWriteFlag = async <T>(fn: () => Promise<T>): Promise<T> => {
  const previous = process.env.WORKFLOW_YT_WRITE;
  process.env.WORKFLOW_YT_WRITE = "1";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_YT_WRITE;
    else process.env.WORKFLOW_YT_WRITE = previous;
  }
};

export async function postUpdate(
  input: PostInput,
  operations: Pick<YouTrackOperations, "postComment" | "logTime"> = defaultOperations,
): Promise<Result<PostData>> {
  if (input.confirmed !== true) return fail("confirmed: true required");
  if (!ISSUE_RE.test(input.issueId)) return fail("invalid issueId");
  if (!input.markdown?.trim()) return fail("markdown required");
  if (input.minutes != null && input.minutes <= 0) return fail("minutes must be positive");

  try {
    const comment = await operations.postComment(input.issueId, input.markdown, input.workspace_root);
    if (notApplied(comment)) return fail(comment.error, {
      issueId: input.issueId, postedComment: false, loggedMinutes: 0,
      outcome: "not_applied", retry: "workflow_youtrack_post",
    });
    unwrap(comment);
  } catch (error) {
    return fail(message(error), {
      issueId: input.issueId, postedComment: false, loggedMinutes: 0, outcome: "unknown",
      instructions: "Check YouTrack comments manually; do not retry while the outcome is unknown.",
    });
  }

  if (input.minutes != null) {
    try {
      const time = await operations.logTime({
        issueId: input.issueId,
        minutes: input.minutes,
        text: "workflow-toolkit update",
        workspace_root: input.workspace_root,
      });
      if (notApplied(time)) return fail(time.error, {
        issueId: input.issueId, postedComment: true, loggedMinutes: 0,
        outcome: "not_applied", retry: "workflow_youtrack_log_time",
      });
      unwrap(time);
    } catch (error) {
      return fail(message(error), {
        issueId: input.issueId, postedComment: true, loggedMinutes: 0, outcome: "unknown",
        instructions: "Check YouTrack time entries manually; do not retry while the outcome is unknown.",
      });
    }
  }

  return ok({
    issueId: input.issueId,
    postedComment: true,
    loggedMinutes: input.minutes ?? 0,
  });
}

export async function logTimeUpdate(
  input: Record<string, unknown>,
  operation: Pick<YouTrackOperations, "logTime"> = defaultOperations,
): Promise<Result<Record<string, unknown>>> {
  try {
    const value = await operation.logTime(input);
    if (notApplied(value)) return fail(value.error, {
      issueId: input.issueId, loggedMinutes: 0, outcome: "not_applied",
      retry: "workflow_youtrack_log_time",
    });
    return ok(unwrap(value));
  } catch (error) {
    return fail(message(error), {
      issueId: input.issueId, loggedMinutes: 0, outcome: "unknown",
      instructions: "Check YouTrack time entries manually; do not retry while the outcome is unknown.",
    });
  }
}

export function normalizeContext(value: LegacyValue, mode?: string): LegacyValue {
  if (!value || mode !== "meetings") return value;
  const config = value.config as Record<string, unknown> | undefined;
  const issue = String(config?.meetingIssue || "IRPT-12");
  const { meetingIssues: _meetingIssues, ...singleMeetingConfig } = config ?? {};
  const options = Array.isArray(value.meetingOptions)
    ? value.meetingOptions as Array<Record<string, unknown>>
    : [];
  const selected = options.find((option) => option.issue === issue) ?? {
    key: "general", issue, label: issue, workItemText: "Reuniones",
  };
  return {
    ...value,
    config: singleMeetingConfig,
    meetingOptions: [selected],
    requiresMeetingChoice: false,
    issueId: issue,
    workItemText: selected.workItemText ?? "Reuniones",
  };
}

const standardResult = (value: LegacyValue, token = "") => {
  try {
    const data = unwrap(value);
    const { ok: _legacyOk, ...normalized } = data;
    return ok(normalized);
  } catch (error) {
    return fail(redact(message(error), token));
  }
};

const invoke = async (operation: () => MaybePromise<LegacyValue>, token = "") => {
  try {
    return output(standardResult(await operation(), token));
  } catch (error) {
    return output(fail(redact(message(error), token)));
  }
};

const credentials = () => readCredentials();
const configGap = () => {
  const { missing } = describeConfigGaps(["youtrack_json", "youtrack_token"]);
  return missing.length > 0 ? output(fail(configGuardError(missing))) : null;
};
const requireConfirmed = (confirmed: boolean) => confirmed === true
  ? null
  : output(fail("confirmed: true required"));

const rejectedTimeInput = (issueId: string, minutes: number) => {
  const error = !ISSUE_RE.test(issueId)
    ? "invalid issueId"
    : !Number.isFinite(minutes) || minutes <= 0
      ? "minutes must be positive"
      : null;
  return error ? output(fail(error, {
    issueId, loggedMinutes: 0, outcome: "not_applied",
    retry: "workflow_youtrack_log_time",
    instructions: "Correct the invalid input, then retry workflow_youtrack_log_time once.",
  })) : null;
};

export function createYouTrackTools(operations: YouTrackOperations = defaultOperations) {
  return {
    workflow_youtrack_verify_token: tool({
      description: "Verify the configured YouTrack token with a read-only request",
      args: {},
      execute: async () => {
        let token = "";
        try { token = credentials().token; } catch (error) {
          const gap = configGap();
          if (gap) return gap;
          return output(fail(message(error)));
        }
        return invoke(() => operations.verifyToken(), token);
      },
    }),
    workflow_youtrack_parse_issue: tool({
      description: "Parse an existing YouTrack issue URL or id",
      args: { issue_ref: tool.schema.string() },
      execute: async ({ issue_ref }) => invoke(() => parseIssueRef(issue_ref)),
    }),
    workflow_youtrack_context: tool({
      description: "Load YouTrack context for the configured meeting issue or an existing task issue",
      args: {
        mode: tool.schema.enum(["meetings", "task"]).optional(),
        issue_id: tool.schema.string().optional(),
        issue_url: tool.schema.string().optional(),
        issue_ref: tool.schema.string().optional(),
        spec_path: tool.schema.string().optional(),
        plan_path: tool.schema.string().optional(),
      },
      execute: async (input, context) => {
        try {
          for (const candidate of [input.spec_path, input.plan_path].filter(Boolean) as string[]) {
            if (path.isAbsolute(candidate)) throw new Error("path must be repository-relative");
            resolveInside(context.directory, candidate);
          }
        } catch (error) {
          const detail = message(error);
          return output(fail(detail.includes("repository-relative") ? detail : `path must be repository-relative: ${detail}`));
        }
        let token = "";
        try { token = credentials().token; } catch (error) {
          const gap = configGap();
          if (gap) return gap;
          return output(fail(message(error)));
        }
        return invoke(async () => normalizeContext(
          await operations.context({ ...input, workspace_root: context.directory }), input.mode,
        ), token);
      },
    }),
    workflow_youtrack_parse_duration: tool({
      description: "Parse duration text into integer minutes",
      args: { text: tool.schema.string() },
      execute: async ({ text }, context) => invoke(() => operations.parseDuration(text, context.directory)),
    }),
    workflow_youtrack_draft: tool({
      description: "Build an es-CL update comment without posting it",
      args: {
        issueId: tool.schema.string(),
        userNotes: tool.schema.string(),
        greeting: tool.schema.string().optional(),
        projectName: tool.schema.string().optional(),
        includeProjectOpener: tool.schema.boolean().optional(),
        includeFacts: tool.schema.boolean().optional(),
        facts: tool.schema.object({
          progress_excerpt: tool.schema.array(tool.schema.string()).optional(),
          git_commits: tool.schema.array(tool.schema.string()).optional(),
        }).optional(),
      },
      execute: async (input) => invoke(() => legacyBuildDraft(input as never)),
    }),
    workflow_youtrack_log_time: tool({
      description: "Log confirmed time on an existing YouTrack issue without posting a comment",
      args: {
        confirmed: tool.schema.boolean(),
        issueId: tool.schema.string(),
        minutes: tool.schema.number(),
        text: tool.schema.string().optional(),
        dateMs: tool.schema.number().optional(),
      },
      execute: async ({ confirmed, ...input }, context: ToolContext) => {
        const rejected = requireConfirmed(confirmed);
        if (rejected) return rejected;
        const invalid = rejectedTimeInput(input.issueId, input.minutes);
        if (invalid) return invalid;
        let token = "";
        try { token = credentials().token; } catch (error) {
          const gap = configGap();
          if (gap) return gap;
          return output(fail(message(error)));
        }
        const result = await withWriteFlag(() =>
          logTimeUpdate({ ...input, workspace_root: context.directory }, operations));
        return output(result.ok ? result : { ...result, error: redact(result.error, token) });
      },
    }),
    workflow_youtrack_post: tool({
      description: "Post a confirmed es-CL comment, then optionally log time",
      args: {
        confirmed: tool.schema.boolean(),
        issueId: tool.schema.string(),
        markdown: tool.schema.string(),
        minutes: tool.schema.number().optional(),
      },
      execute: async (input, context: ToolContext) => {
        const rejected = requireConfirmed(input.confirmed);
        if (rejected) return rejected;
        let token = "";
        try { token = credentials().token; } catch (error) {
          const gap = configGap();
          if (gap) return gap;
          return output(fail(message(error)));
        }
        const result = await withWriteFlag(() =>
          postUpdate({ ...input, workspace_root: context.directory }, operations));
        return output(result.ok ? result : { ...result, error: redact(result.error, token) });
      },
    }),
  };
}
