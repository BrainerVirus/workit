// Idempotent YouTrack writes for `workit youtrack note|time|meeting` (S16
// review M4). Each comment or work item carries a deterministic marker,
// `<!-- workit-action:<sha256> -->`, derived from the request. Before writing,
// the issue is read back and a write whose marker is already present is
// skipped (`already_done`); after a write with an unknown outcome (a timeout
// after the server applied it), the read-back settles it instead of a retry
// posting a duplicate.
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { ApprovalFields } from "../approvals/store";
import { sealNote } from "../autonomy";
import { resolveStateDir } from "./logger";
import { writeFileAtomic } from "./safe-write";
import { sha256 } from "./task-contract";
import { resolveRuntimeWorkspaceVcs } from "./workspaces";
import { youTrackBaseUrl, youTrackWorkTimezone } from "./youtrack";
import { youTrackBackend, type OwnEntry, type YouTrackBackend } from "./youtrack-backend";

export type MarkerWhere = "comments" | "workItems";

/**
 * The marker for one request. It names youtrack.json's baseUrl (read without
 * the token file) so two instances never share a marker; with ytrack and no
 * baseUrl it names ytrack's default host.
 */
export const youTrackMarker = (request: Record<string, unknown>): string =>
  `<!-- workit-action:${sha256({ ...request, baseUrl: youTrackBaseUrl() ?? "ytrack:default" })} -->`;

export const withMarker = (text: string, marker: string): string =>
  `${text}${text ? "\n\n" : ""}${marker}`;

/** true/false when the read-back is conclusive, null when it is not. */
export async function markerPresent(
  issueId: string,
  marker: string,
  where: MarkerWhere,
  backend: YouTrackBackend = youTrackBackend(),
): Promise<boolean | null> {
  const read = await backend.texts(issueId, where);
  if (!read) return null;
  if (read.texts.some((text) => text.includes(marker))) return true;
  // A partial read may hide an older match: only a hit is conclusive then.
  return read.complete ? false : null;
}

type WriteResult = { ok: boolean; error?: string | null; data?: unknown };

export type OnceOutcome =
  | {
      status: "done" | "already_done" | "settled";
      data?: unknown;
      /** The pre-write read-back could not rule out an earlier copy (>1 page). */
      precheck?: "inconclusive";
    }
  | { status: "failed" | "unknown"; error: string; data?: unknown };

/** Write at most once: skip when the marker is there, read back an unknown outcome. */
export async function writeOnce(
  issueId: string,
  marker: string,
  where: MarkerWhere,
  write: () => Promise<WriteResult>,
  backend: YouTrackBackend = youTrackBackend(),
): Promise<OnceOutcome> {
  const before = await markerPresent(issueId, marker, where, backend);
  if (before === true) return { status: "already_done" };
  const precheck = before === null ? { precheck: "inconclusive" as const } : {};
  const result = await write();
  if (result.ok) return { status: "done", data: result.data, ...precheck };
  const outcome = (result.data as { outcome?: unknown } | undefined)?.outcome;
  if (outcome === "not_applied")
    return {
      status: "failed",
      error: result.error ?? "not applied",
      data: result.data,
    };
  const settled = await markerPresent(issueId, marker, where, backend);
  if (settled === true) return { status: "settled", ...precheck };
  return {
    status: settled === false ? "failed" : "unknown",
    error: result.error ?? "YouTrack write failed",
    data: result.data,
  };
}

// ------------------------------------------------- asking first (#780)

/**
 * `ask` (the default, every workspace): each write needs the user's yes
 * through the approval channel. `auto` is the opt-out a user sets in the
 * workspace entry (`youtrack: { writes: "auto" }`); it keeps the
 * WORKIT_YT_WRITE gate alone. A broken authority seal (#819) reads as `ask`.
 */
export type YouTrackWritesMode = "ask" | "auto";

export const youTrackWritesMode = (cwd: string): YouTrackWritesMode => {
  const youtrack = resolveRuntimeWorkspaceVcs(cwd)?.youtrack;
  return youtrack &&
    typeof youtrack === "object" &&
    (youtrack as { writes?: unknown }).writes === "auto" &&
    !sealNote()
    ? "auto"
    : "ask";
};

/** What the user approves for one `workit youtrack` write: the issue, the text, the minutes, the day. */
export const youTrackApprovalFields = (input: {
  action: string;
  /** `{ issue }` for a comment or work item, `{ project }` for a new issue. */
  on: Record<string, string>;
  effect: string;
  subject: Record<string, unknown>;
}): ApprovalFields => ({
  kind: "youtrack-write",
  action: input.action,
  target: { tracker: youTrackBaseUrl() ?? "ytrack:default", ...input.on },
  effect: input.effect,
  subject: input.subject,
});

