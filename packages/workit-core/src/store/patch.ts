// Structural JSON diff for the task event log (design §4.1). One mutation
// becomes the smallest set of operations that turns the previous record into
// the next one, so the log grows with the change, never with the record:
//
//   set     replace the value at `path`
//   del     remove the key at `path`
//   push    append `values` to the array at `path`
//   cut     truncate the array at `path` to `length`
//
// Arrays are compared element by element, so appending an entry (evidence,
// findings, decisions) is one `push`, and editing one entry in place is a
// diff inside that entry. Paths are arrays of keys and indices.

export type PatchPath = (string | number)[];
export type PatchOp =
  | { op: "set"; path: PatchPath; value: unknown }
  | { op: "del"; path: PatchPath }
  | { op: "push"; path: PatchPath; values: unknown[] }
  | { op: "cut"; path: PatchPath; length: number };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const equal = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null)
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    const other = right as unknown[];
    return left.length === other.length && left.every((item, index) => equal(item, other[index]));
  }
  const leftKeys = Object.keys(left).filter(
    (key) => (left as Record<string, unknown>)[key] !== undefined,
  );
  const rightKeys = Object.keys(right).filter(
    (key) => (right as Record<string, unknown>)[key] !== undefined,
  );
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) =>
      equal((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  );
};

/** Operations that turn `before` into `after` (JSON values only). */
export function diff(before: unknown, after: unknown, path: PatchPath = []): PatchOp[] {
  if (equal(before, after)) return [];
  if (isPlainObject(before) && isPlainObject(after)) {
    const ops: PatchOp[] = [];
    for (const key of Object.keys(before))
      if (before[key] !== undefined && after[key] === undefined)
        ops.push({ op: "del", path: [...path, key] });
    for (const key of Object.keys(after)) {
      if (after[key] === undefined) continue;
      if (before[key] === undefined)
        ops.push({ op: "set", path: [...path, key], value: after[key] });
      else ops.push(...diff(before[key], after[key], [...path, key]));
    }
    return ops;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const ops: PatchOp[] = [];
    if (after.length < before.length) ops.push({ op: "cut", path, length: after.length });
    const shared = Math.min(before.length, after.length);
    // A rewrite of most of the array is cheaper as one value.
    let changed = 0;
    for (let index = 0; index < shared; index += 1)
      if (!equal(before[index], after[index])) changed += 1;
    if (shared > 0 && changed > shared / 2 && changed > 4)
      return [{ op: "set", path, value: after }];
    for (let index = 0; index < shared; index += 1)
      ops.push(...diff(before[index], after[index], [...path, index]));
    if (after.length > before.length)
      ops.push({ op: "push", path, values: after.slice(before.length) });
    return ops;
  }
  return [{ op: "set", path, value: after }];
}

const clone = <T>(value: T): T => structuredClone(value);

/** Apply `ops` to `target` in place; throws on a path that does not exist. */
export function apply(target: unknown, ops: readonly PatchOp[]): unknown {
  let root = target;
  for (const op of ops) {
    if (op.path.length === 0) {
      if (op.op === "set") root = clone(op.value);
      else if (op.op === "push" && Array.isArray(root)) root.push(...clone(op.values));
      else if (op.op === "cut" && Array.isArray(root)) root.length = op.length;
      else throw new Error(`patch: ${op.op} at the root is invalid`);
      continue;
    }
    let parent: unknown = root;
    for (const key of op.path.slice(0, -1)) {
      if (typeof parent !== "object" || parent === null)
        throw new Error(`patch: missing path ${op.path.join(".")}`);
      parent = (parent as Record<string | number, unknown>)[key];
    }
    if (typeof parent !== "object" || parent === null)
      throw new Error(`patch: missing path ${op.path.join(".")}`);
    const key = op.path.at(-1)!;
    const container = parent as Record<string | number, unknown>;
    if (op.op === "set") container[key] = clone(op.value);
    else if (op.op === "del") delete container[key];
    else {
      const array = container[key];
      if (!Array.isArray(array)) throw new Error(`patch: ${op.path.join(".")} is not an array`);
      if (op.op === "push") array.push(...clone(op.values));
      else array.length = op.length;
    }
  }
  return root;
}

const isPath = (value: unknown): value is PatchPath =>
  Array.isArray(value) &&
  value.every(
    (key) =>
      typeof key === "string" || (typeof key === "number" && Number.isInteger(key) && key >= 0),
  );

/** Structural check of untrusted ops (from disk). */
export const isPatch = (value: unknown): value is PatchOp[] =>
  Array.isArray(value) &&
  value.every((op) => {
    if (!isPlainObject(op) || !isPath(op.path)) return false;
    if (op.op === "set") return "value" in op;
    if (op.op === "del") return op.path.length > 0;
    if (op.op === "push") return Array.isArray(op.values);
    if (op.op === "cut")
      return typeof op.length === "number" && Number.isInteger(op.length) && op.length >= 0;
    return false;
  });
