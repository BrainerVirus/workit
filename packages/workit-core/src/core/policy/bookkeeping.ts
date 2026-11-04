// What a verdict carry may leave out of the branch's own change (#334 follow-up):
//
//   trunk-only   after a rebase, the judged head replayed onto the new fork
//                point (replayTree: a 3-way merge anchored at the old fork).
//                What the current head changes against that replay is the
//                branch's own change; the rest came from trunk.
//   bookkeeping  a JSON manifest whose only change is its top-level `version`
//                string (a release sync), or a non-code file that a root
//                package.json `write:*` script regenerates (read at the base
//                revision, so a branch cannot name its own file). Changelogs
//                are docs already (lane.ts).
//
// Both fail closed: a file git cannot read stays in the change.
import { spawnSync } from "node:child_process";
import { fileAt, GIT_TIMEOUTS } from "../../git/rev";

const OID = /^[0-9a-f]{40,64}$/u;
const safe = (value: string): boolean => value.length > 0 && !value.startsWith("-");

/**
 * The tree of the judged head `from` replayed onto `toFork`, anchored at
 * `fromFork`, conflicts included (conflicted files hold markers, so they
 * never equal a resolved file). Null when git cannot build it (before 2.40).
 */
export function replayTree(
  cwd: string,
  from: string,
  fromFork: string,
  toFork: string,
): string | null {
  if (![from, fromFork, toFork].every(safe)) return null;
  const run = spawnSync(
    "git",
    ["merge-tree", "--write-tree", "--no-messages", `--merge-base=${fromFork}`, toFork, from],
    {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUTS.worktree,
      killSignal: "SIGKILL",
      windowsHide: true,
    },
  );
  // 0: clean, 1: conflicts (the tree is still written); anything else failed.
  if (run.status !== 0 && run.status !== 1) return null;
  const tree = (run.stdout ?? "").split("\n")[0]?.trim() ?? "";
  return OID.test(tree) ? tree : null;
}

const SEMVER = /^v?\d+\.\d+\.\d+(?:[-+][\w.+-]*)?$/u;

const parseObject = (text: string | null): Record<string, unknown> | null => {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** Both sides are JSON objects that differ only in a top-level semver `version` string. */
export function versionOnlyChange(before: string | null, after: string | null): boolean {
  const a = parseObject(before);
  const b = parseObject(after);
  if (!a || !b) return false;
  const { version: va, ...restA } = a;
  const { version: vb, ...restB } = b;
  if (typeof va !== "string" || typeof vb !== "string") return false;
  if (!SEMVER.test(va) || !SEMVER.test(vb)) return false;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

const CODE = /\.(?:[cm]?[jt]sx?)$/u;
const SCRIPT_FILE = /[\w./-]+\.[cm]?[jt]s\b/gu;

/**
 * Of `paths`, the non-code files a root package.json `write:*` script at
 * `rev` regenerates: the script's source names the path (fanout.ts
 * regeneratedFiles reads the working tree; this reads one revision).
 */
function regeneratedAt(cwd: string, rev: string, paths: readonly string[]): Set<string> {
  const found = new Set<string>();
  const outputs = paths.filter((file) => !CODE.test(file));
  if (!outputs.length) return found;
  const manifest = parseObject(fileAt(cwd, rev, "package.json"));
  const scripts = manifest?.scripts;
  if (!scripts || typeof scripts !== "object") return found;
  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (!name.startsWith("write:") || typeof command !== "string") continue;
    for (const file of command.match(SCRIPT_FILE) ?? []) {
      const source = fileAt(cwd, rev, file.replace(/^\.\//u, ""));
      if (source === null) continue;
      for (const output of outputs) if (source.includes(output)) found.add(output);
    }
  }
  return found;
}

/**
 * Of `paths` changed between the judged `from` and the current `to`, the
 * bookkeeping ones: a version-only manifest change, or a file a `write:*`
 * script at `base` regenerates.
 */
export function bookkeepingPaths(
  cwd: string,
  input: { from: string; to: string; base: string; paths: readonly string[] },
): Set<string> {
  const found = regeneratedAt(cwd, input.base, input.paths);
  for (const file of input.paths)
    if (
      !found.has(file) &&
      file.endsWith(".json") &&
      versionOnlyChange(fileAt(cwd, input.from, file), fileAt(cwd, input.to, file))
    )
      found.add(file);
  return found;
}
