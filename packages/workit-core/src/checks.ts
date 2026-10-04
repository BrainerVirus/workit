// Check runs for `workit check` (design §2.1 S9, §2.2; D5, D14): no shell
// (unless the caller passes one string with --shell), the child's output
// streams through while a bounded, redacted copy is kept for the log blob
// (`<store>/blobs/logs/<sha256>.log`) and the tail. Named-check config lives
// in check-config.ts.
//
// Plain TS over node built-ins: no zod, no task store.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { redactText } from "./forge/redact";

// ---------------------------------------------------------------------------
// bounded, redacted capture

/** Bytes of combined output kept for the log blob (the newest bytes win). */
export const MAX_LOG_BYTES = 2 * 1024 * 1024;
export const TAIL_LINES = 80;
const MAX_LINE_CHARS = 400;

/**
 * Mask secrets and strip terminal escapes from captured output with the forge
 * redaction (tokens, key=value and quoted secrets, URL credentials, private
 * keys, signed URLs, credential-looking base64). The logger's redaction is not
 * used: it rewrites Windows backslashes and home paths, which would alter the
 * observed output.
 */
export const redactLog = (text: string): string => redactText(text);

/** The last `lines` non-empty lines, each cut to a bounded width. */
export function tailLines(text: string, lines: number = TAIL_LINES): string[] {
  const all = text.replace(/\r\n?/gu, "\n").split("\n");
  while (all.length && !all.at(-1)?.trim()) all.pop();
  return all
    .slice(-lines)
    .map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line));
}

/** Keeps the newest `max` bytes of already-redacted text. */
export class TailBuffer {
  private chunks: string[] = [];
  private size = 0;
  total = 0;
  constructor(private readonly max: number) {}
  push(text: string): void {
    const bytes = Buffer.byteLength(text);
    this.total += bytes;
    this.chunks.push(text);
    this.size += bytes;
    while (this.chunks.length > 1 && this.size - Buffer.byteLength(this.chunks[0]) >= this.max)
      this.size -= Buffer.byteLength(this.chunks.shift()!);
  }
  text(): string {
    const joined = Buffer.from(this.chunks.join(""));
    if (joined.length <= this.max) return joined.toString("utf8");
    const value = joined.subarray(joined.length - this.max).toString("utf8");
    // The head was cut: drop the partial first line.
    const newline = value.indexOf("\n");
    return newline >= 0 ? value.slice(newline + 1) : value;
  }
}

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/u;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/u;
const BATCH_BYTES = 64 * 1024;
const MAX_PENDING = 64 * 1024;

/** Lines that can belong to a PEM body: base64 (or blank), or an RFC 1421 encapsulated header. */
const PEM_BODY = /^(?:[A-Za-z0-9+/=]*|(?:Proc-Type|DEK-Info|Comment): .*)\s*$/u;
/** Suppression bounds for a key whose END never appears (truncated output). */
const MAX_KEY_LINES = 4096;
const MAX_KEY_BYTES = 256 * 1024;

/**
 * Redacts output as it streams, before anything is bounded: complete lines
 * are redacted in batches, and a private key block is replaced as a whole
 * while its BEGIN line is still in view, so trimming the log to its newest
 * bytes can never cut a key loose from its header. Key state spans the merged
 * stdout+stderr log: while a key is open, base64-looking lines from either
 * stream are dropped. The key ends at its END line, at the first non-base64
 * line from the stream that began it, or after MAX_KEY_LINES/MAX_KEY_BYTES, so
 * a key without an END never swallows the rest of the log. Non-key lines from
 * the other stream pass through. A line longer than 64 KB is treated as complete.
 */
