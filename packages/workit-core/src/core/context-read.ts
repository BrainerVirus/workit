// Read-only repository and provider context (`workit_context` on OpenCode,
// Pi and MCP). A read needs no grant: it changes nothing locally or remotely.
import * as z from "zod";
import {
  changelogContext,
  docsRefreshContext,
  isSafeContextRange,
  prReadyContext,
  releaseNotesContext,
} from "./repo-context";
import { gitContext } from "./git";
import { fetchGitHubIssueBody, fetchGitLabIssueBody } from "./tracker-issues";
import { context as youTrackContext, fetchYouTrackIssueBody } from "./youtrack";
import { failure, success, type Result } from "./task-contract";

export const contextReadSchema = z
  .object({
    kind: z.enum([
      "git",
      "pr",
      "youtrack",
      "github_issue",
      "gitlab_issue",
      "changelog",
      "release",
      "affected",
    ]),
    range: z.string().optional(),
    issueId: z.string().optional(),
    issueUrl: z.string().optional(),
    issueRef: z.string().optional(),
    mode: z.string().optional(),
    specPath: z.string().optional(),
    planPath: z.string().optional(),
    cwd: z.string().min(1).optional(),
  })
  .strict();
export type ContextReadPayload = z.infer<typeof contextReadSchema>;

/** The tool input schema hosts register for `workit_context`. */
export const contextReadJsonSchema = (): Record<string, unknown> => {
  const { $schema: _schema, ...schema } = z.toJSONSchema(contextReadSchema, {
    target: "draft-2020-12",
  }) as Record<string, unknown>;
  return schema;
};

export const parseContextRead = (value: unknown): Result<ContextReadPayload> => {
  const parsed = contextReadSchema.safeParse(value);
  return parsed.success
    ? success(null, null, parsed.data)
    : failure("invalid_input", "context payload is invalid", {
        fields: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          reason: issue.message,
        })),
      });
};

/** Read one fixed repository/provider context without approval or mutation. */
export const readExternalContext = async (
  root: string,
  payload: ContextReadPayload,
): Promise<Result<unknown>> => {
  if (payload.range !== undefined && !isSafeContextRange(payload.range))
    return failure("invalid_input", "revision range is invalid", {
      fields: [{ path: "range", reason: "option-like or control characters are not allowed" }],
    });
  const render = (result: { stdout: string; stderr: string; exitCode: number; cwd: string }) =>
    result.exitCode === 0
      ? success(null, null, { kind: payload.kind, context: result.stdout })
      : failure("capability_unavailable", "requested context is unavailable", {
          capability: payload.kind,
        });
  switch (payload.kind) {
    case "git": {
      const context = gitContext(root);
      return typeof context.exitCode === "number" && context.exitCode !== 0
        ? failure("capability_unavailable", "Git context is unavailable", { capability: "git" })
        : success(null, null, { kind: payload.kind, context });
    }
    case "pr":
      return render(prReadyContext(root, payload.range));
    case "changelog":
      return render(changelogContext(root, payload.range));
    case "release":
      return render(releaseNotesContext(root, payload.range ?? "HEAD~1...HEAD"));
    case "affected":
      return render(docsRefreshContext(root, payload.range));
    case "youtrack": {
      const value = youTrackContext({
        workspace_root: root,
        ...(payload.specPath ? { spec_path: payload.specPath } : {}),
        ...(payload.planPath ? { plan_path: payload.planPath } : {}),
        ...(payload.issueId ? { issue_id: payload.issueId } : {}),
        ...(payload.issueUrl ? { issue_url: payload.issueUrl } : {}),
        ...(payload.issueRef ? { issue_ref: payload.issueRef } : {}),
        ...(payload.mode ? { mode: payload.mode } : {}),
      });
      if (value && typeof value === "object" && "error" in value)
        return failure("capability_unavailable", "YouTrack context is unavailable", {
          capability: "youtrack",
        });
      if (value.requiresMeetingChoice || !value.issueId)
        return success(null, null, { kind: payload.kind, context: value });
      const body = await fetchYouTrackIssueBody(value.issueId);
      if ("error" in body && body.kind === "request")
        return failure("capability_unavailable", "YouTrack issue body is unavailable", {
          capability: "youtrack",
        });
      return success(null, null, {
        kind: payload.kind,
        context: {
          ...value,
          ...("data" in body
            ? { issueBody: body.data }
            : { issueBody: null, issueBodyError: body.error }),
        },
      });
    }
    case "github_issue": {
      const ref = payload.issueId ?? payload.issueUrl ?? payload.issueRef;
      if (!ref)
        return failure("invalid_input", "github_issue needs issueId, issueUrl, or issueRef");
      const body = await fetchGitHubIssueBody(ref, root);
      if ("error" in body)
        return failure("capability_unavailable", `GitHub issue is unavailable: ${body.error}`, {
          capability: "github_issue",
        });
      return success(null, null, { kind: payload.kind, context: { issueBody: body.data } });
    }
    case "gitlab_issue": {
      const ref = payload.issueId ?? payload.issueUrl ?? payload.issueRef;
      if (!ref)
        return failure("invalid_input", "gitlab_issue needs issueId, issueUrl, or issueRef");
      const body = await fetchGitLabIssueBody(ref, root);
      if ("error" in body)
        return failure("capability_unavailable", `GitLab issue is unavailable: ${body.error}`, {
          capability: "gitlab_issue",
        });
      return success(null, null, { kind: payload.kind, context: { issueBody: body.data } });
    }
  }
};
