import {
  failure,
  success,
  type ContractResult as Result,
  type WorkerReport,
} from "@brainervirus/workit-core/src/core";
import { workerReportSchema } from "@brainervirus/workit-core/src/core/task-contract";

export const MAX_WORKER_LINE_BYTES = 64 * 1024;
export const MAX_WORKER_STDERR_BYTES = 64 * 1024;

export type WorkerProtocolEvent =
  | { type: "workit_worker_result"; report: WorkerReport }
  | { type: "workit_worker_ready"; workerId?: string; sessionId?: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseEvent = (value: unknown): WorkerProtocolEvent | null => {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "workit_worker_ready") {
    if (
      (value.workerId !== undefined && typeof value.workerId !== "string") ||
      (value.sessionId !== undefined && typeof value.sessionId !== "string")
    )
      return null;
    return {
      type: value.type,
      ...(value.workerId ? { workerId: value.workerId } : {}),
      ...(value.sessionId ? { sessionId: value.sessionId } : {}),
    };
  }
  if (value.type !== "workit_worker_result") return null;
  const parsed = workerReportSchema.safeParse(value.report);
  return parsed.success ? { type: value.type, report: parsed.data } : null;
};

export const parseWorkerLine = (line: string): WorkerProtocolEvent | null => {
  if (Buffer.byteLength(line, "utf8") > MAX_WORKER_LINE_BYTES) return null;
  try {
    return parseEvent(JSON.parse(line));
  } catch {
    return null;
  }
};

export const parseWorkerLines = (chunk: string): WorkerProtocolEvent[] => {
  const events: WorkerProtocolEvent[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = parseWorkerLine(line);
    if (event) events.push(event);
  }
  return events;
};

export const parseWorkerResult = (events: readonly unknown[]): Result<WorkerReport> => {
  let result: WorkerReport | null = null;
  for (const event of events) {
    const parsed = parseEvent(event);
    if (!parsed || parsed.type !== "workit_worker_result") continue;
    if (result) return failure("invalid_input", "worker emitted multiple results");
    result = parsed.report;
  }
  return result
    ? success(null, null, result)
    : failure("invalid_input", "worker result was not observed");
};

export const appendBoundedStderr = (current: string, chunk: string): string => {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") <= MAX_WORKER_STDERR_BYTES) return next;
  let bounded = next.slice(0, MAX_WORKER_STDERR_BYTES);
  while (Buffer.byteLength(bounded, "utf8") > MAX_WORKER_STDERR_BYTES)
    bounded = bounded.slice(0, -1);
  return bounded;
};