/** The yes for one comment: the fields `workit youtrack note <ISSUE> --markdown <text>` asks for. */
export const youTrackCommentApproval = (issueId: string, markdown: string): ApprovalFields =>
  youTrackApprovalFields({
    action: `workit youtrack note ${issueId}`,
    on: { issue: issueId },
    effect: `posts this comment on ${issueId}`,
    subject: { comment: markdown },
  });

/** The yes for one work item: the fields `workit youtrack time <ISSUE> --minutes <n>` asks for. */
export const youTrackTimeApproval = (
  issueId: string,
  item: { minutes: number; text: string; localDate: string },
): ApprovalFields =>
  youTrackApprovalFields({
    action: `workit youtrack time ${issueId} --minutes ${item.minutes}`,
    on: { issue: issueId },
    effect: `logs ${item.minutes} minutes on ${issueId} on ${item.localDate}`,
    subject: { minutes: item.minutes, text: item.text, date: item.localDate },
  });

// ------------------------------------------------- duplicate entries (#780)

const MARKER_TAIL = /\s*<!-- workit-action:[0-9a-f]{64} -->\s*$/u;

/** An entry's text without Workit's marker. */
export const withoutMarker = (text: string): string => text.replace(MARKER_TAIL, "").trim();

export type Wanted =
  | { where: "comments"; text: string }
  | { where: "workItems"; text: string; minutes: number; date: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * A work item's day as YYYY-MM-DD, or null. A day stays as it is; an epoch
 * (number or digits) or an ISO timestamp at UTC midnight is YouTrack's work
 * date, so its UTC day; any other timestamp is read in `timezone`.
 */
export const workItemDay = (value: unknown, timezone: string): string | null => {
  if (typeof value === "string" && DAY.test(value)) return value;
  const ms =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value)
        ? Number(value)
        : typeof value === "string"
          ? Date.parse(value)
          : Number.NaN;
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (ms % 86_400_000 === 0) return date.toISOString().slice(0, 10);
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return DAY.test(day) ? day : null;
};

/**
 * The current user's entry that already says what `wanted` would post (same
 * text, and for a work item the same minutes and day), or null. `undefined`
 * when the entries could not be read: the caller says duplicates were not
 * checked, never that there are none.
 */
export async function findDuplicate(
  issueId: string,
  wanted: Wanted,
  backend: YouTrackBackend,
  timezone: string = youTrackWorkTimezone(),
): Promise<OwnEntry | null | undefined> {
  const entries = await backend.ownEntries(issueId, wanted.where);
  if (!entries) return undefined;
  const text = wanted.text.trim();
  return (
    entries.find(
      (entry) =>
        withoutMarker(entry.text) === text &&
        (wanted.where === "comments" ||
          (entry.minutes === wanted.minutes && workItemDay(entry.date, timezone) === wanted.date)),
    ) ?? null
  );
}

// ------------------------------------------------- interrupted writes (#780)

/** A write that started and has no known outcome yet. */
export type PendingWrite = {
  issueId: string;
  step: string;
  action: string;
  where: MarkerWhere;
  marker: string;
  at: string;
};

const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const pendingDir = (): string => path.join(resolveStateDir(), "youtrack", "pending");
const pendingFile = (marker: string): string =>
  path.join(pendingDir(), `${sha256(marker).slice(0, 32)}.json`);

/** Note a write before it is sent, so a killed or timed-out call is settled next time. */
export const rememberPending = (write: Omit<PendingWrite, "at">): void => {
  mkdirSync(pendingDir(), { recursive: true });
  writeFileAtomic(
    pendingFile(write.marker),
    `${JSON.stringify({ ...write, at: new Date().toISOString() }, null, 2)}\n`,
  );
};

export const forgetPending = (marker: string): void => {
  rmSync(pendingFile(marker), { force: true });
};

export type EarlierWrite = Omit<PendingWrite, "marker" | "where"> & {
  /** true: it landed; false: it did not; null: still unknown (kept for the next call). */
  landed: boolean | null;
};

/**
 * Read back every write an earlier call started but never settled (an
 * interrupt, a crash, a lost reply) and say whether it landed. Settled ones
 * are forgotten; unknown ones stay for the next call.
 */
export async function settlePending(backend: YouTrackBackend): Promise<EarlierWrite[]> {
  let names: string[];
  try {
    names = readdirSync(pendingDir()).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const out: EarlierWrite[] = [];
  for (const name of names) {
    const file = path.join(pendingDir(), name);
    let entry: PendingWrite;
    try {
      entry = JSON.parse(readFileSync(file, "utf8")) as PendingWrite;
    } catch {
      rmSync(file, { force: true });
      continue;
    }
    const landed = await markerPresent(entry.issueId, entry.marker, entry.where, backend);
    if (landed !== null || Date.now() - Date.parse(entry.at) > PENDING_MAX_AGE_MS)
      rmSync(file, { force: true });
    out.push({
      issueId: entry.issueId,
      step: entry.step,
      action: entry.action,
      at: entry.at,
      landed,
    });
  }
  return out;
}
