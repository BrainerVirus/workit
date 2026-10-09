// The per-session nudge marker in the workspace store
// (`<store>/hooks/skills-<session hash>.json`): which skills a session was
// nudged about or loaded, and which raw-git nudge kinds it was shown, so each
// nudge fires once per session. Each hook is a fresh process, so the marker
// lives on disk. Every failure reads as an empty marker: hooks fail open.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStore } from "../store/paths";
import type { HookInput } from "./protocol";

export type SessionMarker = { nudged: string[]; loaded: string[]; raw: string[] };

/**
 * The marker in the workspace's store (null outside one: nothing is nudged or
 * recorded there). `store` names the store directly when the command acts in
 * another checkout than the hook's cwd.
 */
export const sessionMarkerFile = (
  input: HookInput,
  session: string,
  store?: string,
): string | null => {
  let dir = store;
  if (dir === undefined) {
    const location = resolveStore(input.cwd);
    if (location instanceof Error || !location.shared) return null;
    dir = location.dir;
  }
  const name = createHash("sha256").update(`${input.host}\0${session}`).digest("hex").slice(0, 32);
  return path.join(dir, "hooks", `skills-${name}.json`);
};

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export const readSessionMarker = (file: string): SessionMarker => {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return { nudged: list(value.nudged), loaded: list(value.loaded), raw: list(value.raw) };
  } catch {
    return { nudged: [], loaded: [], raw: [] };
  }
};

export const writeSessionMarker = (file: string, marker: SessionMarker): void => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(marker));
  } catch {
    // Fail open: without a marker a later nudge repeats.
  }
};
