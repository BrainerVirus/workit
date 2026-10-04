// The append-only event log of one task: `events.jsonl`, one JSON event per
// line, plus `snapshot.json`, a rebuildable cache of the reduced state
// (design §4.1).
//
// - A writer holds the task lock, appends one complete line with O_APPEND in
//   a single write, and fsyncs. A crash can therefore only leave a torn last
//   line (no trailing newline); readers ignore it and the next locked append
//   truncates it away first. Any other unreadable line is real damage.
// - Readers are lenient (D17): unknown event keys and unknown event types are
//   ignored, unless the event says `critical: true`, in which case a reader
//   that does not know the type fails closed with an upgrade message.
// - The snapshot names the event it was taken after (seq, id, byte range). A
//   snapshot that does not match the log is ignored and the log is replayed.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const EVENT_VERSION = 1;

export type EventActor = { host: string; session: string | null; agentId: string | null };

export type StoreEvent = {
  v: number;
  seq: number;
  at: string;
  id: string;
  task: string;
  actor: EventActor | null;
  type: string;
  data: Record<string, unknown>;
  critical?: boolean;
};

export type LogRead = {
  events: StoreEvent[];
  /** Byte offset just past the last complete event line. */
  end: number;
  /** Byte offset where the last complete event line starts. */
  lastStart: number;
  /** File size; larger than `end` when a torn line trails the log. */
  size: number;
};

export class LogDamage extends Error {
  constructor(
    message: string,
    readonly upgrade: boolean = false,
  ) {
    super(message);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseEvent = (line: string, file: string, offset: number): StoreEvent => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new LogDamage(`${file}: unreadable event at byte ${offset}`);
  }
  if (!isObject(value) || typeof value.v !== "number")
    throw new LogDamage(`${file}: malformed event at byte ${offset}`);
  if (value.v > EVENT_VERSION)
    throw new LogDamage(
      `${file}: event format v${value.v} was written by a newer Workit; upgrade Workit to read this task`,
      true,
    );
  if (
    typeof value.seq !== "number" ||
    !Number.isInteger(value.seq) ||
    typeof value.type !== "string" ||
    typeof value.id !== "string" ||
    typeof value.task !== "string" ||
    !isObject(value.data)
  )
    throw new LogDamage(`${file}: malformed event at byte ${offset}`);
  return value as StoreEvent;
};

/**
 * Read the events of `file` starting at byte `from` (a line start). A torn
 * trailing line is excluded; `expectSeq` is the seq the first event must have.
 * Returns null when the file does not exist.
 */
export function readLog(file: string, from = 0, expectSeq: number | null = null): LogRead | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let bytes: Buffer;
  let size: number;
  try {
    size = fs.fstatSync(fd).size;
    if (from > size) throw new LogDamage(`${file}: shorter than its snapshot`);
    bytes = Buffer.alloc(size - from);
    let read = 0;
    while (read < bytes.length) {
      const got = fs.readSync(fd, bytes, read, bytes.length - read, from + read);
      if (got === 0) break;
      read += got;
    }
    bytes = bytes.subarray(0, read);
    size = from + read;
  } finally {
    fs.closeSync(fd);
  }
  const events: StoreEvent[] = [];
  let start = 0;
  let lastStart = from;
  let seq = expectSeq;
  for (;;) {
    const newline = bytes.indexOf(0x0a, start);
    if (newline < 0) break;
    const line = bytes.subarray(start, newline).toString("utf8");
    if (line.trim() !== "") {
      const event = parseEvent(line, file, from + start);
      if (seq !== null && event.seq !== seq)
        throw new LogDamage(`${file}: event seq ${event.seq} where ${seq} was expected`);
      seq = event.seq + 1;
      events.push(event);
      lastStart = from + start;
    }
    start = newline + 1;
  }
  return { events, end: from + start, lastStart, size };
}

/** Durably write `dir`'s entries (no-op where directories cannot be fsynced). */
export const fsyncDirectory = (dir: string): void => {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
};

/**
 * Append one event line. `validEnd` is where the last complete line ends: a
 * torn tail beyond it is truncated first. Returns the byte offset the line
 * starts at.
 */
export function appendEvent(file: string, event: StoreEvent, validEnd: number): number {
  const line = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
  const created = !fs.existsSync(file);
  const fd = fs.openSync(file, "a", 0o600);
  try {
    if (fs.fstatSync(fd).size !== validEnd) fs.ftruncateSync(fd, validEnd);
    let written = 0;
    while (written < line.length) written += fs.writeSync(fd, line, written, line.length - written);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (created) fsyncDirectory(path.dirname(file));
  return validEnd;
}

/** Replace `file` with `bytes` atomically (temp file + rename). */
export function replaceFile(file: string, bytes: string, durable: boolean): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeSync(fd, bytes);
      if (durable) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(temporary, file);
    if (durable) fsyncDirectory(path.dirname(file));
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

const TRANSIENT_WINDOWS_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
/** Windows briefly refuses to replace a file another process is reading. */
export const isTransientWindowsError = (error: unknown): boolean => {
  if (process.platform !== "win32") return false;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSIENT_WINDOWS_CODES.has(code);
};
export const retryTransient = <T>(run: () => T): T => {
  if (process.platform !== "win32") return run();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return run();
    } catch (error) {
      if (attempt >= 20 || !isTransientWindowsError(error)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * (attempt + 1));
    }
  }
};
const renameWithRetry = (from: string, to: string) => retryTransient(() => fs.renameSync(from, to));
