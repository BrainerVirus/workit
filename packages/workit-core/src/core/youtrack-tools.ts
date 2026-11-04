import path from "node:path";
import { fail, ok, type Result } from "../core";
import { configDir } from "./config";
import { configDir as workitConfigDir, userHome } from "./workit-paths.mjs";
import {
  context as legacyContext,
  meetingWorkItemText,
  parseDuration as legacyParseDuration,
  youTrackWorkDateMs,
} from "./youtrack";
import {
  youTrackBackend,
  youTrackWriteGate,
  type WriteResult,
  type YouTrackBackend,
} from "./youtrack-backend";

export const ISSUE_RE = /^[A-Z]+-\d+$/;
export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The config dir comes from core/workit-paths.mjs; default env (no args) routes
// through configDir(), an explicit env resolves with `home` as its HOME.
export const configPath = (env: NodeJS.ProcessEnv = process.env, home = userHome(env)) =>
  path.join(
    env === process.env ? configDir() : workitConfigDir({ ...env, HOME: home }),
    "youtrack.json",
  );

type MaybePromise<T> = T | Promise<T>;
export type LegacyValue = Record<string, unknown> | void;
export type NotApplied = {
  ok: false;
  error: string;
  outcome: "not_applied";
  unblock?: string;
};

export type YouTrackOperations = {
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

/**
 * A write through ytrack (#263), as the legacy value shape, behind the
 * WORKIT_YT_WRITE gate. A failure that surely did not land (gate, missing
 * ytrack, logged out) stays a not_applied value with its unblock; any other
 * failure throws, so callers report an unknown outcome.
 */
async function ytrackWrite(
  write: (backend: YouTrackBackend) => Promise<WriteResult>,
): Promise<LegacyValue> {
  const gate = youTrackWriteGate(process.env);
  if (gate)
    return {
      ok: false,
      error: gate.error,
      outcome: "not_applied",
      unblock: gate.unblock,
    };
  const result = await write(youTrackBackend());
  if (result.ok) return unwrap({ ok: true, data: result.data });
  if (result.outcome === "not_applied")
    return {
      ok: false,
      error: result.error,
      outcome: "not_applied",
      ...(result.unblock ? { unblock: result.unblock } : {}),
    };
  throw new Error(result.error);
}

export const defaultOperations: YouTrackOperations = {
  context: (input) => legacyContext(input as never),
  parseDuration: (text, workspaceRoot) => legacyParseDuration(text, workspaceRoot),
  postComment: (issueId, markdown) =>
    ytrackWrite((backend) => backend.addComment(issueId, markdown)),
  logTime: (input) =>
    ytrackWrite(async (backend) => {
      const date = youTrackWorkDateMs(
        input.dateMs != null ? String(input.dateMs) : String(input.date ?? "auto"),
      );
      if ("error" in date) return { ok: false, error: date.error, outcome: "not_applied" };
      return backend.addWorkItem(String(input.issueId), {
        minutes: Number(input.minutes),
        text: typeof input.text === "string" ? input.text : "workit",
        dateMs: date.data.dateMs,
      });
    }),
};

type PostInput = {
  confirmed: boolean;
  issueId: string;
  markdown: string;
  minutes?: number;
  dateMs?: number;
  workspace_root?: string;
};

type PostData = {
  issueId: string;
  postedComment: boolean;
  loggedMinutes: number;
  outcome?: "unknown" | "not_applied";
  instructions?: string;
  retry?: "youtrack.update" | "youtrack.time";
  unblock?: string;
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
        retry: "youtrack.update",
        ...(comment.unblock ? { unblock: comment.unblock } : {}),
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
        ...(input.dateMs === undefined ? {} : { dateMs: input.dateMs }),
        text: "workit update",
        workspace_root: input.workspace_root,
      });
      if (notApplied(time))
        return fail(time.error, {
          issueId: input.issueId,
          postedComment: true,
          loggedMinutes: 0,
          outcome: "not_applied",
          retry: "youtrack.time",
          ...(time.unblock ? { unblock: time.unblock } : {}),
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
        retry: "youtrack.time",
        ...(value.unblock ? { unblock: value.unblock } : {}),
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
  if (!value || mode !== "meetings" || value.error) return value;
  // Operations may return the legacy `{ data }` envelope; normalize inside it.
  if (value.data && typeof value.data === "object" && !Array.isArray(value.data)) {
    const inner = normalizeContext(value.data as Record<string, unknown>, mode);
    return inner && inner.error
      ? { ...value, ...inner, data: undefined }
      : { ...value, data: inner };
  }
  const config = value.config as Record<string, unknown> | undefined;
  const { meetingIssues: _meetingIssues, ...singleMeetingConfig } = config ?? {};
  const options = Array.isArray(value.meetingOptions)
    ? (value.meetingOptions as Array<Record<string, unknown>>)
    : [];
  // The meeting issue comes only from youtrack.json — there is no built-in one.
  const configured = typeof config?.meetingIssue === "string" ? config.meetingIssue : "";
  const resolved = typeof value.issueId === "string" ? value.issueId : "";
  const firstOption = typeof options[0]?.issue === "string" ? options[0].issue : "";
  const issue = configured || resolved || firstOption;
  if (!issue)
    return {
      ...value,
      error: "no meeting issue configured — set meetingIssue in youtrack.json",
      requiresIssueInput: true,
    };
  const selected = options.find((option) => option.issue === issue) ?? {
    key: "general",
    issue,
    label: issue,
    workItemText: meetingWorkItemText(config),
  };
  return {
    ...value,
    config: singleMeetingConfig,
    meetingOptions: [selected],
    requiresMeetingChoice: false,
    issueId: issue,
    workItemText: meetingWorkItemText(config, selected),
  };
}
