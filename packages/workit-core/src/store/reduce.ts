// Pure reduction of a task's events into its state (design §4.1), plus the
// content-addressed blob encoding for stored candidates.
//
// Every event may carry, in `data`:
//   record   the whole task record (opening events and compaction checkpoints)
//   ops      a structural patch of the record (see patch.ts)
//   key      the implicit-task key the task is bound to (null unbinds)
//   legacy   where a migrated task came from
// The reducer applies whatever of these an event carries, so an event type
// this runtime does not know still replays correctly when it uses them. An
// unknown event that carries none of them is ignored, unless it is marked
// `critical`, in which case the reader fails closed.
import { createHash } from "node:crypto";
import { LogDamage, type StoreEvent } from "./event-log";
import { apply, isPatch, type PatchOp } from "./patch";
import type { TaskKey } from "./paths";

export type LegacyOrigin = { path: string; digest: string };

export type ReducedTask = {
  record: Record<string, unknown>;
  key: TaskKey | null;
  legacy: LegacyOrigin | null;
};

/** Event types that open (or restart, after compaction) a task's log. */
export const OPENING_TYPES: ReadonlySet<string> = new Set([
  "task.opened",
  "task.imported",
  "migrated.from_v2",
  "task.checkpoint",
]);

/** Event types this runtime writes and reads. */
const KNOWN_TYPES: ReadonlySet<string> = new Set([
  ...OPENING_TYPES,
  "task.bound",
  "task.noted",
  "task.revised",
  "task.judged",
  "task.paused",
  "task.resumed",
  "task.closed",
  "task.updated",
  "check.ran",
  "evidence.recorded",
  "finding.recorded",
  "finding.updated",
  "decision.recorded",
  "decision.updated",
  "worker.updated",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isKey = (value: unknown): value is TaskKey =>
  isObject(value) &&
  typeof value.key === "string" &&
  (value.kind === "branch" || value.kind === "detached" || value.kind === "dir") &&
  (value.branch === null || typeof value.branch === "string");

// ---------------------------------------------------------------------------
// blobs: stored candidates are written once, by content digest

export type BlobStore = {
  read(digest: string): unknown;
  write(digest: string, value: unknown): void;
};

const BLOB_REF = "$blob";
const blobRef = (value: unknown): string | null =>
  isObject(value) &&
  Object.keys(value).length === 1 &&
  typeof value[BLOB_REF] === "string" &&
  /^[0-9a-f]{64}$/.test(value[BLOB_REF])
    ? value[BLOB_REF]
    : null;

export const blobDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const toBlob = (value: unknown, blobs: BlobStore): unknown => {
  if (!isObject(value)) return value;
  const digest = blobDigest(value);
  blobs.write(digest, value);
  return { [BLOB_REF]: digest };
};

/** Replace candidate bodies in a record with blob references. */
export const encodeRecord = (
  record: Record<string, unknown>,
  blobs: BlobStore,
): Record<string, unknown> =>
  Array.isArray(record.candidates)
    ? { ...record, candidates: record.candidates.map((item) => toBlob(item, blobs)) }
    : record;

/** Replace candidate bodies inside patch ops with blob references. */
export const encodeOps = (ops: PatchOp[], blobs: BlobStore): PatchOp[] =>
  ops.map((op) => {
    if (op.path[0] !== "candidates") return op;
    if (op.op === "push" && op.path.length === 1)
      return { ...op, values: op.values.map((item) => toBlob(item, blobs)) };
    if (op.op === "set" && op.path.length === 1 && Array.isArray(op.value))
      return { ...op, value: op.value.map((item) => toBlob(item, blobs)) };
    if (op.op === "set" && op.path.length === 2) return { ...op, value: toBlob(op.value, blobs) };
    return op;
  });

/** Resolve blob references anywhere in `value`. */
const decode = (value: unknown, blobs: BlobStore): unknown => {
  const digest = blobRef(value);
  if (digest) return blobs.read(digest);
  if (Array.isArray(value)) return value.map((item) => decode(item, blobs));
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = decode(item, blobs);
    return out;
  }
  return value;
};

// ---------------------------------------------------------------------------
// reduction

/** Apply one event to `state` (null before the opening event). */
export function reduce(
  state: ReducedTask | null,
  event: StoreEvent,
  blobs: BlobStore,
): ReducedTask | null {
  const data = event.data;
  const known = KNOWN_TYPES.has(event.type);
  const carries = "record" in data || "ops" in data || "key" in data;
  if (!known && !carries) {
    if (event.critical === true)
      throw new LogDamage(
        `event ${event.type} was written by a newer Workit and must be understood; upgrade Workit to read this task`,
        true,
      );
    return state;
  }
  let next = state;
  if ("record" in data) {
    if (!isObject(data.record))
      throw new LogDamage(`event ${event.seq} carries a malformed record`);
    next = {
      record: decode(data.record, blobs) as Record<string, unknown>,
      key: null,
      legacy: null,
    };
  } else if (next === null) {
    throw new LogDamage(`the log does not start with an opening event (found ${event.type})`);
  } else next = { ...next };
  if ("ops" in data) {
    if (!isPatch(data.ops)) throw new LogDamage(`event ${event.seq} carries a malformed patch`);
    try {
      next.record = apply(
        next.record,
        decode(data.ops, blobs) as PatchOp[],
      ) as ReducedTask["record"];
    } catch (error) {
      throw new LogDamage(`event ${event.seq} does not apply: ${String(error)}`);
    }
  }
  if ("key" in data) next.key = isKey(data.key) ? data.key : null;
  if ("legacy" in data && isObject(data.legacy))
    next.legacy = {
      path: String(data.legacy.path ?? ""),
      digest: String(data.legacy.digest ?? ""),
    };
  return next;
}

/** A readable event type for a mutation (informational; replay does not use it). */
export function eventType(before: Record<string, unknown>, after: Record<string, unknown>): string {
  const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  if (before.status !== after.status)
    return after.status === "closed"
      ? "task.closed"
      : after.status === "paused"
        ? "task.paused"
        : "task.resumed";
  if (count(after.evidence) > count(before.evidence)) {
    const last = (after.evidence as Array<{ data?: { observation?: unknown } }>).at(-1);
    return last?.data?.observation ? "check.ran" : "evidence.recorded";
  }
  if (count(after.findings) > count(before.findings)) return "finding.recorded";
  if (count(after.decisions) > count(before.decisions)) return "decision.recorded";
  if (JSON.stringify(before.findings) !== JSON.stringify(after.findings)) return "finding.updated";
  if (JSON.stringify(before.decisions) !== JSON.stringify(after.decisions))
    return "decision.updated";
  if (JSON.stringify(before.workers) !== JSON.stringify(after.workers)) return "worker.updated";
  if (JSON.stringify(before.intent) !== JSON.stringify(after.intent)) return "task.revised";
  if (
    JSON.stringify(before.assessments) !== JSON.stringify(after.assessments) ||
    JSON.stringify(before.policy) !== JSON.stringify(after.policy)
  )
    return "task.judged";
  if (JSON.stringify(before.progress) !== JSON.stringify(after.progress)) return "task.noted";
  return "task.updated";
}
