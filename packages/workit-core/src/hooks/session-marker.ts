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

export type SessionMarker = {
  nudged: string[];
  loaded: string[];
  raw: string[];
  /** Stop obligations already raised, `<kind>:<head>`: each blocks once per head. */
  stops: string[];
  /** Verifier and reviewer subagents of this lead that started and have not stopped. */
  judges: string[];
  /** The last model the session reported (Codex #435): a change re-sends the contract. */
  model: string | null;
};

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

const EMPTY: SessionMarker = {
  nudged: [],
  loaded: [],
  raw: [],
  stops: [],
  judges: [],
  model: null,
};

const readRaw = (file: string): string => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

const parseMarker = (text: string): SessionMarker => {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return {
      nudged: list(value.nudged),
      loaded: list(value.loaded),
      raw: list(value.raw),
      stops: list(value.stops),
      judges: list(value.judges),
      model: typeof value.model === "string" ? value.model : null,
    };
  } catch {
    return { ...EMPTY };
  }
};

export const readSessionMarker = (file: string): SessionMarker => parseMarker(readRaw(file));

/** Write through a temp file in the same directory and rename: a reader never sees half a marker. */
const writeAtomic = (file: string, marker: SessionMarker): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(marker));
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
};

export const writeSessionMarker = (file: string, marker: SessionMarker): void => {
  try {
    writeAtomic(file, marker);
  } catch {
    // Fail open: without a marker a later nudge repeats.
  }
};

/**
 * Read-modify-write: `change` maps the marker as read to the marker to keep.
 * Another hook's rename between the read and ours is detected (the file's
 * text changed) and `change` runs once more on the fresh marker, so an entry
 * of a concurrent hook is not lost. Fails open like the rest.
 */
export const updateSessionMarker = (
  file: string,
  change: (marker: SessionMarker) => SessionMarker,
): void => {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = readRaw(file);
      const next = change(parseMarker(before));
      if (attempt === 0 && readRaw(file) !== before) continue;
      writeAtomic(file, next);
      return;
    }
  } catch {
    // Fail open: without a marker a later nudge repeats.
  }
};

/** Record that a verifier or reviewer subagent of this lead started or stopped. */
export const trackJudge = (input: HookInput, agentId: string | null, running: boolean): void => {
  const session = input.session.id;
  const file = session && agentId ? sessionMarkerFile(input, session) : null;
  if (!file || !agentId) return;
  updateSessionMarker(file, (marker) => {
    const rest = marker.judges.filter((id) => id !== agentId);
    return { ...marker, judges: running ? [...rest, agentId] : rest };
  });
};

/**
 * Record the session's model and say whether it differs from the last one
 * recorded (the hook is a fresh process each time). The first model is a
 * start, not a switch. Fails open: no store or no model reads as no switch.
 */
export const modelSwitchedOnDisk = (input: HookInput): boolean => {
  const session = input.session.id;
  const model = input.model;
  const file = session && model ? sessionMarkerFile(input, session) : null;
  if (!file || !model) return false;
  const previous = readSessionMarker(file).model;
  if (previous === model) return false;
  updateSessionMarker(file, (marker) => ({ ...marker, model }));
  return previous !== null;
};
