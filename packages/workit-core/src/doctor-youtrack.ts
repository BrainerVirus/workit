// `workit doctor`'s youtrack_writes row: a workspace with
// `youtrack.writes: auto` and no `youtrack.autoHosts` posts unasked to any
// YouTrack a write reaches (a raw ytrack call, or youtrack.json's instance),
// the meaning auto had before autoHosts. The fix scopes it to named hosts.
import { youTrackHostKey } from "./core/youtrack-ytrack";

/** One unscoped auto workspace and the terminal command that scopes it. */
export type UnscopedAuto = { workspace: string; fix: string };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Each entry of `entries` (a workspaces.json's) with writes auto and no
 * autoHosts, with the `workit workspace set` call naming its own
 * youtrack.baseUrl host, else a `<host>` placeholder.
 */
export const unscopedAutoWrites = (entries: readonly unknown[]): UnscopedAuto[] =>
  entries.flatMap((entry, at) => {
    const raw = record(entry);
    const youtrack = record(raw?.youtrack);
    if (youtrack?.writes !== "auto" || Array.isArray(youtrack.autoHosts)) return [];
    const name = typeof raw?.name === "string" ? raw.name : `#${at + 1}`;
    const host =
      (typeof youtrack.baseUrl === "string" ? youTrackHostKey(youtrack.baseUrl) : null) ?? "<host>";
    return [
      { workspace: name, fix: `workit workspace set ${name} youtrack.autoHosts='["${host}"]'` },
    ];
  });
