// Idempotent YouTrack writes for `workit youtrack note|time|meeting` (S16
// review M4). Each comment or work item carries a deterministic marker,
// `<!-- workit-action:<sha256> -->`, derived from the request. Before writing,
// the issue is read back and a write whose marker is already present is
// skipped (`already_done`); after a write with an unknown outcome (a timeout
// after the server applied it), the read-back settles it instead of a retry
// posting a duplicate.
import { sha256 } from "./task-contract";
import { youTrackRequest, youTrackToken } from "./youtrack";

export type MarkerWhere = "comments" | "workItems";

export const youTrackMarker = (request: Record<string, unknown>): string | null => {
  const creds = youTrackToken();
  if ("error" in creds) return null;
  return `<!-- workit-action:${sha256({ ...request, baseUrl: creds.base })} -->`;
};

export const withMarker = (text: string, marker: string): string =>
  `${text}${text ? "\n\n" : ""}${marker}`;

const PAGE = 500;

/** true/false when the read-back is conclusive, null when it is not. */
export async function markerPresent(
  issueId: string,
  marker: string,
  where: MarkerWhere,
): Promise<boolean | null> {
  const creds = youTrackToken();
  if ("error" in creds) return null;
  const endpoint =
    where === "comments"
      ? `/api/issues/${encodeURIComponent(issueId)}/comments?fields=id,text,deleted`
      : `/api/issues/${encodeURIComponent(issueId)}/timeTracking/workItems?fields=id,text`;
  const result = await youTrackRequest(`${creds.base}${endpoint}&$top=${PAGE}&$skip=0`, {
    method: "GET",
    token: creds.token,
  });
  if (result.status !== 0) return null;
  try {
    const items = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(items)) return null;
    const found = items.some(
      (item) =>
        item &&
        typeof item === "object" &&
        (item as { deleted?: unknown }).deleted !== true &&
        typeof (item as { text?: unknown }).text === "string" &&
        (item as { text: string }).text.includes(marker),
    );
    // A full page may hide an older match: only a hit is conclusive then.
    return found ? true : items.length < PAGE ? false : null;
  } catch {
    return null;
  }
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
): Promise<OnceOutcome> {
  const before = await markerPresent(issueId, marker, where);
  if (before === true) return { status: "already_done" };
  const precheck = before === null ? { precheck: "inconclusive" as const } : {};
  const result = await write();
  if (result.ok) return { status: "done", data: result.data, ...precheck };
  const outcome = (result.data as { outcome?: unknown } | undefined)?.outcome;
  if (outcome === "not_applied")
    return { status: "failed", error: result.error ?? "not applied", data: result.data };
  const settled = await markerPresent(issueId, marker, where);
  if (settled === true) return { status: "settled", ...precheck };
  return {
    status: settled === false ? "failed" : "unknown",
    error: result.error ?? "YouTrack write failed",
    data: result.data,
  };
}
