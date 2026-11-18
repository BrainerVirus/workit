import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fail, ok, type Result } from "../core";
import { configDir } from "./config";
import { resolveStateDir } from "./logger";
import { writeFileAtomic } from "./safe-write";
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
import {
  youTrackCommentApproval,
  youTrackTimeApproval,
  youTrackWritesMode,
  withoutMarker,
} from "./youtrack-writes";
import {
  approveLine,
  consumeApproval,
  createApprovalRequest,
  type ApprovalFields,
} from "../approvals/store";

/** A YouTrack issue id: a project short name (a letter, then letters, digits or `_`), a dash, a number. */
export const ISSUE_RE = /^[A-Z][A-Z0-9_]*-\d+$/;
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
  /** The approval request the user's yes is needed for (youtrack.writes ask). */
  approval?: string;
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
 * A write through ytrack (#263), as the legacy value shape. It asks first
 * like `workit youtrack note|time` (#780): with `youtrack.writes` ask (the
 * default) it consumes the user's yes for `fields`, else records the request
 * and posts nothing; with `auto` it keeps the WORKIT_YT_WRITE gate. A failure
 * that surely did not land (no yes, gate, missing ytrack, logged out) stays a
 * not_applied value with its unblock; any other failure throws, so callers
 * report an unknown outcome.
 */
async function ytrackWrite(
  ask: { cwd: string; fields: ApprovalFields },
  write: (backend: YouTrackBackend) => Promise<WriteResult>,
): Promise<LegacyValue> {
  if (youTrackWritesMode(ask.cwd) === "ask") {
    const session = process.env.WORKIT_SESSION_ID || null;
    const used = consumeApproval(ask.fields, { session, verb: "youtrack write" });
    if (!used.ok) {
      const request = used.request ?? createApprovalRequest(ask.fields, { session });
      return {
        ok: false,
        error: `${used.code}: nothing was posted`,
        outcome: "not_applied",
        unblock: approveLine(request),
        approval: request.id,
      };
    }
  } else {
    const gate = youTrackWriteGate(process.env);
    if (gate)
      return {
        ok: false,
        error: gate.error,
        outcome: "not_applied",
        unblock: gate.unblock,
      };
  }
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
  postComment: (issueId, markdown, workspaceRoot) =>
    ytrackWrite(
      {
        cwd: workspaceRoot ?? process.cwd(),
        // The user approves the text without Workit's marker.
        fields: youTrackCommentApproval(issueId, withoutMarker(markdown)),
      },
      (backend) => backend.addComment(issueId, markdown),
    ),
  logTime: async (input) => {
    const date = youTrackWorkDateMs(
      input.dateMs != null ? String(input.dateMs) : String(input.date ?? "auto"),
    );
    if ("error" in date) return { ok: false, error: date.error, outcome: "not_applied" };
    const issueId = String(input.issueId);
    const item = {
      minutes: Number(input.minutes),
      text: typeof input.text === "string" ? input.text : "workit",
    };
    return ytrackWrite(
      {
        cwd: typeof input.workspace_root === "string" ? input.workspace_root : process.cwd(),
        fields: youTrackTimeApproval(issueId, { ...item, localDate: date.data.localDate }),
      },
      (backend) => backend.addWorkItem(issueId, { ...item, dateMs: date.data.dateMs }),
    );
  },
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

// Drafts shown in full (#864): a draft that needs the user's yes (a YouTrack
// comment, description or time-log text, release notes) is printed whole,
// under a marker that tells the agent to paste it to the user verbatim, with
// its hash. When the draft for the same target changed since it was last
// printed, the print leads with a line diff from that text. What was printed
// last is kept per target in the state dir, outside any repo.

/** One draft as printed: its full text, hash and the diff from the last print. */
export type ShownDraft = {
  target: string;
  sha256: string;
  text: string;
  /** The line diff from the text printed last for this target; null on the first print or no change. */
  diff: string | null;
};

const draftFile = (target: string): string =>
  path.join(
    resolveStateDir(),
    "drafts-shown",
    `${createHash("sha256").update(target).digest("hex").slice(0, 24)}.json`,
  );

/** A unified-style line diff (`-` removed, `+` added, ` ` kept) from `before` to `after`. */
export const draftDiff = (before: string, after: string): string => {
  const a = before.trimEnd().split(/\r?\n/u);
  const b = after.trimEnd().split(/\r?\n/u);
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (i < a.length && (j >= b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      out.push(`-${a[i]}`);
      i += 1;
    } else {
      out.push(`+${b[j]}`);
      j += 1;
    }
  }
  return out.join("\n");
};

/**
 * Print-ready record of `text` as the draft for `target` (`youtrack:ABC-1:comment`,
 * `release-notes:v1.2.0`), with the diff from the text printed last for the
 * same target, and remember it as the last print. A state dir that cannot be
 * written only loses the next diff.
 */
export const showDraft = (target: string, text: string): ShownDraft => {
  const sha256 = createHash("sha256").update(text).digest("hex");
  const file = draftFile(target);
  let previous: string | null = null;
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { target?: unknown; text?: unknown };
    if (saved.target === target && typeof saved.text === "string") previous = saved.text;
  } catch {
    // Never printed (or unreadable): this is the first print.
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileAtomic(file, `${JSON.stringify({ target, sha256, text })}\n`, 0o600);
  } catch {
    // Only the next diff is lost.
  }
  return {
    target,
    sha256,
    text,
    diff: previous !== null && previous !== text ? draftDiff(previous, text) : null,
  };
};

/** Forget the last print for `target`: the draft posted, so the next one starts fresh. */
export const forgetDraft = (target: string): void => {
  rmSync(draftFile(target), { force: true });
};

/** The block an agent pastes to the user verbatim: the diff (after a revision), then the whole text. */
export const draftLines = (draft: ShownDraft, what: string): string[] => [
  `--- ${what}: show this to the user verbatim in chat, in full (sha256 ${draft.sha256.slice(0, 12)}) ---`,
  ...(draft.diff === null
    ? []
    : ["changed since last shown (- removed, + added):", draft.diff, "", "the new full text:"]),
  draft.text.trimEnd(),
  `--- end of ${what} ---`,
];