export class StreamRedactor {
  private pending = new Map<string, string>();
  private key: { stream: string; lines: number; bytes: number } | null = null;
  private batch: string[] = [];
  private batchBytes = 0;
  constructor(private readonly sink: (text: string) => void) {}
  write(stream: string, text: string): void {
    let rest = (this.pending.get(stream) ?? "") + text;
    for (let newline = rest.indexOf("\n"); newline >= 0; newline = rest.indexOf("\n")) {
      this.line(stream, rest.slice(0, newline + 1));
      rest = rest.slice(newline + 1);
    }
    if (rest.length > MAX_PENDING) {
      this.line(stream, rest);
      rest = "";
    }
    this.pending.set(stream, rest);
  }
  end(): void {
    for (const [stream, rest] of this.pending) if (rest) this.line(stream, `${rest}\n`);
    this.pending.clear();
    this.flush();
  }
  private line(stream: string, line: string): void {
    if (this.key) {
      if (PEM_END.test(line)) {
        this.key = null;
        return;
      }
      const body = PEM_BODY.test(line);
      if (body) {
        this.key.lines += 1;
        this.key.bytes += line.length;
        if (this.key.lines > MAX_KEY_LINES || this.key.bytes > MAX_KEY_BYTES) this.key = null;
        return;
      }
      if (stream === this.key.stream) this.key = null;
    }
    const begin = line.search(PEM_BEGIN);
    if (begin >= 0) {
      if (!PEM_END.test(line.slice(begin))) this.key = { stream, lines: 0, bytes: 0 };
      this.push(`${line.slice(0, begin)}[REDACTED PRIVATE KEY]\n`);
      return;
    }
    this.push(line);
  }
  private push(line: string): void {
    this.batch.push(line);
    this.batchBytes += line.length;
    if (this.batchBytes >= BATCH_BYTES) this.flush();
  }
  private flush(): void {
    if (!this.batch.length) return;
    this.sink(redactLog(this.batch.join("")));
    this.batch = [];
    this.batchBytes = 0;
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
  /** Total bytes of redacted output (before bounding). */
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
  /** For tests: the platform whose spawn rules apply (default: process.platform). */
  platform?: NodeJS.Platform;
};

// cmd.exe metacharacters (the cross-spawn set).
const CMD_META = /([()\][%!^"`<>&|;, *?])/gu;

/** One argument for a `cmd /d /s /c "…"` line; `double` for node_modules/.bin shims, which re-parse. */
export function cmdArgument(arg: string, double = false): string {
  let out = arg.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\*)$/u, "$1$1");
  out = `"${out}"`.replace(CMD_META, "^$1");
  return double ? out.replace(CMD_META, "^$1") : out;
}

export type SpawnPlan = {
  file: string;
  args: string[];
  /** Pass the args to CreateProcess verbatim (cmd.exe lines carry their own quoting). */
  verbatim: boolean;
  shell: boolean;
};

/**
 * How to start argv without a shell. On Windows, argv[0] is resolved through
 * PATH and PATHEXT (CreateProcess finds only .exe/.com); a .cmd/.bat shim
 * (npm, pnpm, yarn, node_modules/.bin) runs as `cmd.exe /d /s /c "<line>"`
 * with every argument escaped, so the observed argv (and `configured`) stay
 * the configured ones. Null `isFile` uses the real filesystem.
 */
export function planSpawn(
  argv: readonly string[],
  options: {
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    cwd: string;
    shell?: boolean;
    isFile?: (file: string) => boolean;
  },
): SpawnPlan {
  if (options.shell) return { file: argv[0], args: [], verbatim: false, shell: true };
  if (options.platform !== "win32")
    return { file: argv[0], args: argv.slice(1), verbatim: false, shell: false };
  const win = path.win32;
  const isFile =
    options.isFile ??
    ((file: string) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });
  // Windows names are case-insensitive; an exact upper-case key wins over a duplicate.
  const env = (name: string): string | undefined =>
    options.env[name] ??
    Object.entries(options.env).find(([key]) => key.toUpperCase() === name)?.[1];
  const exts = (env("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const command = argv[0];
  const hasDir = /[\\/]/u.test(command);
  const dirs = hasDir ? [""] : (env("PATH") ?? "").split(";").filter(Boolean);
  const candidates = (base: string) =>
    win.extname(base) ? [base, ...exts.map((ext) => base + ext)] : exts.map((ext) => base + ext);
  let resolved: string | null = null;
  for (const dir of dirs) {
    const base = hasDir ? win.resolve(options.cwd, command) : win.join(dir, command);
    resolved = candidates(base).find(isFile) ?? null;
    if (resolved) break;
  }
  if (!resolved) return { file: command, args: argv.slice(1), verbatim: false, shell: false };
  if (!/\.(?:cmd|bat)$/iu.test(resolved))
    return { file: resolved, args: argv.slice(1), verbatim: false, shell: false };
  const double = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/iu.test(resolved);
  const line = [
    win.normalize(resolved).replace(CMD_META, "^$1"),
    ...argv.slice(1).map((arg) => cmdArgument(arg, double)),
  ].join(" ");
  return {
    file: env("COMSPEC") ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    verbatim: true,
    shell: false,
  };
}

/** After the child exits, how long its pipes may stay open (held by leftovers) before they are cut. */
const DRAIN_MS = 250;
const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Run one command, streaming its output to the callbacks while a redacted,
 * bounded copy is captured. With `shell`, argv must be a single command
 * string. On POSIX the child leads its own process group (stdin is not
 * inherited), so a timeout, or the exit of the command, kills every process
 * it started; Ctrl-C and SIGTERM sent to workit are forwarded to the group.
 * On Windows the tree is killed with `taskkill /T /F`. The run settles on
 * the child's exit plus a short drain, so a leftover holding the pipes open
 * cannot hang it.
 */
export function runCheckCommand(argv: readonly string[], options: RunOptions): Promise<CheckRun> {
  const started = Date.now();
  const platform = options.platform ?? process.platform;
  const windows = process.platform === "win32";
  const buffer = new TailBuffer(MAX_LOG_BYTES);
  const redactor = new StreamRedactor((text) => buffer.push(text));
  const env = options.env ?? process.env;
  const plan = planSpawn(argv, { platform, env, cwd: options.cwd, shell: options.shell });
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let drain: NodeJS.Timeout | null = null;
    let child: ReturnType<typeof spawn>;
    let timer: NodeJS.Timeout | null = null;
    const killTree = () => {
      if (!child?.pid) return;
      if (windows)
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      else
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group is already gone.
        }
    };
    const forwarders = new Map<NodeJS.Signals, () => void>();
    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (drain) clearTimeout(drain);
      for (const [name, handler] of forwarders) process.off(name, handler);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      if (spawnError) redactor.write("workit", `workit: cannot start ${argv[0]}: ${spawnError}\n`);
      redactor.end();
      resolve({
        exitCode: spawnError
          ? 127
          : code !== null
            ? code
            : 128 + (signal ? (os.constants.signals[signal] ?? 1) : 1),
        signal: signal ?? null,
        timedOut,
        durationMs: Date.now() - started,
        log: buffer.text(),
        outputBytes: buffer.total,
        truncated: buffer.total > MAX_LOG_BYTES,
        spawnError: spawnError ?? null,
      });
    };
    const spawnOptions = {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: !windows,
      windowsVerbatimArguments: plan.verbatim,
      shell: plan.shell,
    };
    try {
      child = spawn(plan.file, plan.args, spawnOptions);
    } catch (error) {
      finish(null, null, (error as NodeJS.ErrnoException).code ?? (error as Error).message);
      return;
    }
    if (!windows)
      for (const name of FORWARDED_SIGNALS) {
        const handler = () => {
          if (child.pid)
            try {
              process.kill(-child.pid, name);
            } catch {
              // Already gone.
            }
        };
        forwarders.set(name, handler);
        process.on(name, handler);
      }
    if (options.timeoutMs && options.timeoutMs > 0)
      timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, options.timeoutMs);
    const forward = (
      name: string,
      stream: NodeJS.ReadableStream | null,
      sink?: (text: string) => void,
    ) => {
      if (!stream) return;
      const decoder = new StringDecoder("utf8");
      stream.on("data", (chunk: Buffer) => {
        const text = decoder.write(chunk);
        redactor.write(name, text);
        if (sink) sink(text);
      });
      stream.on("end", () => {
        const rest = decoder.end();
        if (rest) {
          redactor.write(name, rest);
          if (sink) sink(rest);
        }
      });
      stream.on("error", () => {
        // A destroyed pipe after the drain: the captured output stands.
      });
    };
    forward("stdout", child.stdout, options.onStdout);
    forward("stderr", child.stderr, options.onStderr);
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish(null, null, error.code ?? error.message),
    );
    child.on("exit", (code, signal) => {
      // Leftovers of the command die with it; then give the pipes a moment.
      if (!windows) killTree();
      drain = setTimeout(() => finish(code, signal), DRAIN_MS);
    });
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

