import path from "node:path";
import { tool, type ToolContext } from "@opencode-ai/plugin";
import { fail, ok, resolveInside } from "@brainervirus/workit-core/src/core";
import {
  configGuardError,
  describeConfigGaps,
} from "@brainervirus/workit-core/src/core/config-guard";
import {
  buildDraft as legacyBuildDraft,
  parseIssueRef,
} from "@brainervirus/workit-core/src/core/youtrack";
import {
  defaultOperations,
  logTimeUpdate,
  message,
  normalizeContext,
  postUpdate,
  readCredentials,
  redact,
  unwrap,
  ISSUE_RE,
  type LegacyValue,
  type YouTrackOperations,
} from "@brainervirus/workit-core/src/core/youtrack-tools";

const output = (value: unknown) => JSON.stringify(value, null, 2);
type MaybePromise<T> = T | Promise<T>;

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
const requireConfirmed = (confirmed: boolean) =>
  confirmed === true ? null : output(fail("confirmed: true required"));

const rejectedTimeInput = (issueId: string, minutes: number) => {
  const error = !ISSUE_RE.test(issueId)
    ? "invalid issueId"
    : !Number.isFinite(minutes) || minutes <= 0
      ? "minutes must be positive"
      : null;
  return error
    ? output(
        fail(error, {
          issueId,
          loggedMinutes: 0,
          outcome: "not_applied",
          retry: "workit_youtrack_log_time",
          instructions: "Correct the invalid input, then retry workit_youtrack_log_time once.",
        }),
      )
    : null;
};

export function createYouTrackTools(operations: YouTrackOperations = defaultOperations) {
  return {
    workit_youtrack_verify_token: tool({
      description: "Verify the configured YouTrack token with a read-only request",
      args: {},
      execute: async () => {
        let token = "";
        try {
          token = credentials().token;
        } catch (error) {
          const gap = configGap();
          if (gap) return gap;
          return output(fail(message(error)));
        }
        return invoke(() => operations.verifyToken(), token);
      },
    }),
    workit_youtrack_parse_issue: tool({
      description: "Parse an existing YouTrack issue URL or id",
      args: { issue_ref: tool.schema.string() },
      execute: async ({ issue_ref }) => invoke(() => parseIssueRef(issue_ref)),
    }),
    workit_youtrack_context: tool({
      description:
        "Load YouTrack context for the configured meeting issue or an existing task issue",
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
          return output(
            fail(
              detail.includes("repository-relative")
                ? detail
                : `path must be repository-relative: ${detail}`,
            ),
          );
        }
        let token = "";
        try {
          token = credentials().token;
        } catch (error) {
          const gap = configGap();
          if (gap) return gap;
          return output(fail(message(error)));
        }
        return invoke(
          async () =>
            normalizeContext(
              await operations.context({ ...input, workspace_root: context.directory }),
              input.mode,
            ),
          token,
        );
      },
    }),
    workit_youtrack_parse_duration: tool({
      description: "Parse duration text into integer minutes",
      args: { text: tool.schema.string() },
      execute: async ({ text }, context) =>
        invoke(() => operations.parseDuration(text, context.directory)),
    }),
    workit_youtrack_draft: tool({
      description: "Build an es-CL update comment without posting it",
      args: {
        issueId: tool.schema.string(),
        userNotes: tool.schema.string(),
        greeting: tool.schema.string().optional(),
        projectName: tool.schema.string().optional(),
        includeProjectOpener: tool.schema.boolean().optional(),
        includeFacts: tool.schema.boolean().optional(),
        facts: tool.schema
          .object({
            progress_excerpt: tool.schema.array(tool.schema.string()).optional(),
            git_commits: tool.schema.array(tool.schema.string()).optional(),
          })
          .optional(),
      },
      execute: async (input) => invoke(() => legacyBuildDraft(input as never)),
    }),
    workit_youtrack_log_time: tool({
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
        try {
          token = credentials().token;
        } catch (error) {
          const gap = configGap();
          if (gap) return gap;
          return output(fail(message(error)));
        }
        const result = await withWriteFlag(() =>
          logTimeUpdate({ ...input, workspace_root: context.directory }, operations),
        );
        return output(result.ok ? result : { ...result, error: redact(result.error, token) });
      },
    }),
    workit_youtrack_post: tool({
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
        try {
          token = credentials().token;
        } catch (error) {
          const gap = configGap();
          if (gap) return gap;
          return output(fail(message(error)));
        }
        const result = await withWriteFlag(() =>
          postUpdate({ ...input, workspace_root: context.directory }, operations),
        );
        return output(result.ok ? result : { ...result, error: redact(result.error, token) });
      },
    }),
  };
}
