// Idempotent YouTrack writes for `workit youtrack note|time|meeting` (S16
// review M4). Each comment or work item carries a deterministic marker,
// `<!-- workit-action:<sha256> -->`, derived from the request. Before writing,
// the issue is read back and a write whose marker is already present is
// skipped (`already_done`); after a write with an unknown outcome (a timeout
// after the server applied it), the read-back settles it instead of a retry
// posting a duplicate.
import { sha256 } from "./task-contract";
import { youTrackBaseUrl } from "./youtrack";
import { youTrackBackend, type YouTrackBackend } from "./youtrack-backend";

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
    return { status: "failed", error: result.error ?? "not applied", data: result.data };
  const settled = await markerPresent(issueId, marker, where, backend);
  if (settled === true) return { status: "settled", ...precheck };
  return {
    status: settled === false ? "failed" : "unknown",
    error: result.error ?? "YouTrack write failed",
    data: result.data,
  };
}
