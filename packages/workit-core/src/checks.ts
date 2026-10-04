// Check runs for `workit check` (design §2.1 S9, §2.2; D5, D14): no shell
// (unless the caller passes one string with --shell), the child's output
// streams through while a bounded, redacted copy is kept for the log blob
// (`<store>/blobs/logs/<sha256>.log`) and the tail. Named-check config lives
// in check-config.ts.
//
// Plain TS over node built-ins: no zod, no task store.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { redactSecrets } from "./core/logger";

// ---------------------------------------------------------------------------
// bounded, redacted capture

/** Bytes of combined output kept for the log blob (the newest bytes win). */
export const MAX_LOG_BYTES = 2 * 1024 * 1024;
export const TAIL_LINES = 80;
const MAX_LINE_CHARS = 400;

// Token formats that are secrets wherever they appear (on top of the
// logger's key=value, bearer and URL-query patterns).
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu,
  /\bgl[a-z]{1,8}-[A-Za-z0-9_-]{16,}/gu,
  /\bnpm_[A-Za-z0-9]{30,}/gu,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
];
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu;
const PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gu;
const ANSI = new RegExp(String.raw`\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007`, "gu");

/** Mask secrets and strip terminal escapes from captured output. */
export function redactLog(text: string): string {
  let out = text.replace(ANSI, "").replace(PRIVATE_KEY, "[REDACTED PRIVATE KEY]");
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  out = out.replace(URL_USERINFO, "$1[REDACTED]@");
  return out
    .split("\n")
    .map((line) => redactSecrets(line))
    .join("\n");
}

/** The last `lines` non-empty lines, each cut to a bounded width. */
export function tailLines(text: string, lines: number = TAIL_LINES): string[] {
  const all = text.replace(/\r\n?/gu, "\n").split("\n");
  while (all.length && !all.at(-1)?.trim()) all.pop();
  return all
    .slice(-lines)
    .map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line));
}

/** Keeps the newest `max` bytes of a byte stream. */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  total = 0;
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    this.total += chunk.length;
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size - (this.chunks[0]?.length ?? 0) >= this.max) {
      this.size -= this.chunks.shift()!.length;
    }
  }
  text(): string {
    const joined = Buffer.concat(this.chunks);
    const kept = joined.length > this.max ? joined.subarray(joined.length - this.max) : joined;
    // Drop a partial first line when the head was cut.
    const value = kept.toString("utf8");
    if (this.total <= this.max) return value;
    const newline = value.indexOf("\n");
    return newline >= 0 ? value.slice(newline + 1) : value;
  }
}

export type CheckRun = {
  /** The child's exit code; 128+n when killed by signal n; 127 when it could not start. */
  exitCode: number;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  /** Redacted, bounded combined output. */
  log: string;
  /** Total bytes the child wrote (before bounding). */
  outputBytes: number;
  truncated: boolean;
  /** Set when the command could not be started. */
  spawnError: string | null;
};

export type RunOptions = {
  cwd: string;
  shell?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Receives the child's stdout as it arrives. */
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
};

const SIGNALS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

/**
 * Run one command, streaming its output to the callbacks while a bounded copy
 * is captured. With `shell`, argv must be a single command string.
 */
export function runCheckCommand(argv: readonly string[], options: RunOptions): Promise<CheckRun> {
  const started = Date.now();
  const buffer = new TailBuffer(MAX_LOG_BYTES);
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const raw = buffer.text();
      resolve({
        exitCode: spawnError
          ? 127
          : code !== null
            ? code
            : 128 + (signal ? (SIGNALS[signal] ?? 1) : 1),
        signal: signal ?? null,
        timedOut,
        durationMs: Date.now() - started,
        log: redactLog(spawnError ? `${raw}workit: cannot start ${argv[0]}: ${spawnError}\n` : raw),
        outputBytes: buffer.total,
        truncated: buffer.total > MAX_LOG_BYTES,
        spawnError: spawnError ?? null,
      });
    };
    const child = options.shell
      ? spawn(argv[0], {
          cwd: options.cwd,
          env: options.env,
          shell: true,
          stdio: ["inherit", "pipe", "pipe"],
        })
      : spawn(argv[0], argv.slice(1), {
          cwd: options.cwd,
          env: options.env,
          stdio: ["inherit", "pipe", "pipe"],
          windowsHide: true,
        });
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs)
        : null;
    const forward = (stream: NodeJS.ReadableStream | null, sink?: (text: string) => void) => {
      if (!stream) return;
      const decoder = new StringDecoder("utf8");
      stream.on("data", (chunk: Buffer) => {
        buffer.push(chunk);
        if (sink) sink(decoder.write(chunk));
      });
      stream.on("end", () => {
        const rest = decoder.end();
        if (sink && rest) sink(rest);
      });
    };
    forward(child.stdout, options.onStdout);
    forward(child.stderr, options.onStderr);
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish(null, null, error.code ?? error.message),
    );
    child.on("close", (code, signal) => finish(code, signal));
  });
}

/** Content address of a stored log: `sha256:<hex>`. */
export const logDigest = (log: string): string =>
  `sha256:${createHash("sha256").update(log).digest("hex")}`;

/**
 * Store a redacted log under `<storeRoot>/blobs/logs/<hex>.log` (content
 * addressed, so concurrent writers of the same log agree). Returns the path
 * relative to the store root, or null when the write fails.
 */
export function storeLog(storeRoot: string, log: string): { digest: string; ref: string } | null {
  const digest = logDigest(log);
  const ref = `blobs/logs/${digest.slice("sha256:".length)}.log`;
  const file = path.join(storeRoot, ref);
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temp, log, { mode: 0o600 });
      fs.renameSync(temp, file);
    }
    return { digest, ref };
  } catch {
    return null;
  }
}
