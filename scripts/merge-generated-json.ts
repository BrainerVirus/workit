#!/usr/bin/env bun
// Git merge driver for generated flat JSON files such as
// docs/qualification/context-budget.json: `bun scripts/merge-generated-json.ts %O %A %B`.
// A key-wise three-way merge: a key one side changed takes that side's value; a
// number both sides changed keeps the larger one (the drift test then asks for
// `bun run write:budget`); any other double change is a conflict. Exit 0 wrote
// the merge over %A; exit 1 touched nothing, so the caller's `git merge-file`
// fallback leaves normal conflict markers (see MERGE_DRIVER_COMMAND).
import { readFileSync, writeFileSync } from "node:fs";

export const MERGE_DRIVER = "workit-generated-json";
export const MERGE_DRIVER_COMMAND =
  "bun scripts/merge-generated-json.ts %O %A %B || git merge-file %A %O %B";

type Flat = Record<string, unknown>;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function parseFlat(text: string): Flat {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("not a JSON object");
  return value as Flat;
}

/** The merged object, or `undefined` when a key was changed on both sides to different non-numbers. */
export function mergeFlatJson(base: Flat, ours: Flat, theirs: Flat): Flat | undefined {
  const out: Flat = {};
  const keys = [...new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base)])];
  for (const key of keys) {
    const [b, o, t] = [base[key], ours[key], theirs[key]];
    let value: unknown;
    if (same(o, t)) value = o;
    else if (same(o, b)) value = t;
    else if (same(t, b)) value = o;
    else if (typeof o === "number" && typeof t === "number") value = Math.max(o, t);
    else return undefined;
    if (value !== undefined) out[key] = value;
  }
  return out;
}

if (import.meta.main) {
  const [basePath, oursPath, theirsPath] = process.argv.slice(2);
  if (!basePath || !oursPath || !theirsPath) process.exit(1);
  try {
    const read = (file: string) => parseFlat(readFileSync(file, "utf8"));
    const merged = mergeFlatJson(read(basePath), read(oursPath), read(theirsPath));
    if (!merged) process.exit(1);
    writeFileSync(oursPath, `${JSON.stringify(merged, null, 2)}\n`);
  } catch {
    process.exit(1);
  }
}
