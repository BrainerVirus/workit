// The bench's tripwire (#822): a bench run must never change the real Workit
// config or state. Before each run the runner snapshots the real guarded files;
// after it, any change is put back byte for byte and the run fails as
// outside_write. Isolation (isolation.ts) keeps a run away from them; this
// catches what isolation cannot stop, such as a write to an absolute path.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { workitDir } from "../../packages/workit-core/src/core/workit-paths.mjs";

/** Config files restored exactly, a file the run created included. */
const CONFIG_FILES = ["workspaces.json", "workspaces.json.bak", "config.json"];
/** State trees: a pre-existing file is restored; a new one is reported, since a live session may have made it. */
const STATE_TREES = ["approvals", "issued", "issued-tokens"];

/**
 * The OS account's home from the account record (getent), never $HOME: under
 * bun `os.userInfo()` follows $HOME, so it cannot tell the real home.
 */
export const accountHome = (): string => {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null) {
    const run = spawnSync("getent", ["passwd", String(uid)], { encoding: "utf8", timeout: 5000 });
    const home = run.status === 0 ? run.stdout.trim().split(":")[5] : undefined;
    if (home) return home;
  }
  return os.userInfo().homedir;
};

export type Guard = { files: string[]; trees: string[] };

/** The real files to guard: the default config and state dirs of `home`, and those `env` (the runner's) points at. */
export const guardFor = (home: string, env?: NodeJS.ProcessEnv): Guard => {
  const dirs = (kind: "config" | "state") => [
    ...new Set(
      [workitDir(kind, { HOME: home }), ...(env ? [workitDir(kind, env)] : [])].map((dir) =>
        path.resolve(dir),
      ),
    ),
  ];
  const [config, state] = [dirs("config"), dirs("state")];
  return {
    files: config.flatMap((dir) => CONFIG_FILES.map((name) => path.join(dir, name))),
    trees: state.flatMap((dir) => STATE_TREES.map((name) => path.join(dir, name))),
  };
};

/** Every guarded file's bytes, null for a guarded file that does not exist. */
export type Snapshot = { files: Map<string, Uint8Array | null>; trees: Map<string, Uint8Array> };

const read = (file: string): Uint8Array | null => {
  try {
    return lstatSync(file).isFile() ? readFileSync(file) : null;
  } catch {
    return null;
  }
};

const walk = (dir: string, into: Map<string, Uint8Array>): void => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat?.isDirectory()) walk(file, into);
    else if (stat?.isFile()) into.set(file, readFileSync(file));
  }
};

export const snapshot = (guard: Guard): Snapshot => {
  const trees = new Map<string, Uint8Array>();
  for (const tree of guard.trees) walk(tree, trees);
  return { files: new Map(guard.files.map((file) => [file, read(file)])), trees };
};

const put = (file: string, bytes: Uint8Array): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  rmSync(file, { force: true, recursive: true });
  writeFileSync(file, bytes);
};

const same = (a: Uint8Array | null, b: Uint8Array | null): boolean =>
  a === null || b === null ? a === b : Buffer.compare(a, b) === 0;

/** What a run changed outside its world: `restored` is back to its bytes, `added` is left for the user. */
export type Trip = { restored: string[]; added: string[] };

/** Compare the guarded files with `before` and put every changed one back; null when nothing changed. */
export const restore = (guard: Guard, before: Snapshot): Trip | null => {
  const restored: string[] = [];
  for (const [file, bytes] of before.files) {
    if (same(read(file), bytes)) continue;
    if (bytes === null) rmSync(file, { force: true, recursive: true });
    else put(file, bytes);
    restored.push(file);
  }
  const after = new Map<string, Uint8Array>();
  for (const tree of guard.trees) walk(tree, after);
  for (const [file, bytes] of before.trees) {
    if (same(after.get(file) ?? null, bytes)) continue;
    put(file, bytes);
    restored.push(file);
  }
  const added = [...after.keys()].filter((file) => !before.trees.has(file) && existsSync(file));
  return restored.length + added.length === 0 ? null : { restored, added };
};

export const tripDetail = (trip: Trip, transcript: string): string =>
  [
    trip.restored.length > 0 ? `restored ${trip.restored.join(", ")}` : "",
    trip.added.length > 0 ? `added (left in place, check them) ${trip.added.join(", ")}` : "",
    `transcript ${transcript}`,
  ]
    .filter(Boolean)
    .join("; ");
