import path from "node:path";
import { tool } from "@opencode-ai/plugin";
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
  message,
  normalizeContext,
  readCredentials,
  redact,
  unwrap,
  type LegacyValue,
  type YouTrackOperations,
} from "@brainervirus/workit-core/src/core/youtrack-tools";

const output = (value: unknown) => JSON.stringify(value, null, 2);
type MaybePromise<T> = T | Promise<T>;

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
      execute: async (input) => invoke(() => legacyBuildDraft(input)),
    }),
  };
}