export type LogPruneReport = { removed: number; removedBytes: number; kept: number };

/** Check-log retention for `workit gc`: newest 200, at most 30 days old, at most 256 MB. */
export const LOG_RETENTION = {
  maxCount: 200,
  maxAgeMs: 30 * 86_400_000,
  maxBytes: 256 * 1024 * 1024,
};

/**
 * Prune `<storeRoot>/blobs/logs`: keep the newest logs within the count, age
 * and size caps, and drop leftover temp files. Evidence keeps its logDigest
 * when its blob is pruned. `dryRun` only reports.
 */
export function pruneCheckLogs(
  storeRoot: string,
  options: { dryRun?: boolean; now?: number; retention?: Partial<typeof LOG_RETENTION> } = {},
): LogPruneReport {
  const limits = { ...LOG_RETENTION, ...options.retention };
  const now = options.now ?? Date.now();
  const dir = path.join(storeRoot, "blobs", "logs");
  const report: LogPruneReport = { removed: 0, removedBytes: 0, kept: 0 };
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return report;
  }
  const files = names
    .flatMap((name) => {
      try {
        const stat = fs.statSync(path.join(dir, name));
        return stat.isFile() ? [{ name, size: stat.size, mtimeMs: stat.mtimeMs }] : [];
      } catch {
        return [];
      }
    })
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs);
  let keptBytes = 0;
  for (const file of files) {
    const temp = file.name.endsWith(".tmp");
    const keep =
      !temp &&
      report.kept < limits.maxCount &&
      now - file.mtimeMs <= limits.maxAgeMs &&
      keptBytes + file.size <= limits.maxBytes;
    if (keep) {
      report.kept += 1;
      keptBytes += file.size;
      continue;
    }
    if (temp && now - file.mtimeMs < 3_600_000) continue;
    if (!options.dryRun)
      try {
        fs.rmSync(path.join(dir, file.name), { force: true });
      } catch {
        continue;
      }
    report.removed += 1;
    report.removedBytes += file.size;
  }
  return report;
}
