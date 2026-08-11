import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fail, ok, type Result } from "../core";
import { configDir, isConfigObject } from "./config";
import {
  context as legacyContext,
  logTime as legacyLogTime,
  parseDuration as legacyParseDuration,
  postUpdate as legacyPostUpdate,
  verifyYouTrackToken,
} from "./youtrack";

export const ISSUE_RE = /^[A-Z]+-\d+$/;
export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Both override names point at the config dir itself, same precedence as
// src/core/config.ts and scripts/init/status.sh: WORKFLOW_TOOLKIT_CONFIG → WORKFLOW_TOOLKIT_CONFIG_DIR → XDG.
// Default env (no args) routes through configDir() so the legacy migration runs.
export const configPath = (env: NodeJS.ProcessEnv = process.env, home = os.homedir()) =>
  path.join(
    env === process.env
      ? configDir()
      : (env.WORKFLOW_TOOLKIT_CONFIG ??
          env.WORKFLOW_TOOLKIT_CONFIG_DIR ??
          path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "workit")),
    "youtrack.json",
  );

export function readCredentials(env: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  const resolvedConfig = configPath(env, home);
  // AR-07/CA-37: a parseable non-object youtrack.json is malformed — exact-path
  // error, never a raw TypeError or a silent tokenFile default.
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvedConfig, "utf8"));
  } catch {
    throw new Error(`${resolvedConfig} is not valid JSON`);
  }
  if (!isConfigObject(parsed)) {
    throw new Error(`${resolvedConfig} is not a JSON object`);
  }
  const config = parsed as { tokenFile?: string };
  const tokenFile = config.tokenFile ?? "youtrack.token";
  const tokenPath = path.resolve(path.dirname(resolvedConfig), tokenFile.replace(/^~(?=\/)/, home));
  if (process.platform !== "win32" && (statSync(tokenPath).mode & 0o777) !== 0o600)
    throw new Error("youtrack.token mode must be 0600");
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!token) throw new Error("youtrack.token is empty");
  return { configPath: resolvedConfig, token };
}

export const redact = (text: string, token: string) =>
  token ? text.split(token).join("[REDACTED]") : text;

type MaybePromise<T> = T | Promise<T>;
export type LegacyValue = Record<string, unknown> | void;
export type NotApplied = { ok: false; error: string; outcome: "not_applied" };

export type YouTrackOperations = {
  verifyToken(): MaybePromise<LegacyValue>;
  context(input: Record<string, unknown>): MaybePromise<LegacyValue>;
  parseDuration(text: string, workspaceRoot: string): MaybePromise<LegacyValue>;
  postComment(issueId: string, markdown: string, workspaceRoot?: string): MaybePromise<LegacyValue>;
  logTime(input: Record<string, unknown>): MaybePromise<LegacyValue>;
};

export const unwrap = (value: LegacyValue) => {
  if (!value) return {};
  if (value.error) throw new Error(String(value.error));
  if (value.ok === false) throw new Error(String(value.error ?? "YouTrack operation failed"));
  return (value.data as Record<string, unknown> | undefined) ?? value;
};

export const defaultOperations: YouTrackOperations = {
  verifyToken: () => unwrap(verifyYouTrackToken()),
  context: (input) => legacyContext(input as never),
  parseDuration: (text, workspaceRoot) => legacyParseDuration(text, workspaceRoot),
  postComment: async (issueId, markdown, workspaceRoot) =>
    unwrap(
      await legacyPostUpdate({
        confirmed: true,
        issueId,
        markdown,
        workspace_root: workspaceRoot,
      } as never),
    ),
  logTime: async (input) => unwrap(await legacyLogTime(input as never)),
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

export async function postUpdate(
  input: PostInput,
  operations: Pick<YouTrackOperations, "postComment" | "logTime"> = defaultOperations,
): Promise<Result<PostData>> {
  if (input.confirmed !== true) return fail("confirmed: true required");
  if (!ISSUE_RE.test(input.issueId)) return fail("invalid issueId");
  if (!input.markdown?.trim()) return fail("markdown required");
  if (input.minutes != null && input.minutes <= 0) return fail("minutes must be positive");

  try {
    const comment = await operations.postComment(
      input.issueId,
      input.markdown,
      input.workspace_root,
    );
    if (notApplied(comment))
      return fail(comment.error, {
        issueId: input.issueId,
        postedComment: false,
        loggedMinutes: 0,
        outcome: "not_applied",
        retry: "workflow_youtrack_post",
      });
    unwrap(comment);
  } catch (error) {
    return fail(message(error), {
      issueId: input.issueId,
      postedComment: false,
      loggedMinutes: 0,
      outcome: "unknown",
      instructions: "Check YouTrack comments manually; do not retry while the outcome is unknown.",
    });
  }

  if (input.minutes != null) {
    try {
      const time = await operations.logTime({
        issueId: input.issueId,
        minutes: input.minutes,
        text: "workit update",
        workspace_root: input.workspace_root,
      });
      if (notApplied(time))
        return fail(time.error, {
          issueId: input.issueId,
          postedComment: true,
          loggedMinutes: 0,
          outcome: "not_applied",
          retry: "workflow_youtrack_log_time",
        });
      unwrap(time);
    } catch (error) {
      return fail(message(error), {
        issueId: input.issueId,
        postedComment: true,
        loggedMinutes: 0,
        outcome: "unknown",
        instructions:
          "Check YouTrack time entries manually; do not retry while the outcome is unknown.",
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
    if (notApplied(value))
      return fail(value.error, {
        issueId: input.issueId,
        loggedMinutes: 0,
        outcome: "not_applied",
        retry: "workflow_youtrack_log_time",
      });
    return ok(unwrap(value));
  } catch (error) {
    return fail(message(error), {
      issueId: input.issueId,
      loggedMinutes: 0,
      outcome: "unknown",
      instructions:
        "Check YouTrack time entries manually; do not retry while the outcome is unknown.",
    });
  }
}

export function normalizeContext(value: LegacyValue, mode?: string): LegacyValue {
  if (!value || mode !== "meetings") return value;
  const config = value.config as Record<string, unknown> | undefined;
  const issue = String(config?.meetingIssue || "IRPT-12");
  const { meetingIssues: _meetingIssues, ...singleMeetingConfig } = config ?? {};
  const options = Array.isArray(value.meetingOptions)
    ? (value.meetingOptions as Array<Record<string, unknown>>)
    : [];
  const selected = options.find((option) => option.issue === issue) ?? {
    key: "general",
    issue,
    label: issue,
    workItemText: "Reuniones",
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
