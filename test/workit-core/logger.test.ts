import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createLogger,
  redact,
  resolveStateDir,
  type JsonValue,
} from "../../packages/workit-core/src/core/logger";

const tempDirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-logger-"));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const logsDir = (stateDir: string): string => path.join(stateDir, "logs");

const readRecords = (stateDir: string): { line: string; record: Record<string, unknown> }[] => {
  const dir = logsDir(stateDir);
  const out: { line: string; record: Record<string, unknown> }[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl"))) {
    const raw = readFileSync(path.join(dir, file), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      out.push({ line, record: JSON.parse(line) as Record<string, unknown> });
    }
  }
  return out;
};

const assertJsonValue = (value: unknown): JsonValue => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value as JsonValue;
  }
  if (Array.isArray(value)) return value.map(assertJsonValue);
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertJsonValue(entry);
      expect(typeof key).toBe("string");
    }
    return value as JsonValue;
  }
  throw new Error(`not a JsonValue: ${String(value)}`);
};

test("appends sanitized JSONL records", () => {
  const stateDir = tempDir();
  const logger = createLogger({ stateDir });
  logger.info("started", { status: "ok", retries: 0 });
  logger.error("failed", { code: 500, nested: { a: [1, true, null, "x"] } });

  const records = readRecords(stateDir);
  expect(records.length).toBe(2);
  expect(records[0].record.level).toBe("info");
  expect(records[0].record.message).toBe("started");
  expect(records[0].record.context).toEqual({ status: "ok", retries: 0 });
  expect(records[1].record.level).toBe("error");
  expect(records[1].record.message).toBe("failed");
  expect(records[1].record.context).toEqual({ code: 500, nested: { a: [1, true, null, "x"] } });
  const file = readdirSync(logsDir(stateDir))[0];
  expect(readFileSync(path.join(logsDir(stateDir), file), "utf8")).toMatch(/\n$/);
  for (const { record } of records) assertJsonValue(record);
});

test("uses a daily JSONL filename per day", () => {
  const stateDir = tempDir();
  const day1 = new Date(2026, 7, 10, 12);
  const day2 = new Date(2026, 7, 11, 12);
  let current = day1;
  const logger = createLogger({ stateDir, now: () => current });
  logger.info("one");
  current = day2;
  logger.info("two");

  const files = readdirSync(logsDir(stateDir)).sort();
  expect(files).toEqual(["workit-2026-08-10.jsonl", "workit-2026-08-11.jsonl"]);
});

test("retains the newest seven daily files", () => {
  const stateDir = tempDir();
  const dir = logsDir(stateDir);
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 7; i++) {
    const day = i < 10 ? `0${i}` : String(i);
    writeFileSync(path.join(dir, `workit-2026-08-${day}.jsonl`), '{"seed":true}\n');
  }
  const logger = createLogger({ stateDir, now: () => new Date(2026, 7, 8) });
  logger.info("today");

  const files = readdirSync(dir).sort();
  expect(files.length).toBe(7);
  expect(files).not.toContain("workit-2026-08-01.jsonl");
  expect(files).toContain("workit-2026-08-02.jsonl");
  expect(files[files.length - 1]).toBe("workit-2026-08-08.jsonl");
});

test.skipIf(process.platform === "win32")("creates logs with restrictive permissions", () => {
  const stateDir = tempDir();
  const logger = createLogger({ stateDir });
  logger.info("x");

  const file = readdirSync(logsDir(stateDir))[0];
  expect(statSync(path.join(logsDir(stateDir), file)).mode & 0o777).toBe(0o600);
  expect(statSync(logsDir(stateDir)).mode & 0o777).toBe(0o700);
});

test("concurrent appends lose no records", async () => {
  const stateDir = tempDir();
  mkdirSync(logsDir(stateDir), { recursive: true });
  const loggerPath = path.resolve(import.meta.dir, "../../packages/workit-core/src/core/logger.ts");
  const runWorker = (workerId: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const code = `
        import { createLogger } from ${JSON.stringify(loggerPath)};
        const stateDir = ${JSON.stringify(stateDir)};
        const workerId = ${JSON.stringify(workerId)};
        const logger = createLogger({ stateDir, maxRate: 1000 });
        for (let n = 0; n < 25; n++) {
          logger.info("concurrent", { worker: workerId, seq: n, id: workerId + "-" + n });
        }
      `;
      const child = spawn(process.execPath, ["-e", code], { stdio: "ignore" });
      child.on("exit", (status) =>
        status === 0 ? resolve() : reject(new Error(`worker ${workerId} exited ${status}`)),
      );
      child.on("error", reject);
    });

  await Promise.all([runWorker("w0"), runWorker("w1"), runWorker("w2"), runWorker("w3")]);

  const records = readRecords(stateDir);
  expect(records.length).toBe(4 * 25);
  const ids = new Set(records.map((r) => String((r.record.context as { id?: unknown }).id)));
  expect(ids.size).toBe(4 * 25);
  for (const { record } of records) assertJsonValue(record);
});

test("injectable sinks receive every event", () => {
  const stateDir = tempDir();
  const stderr: unknown[] = [];
  const appLog: unknown[] = [];
  const logger = createLogger({
    stateDir,
    stderr: (event) => stderr.push(event),
    appLog: (event) => appLog.push(event),
  });
  logger.info("mirrored", { scope: "startup" });

  expect(stderr.length).toBe(1);
  expect(appLog.length).toBe(1);
  expect(stderr[0]).toEqual(appLog[0]);
  expect((stderr[0] as { message: string }).message).toBe("mirrored");
  expect((stderr[0] as { context: unknown }).context).toEqual({ scope: "startup" });
  expect(readRecords(stateDir).length).toBe(1);
});

test("never writes to MCP stdout", () => {
  const stateDir = tempDir();
  const loggerPath = path.resolve(import.meta.dir, "../../packages/workit-core/src/core/logger.ts");
  const code = `
    import { createLogger } from ${JSON.stringify(loggerPath)};
    const stateDir = ${JSON.stringify(stateDir)};
    const logger = createLogger({
      stateDir,
      stderr: (event) => process.stderr.write(JSON.stringify(event) + "\\n"),
    });
    logger.info("cursor-summary", { scope: "startup" });
  `;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", code],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toContain("cursor-summary");
  const records = readRecords(stateDir);
  expect(records.length).toBe(1);
  expect((records[0].record.context as { scope: string }).scope).toBe("startup");
});

test("isolates failing detectors without breaking logging", () => {
  const stateDir = tempDir();
  const logger = createLogger({ stateDir });

  let threw = false;
  const result = logger.guard("bad-detector", () => {
    threw = true;
    throw new Error("boom");
  });
  expect(threw).toBe(true);
  expect(result).toBeUndefined();

  logger.info("still-works");
  const records = readRecords(stateDir);
  const warn = records.find((r) => r.record.level === "warn");
  expect(warn?.record.message).toBe("detector_failed");
  expect(warn?.record.context).toEqual({ detector: "bad-detector", error: "boom" });
  expect(records.length).toBe(2);

  const ok = logger.guard("ok-detector", () => 42);
  expect(ok).toBe(42);
});

test("rate limits bursts and recovers after the window", () => {
  const stateDir = tempDir();
  let current = new Date(2026, 7, 10, 12, 0, 0);
  const logger = createLogger({
    stateDir,
    now: () => current,
    maxRate: 3,
    rateWindowMs: 1000,
  });

  for (let i = 0; i < 5; i++) logger.info(`burst-${i}`);
  let records = readRecords(stateDir);
  expect(records.length).toBe(3);

  current = new Date(2026, 7, 10, 12, 0, 1, 500);
  logger.info("after-window");
  records = readRecords(stateDir);
  expect(records.length).toBe(4);
  expect(records[3].record.message).toBe("after-window");
});

test("redacts secrets, content, queries, home prefixes, and long stacks", () => {
  const stateDir = tempDir();
  const logger = createLogger({ stateDir });
  const home = os.homedir();
  const longStack = Array.from(
    { length: 100 },
    (_, i) => `    at fn${i} (file${i}.ts:${i}:${i})`,
  ).join("\n");
  logger.info("redact-check", {
    token: "sk-live-1234567890",
    authorization: "Bearer live-token-abc",
    password: "hunter2-secret",
    apiKey: "api-key-live",
    prompt: "translate this user prompt to french",
    message: "user content message",
    content: "file content body",
    url: "https://example.com/search?q=secret-query&token=qv",
    file: path.join(home, "workflow-toolkit", "config.json"),
    stack: longStack,
    nested: { credentials: { accessToken: "nested-secret" } },
  });

  const raw = readRecords(stateDir)
    .map((r) => r.line)
    .join("");
  expect(raw).toContain("[REDACTED]");
  expect(raw).not.toContain("sk-live-1234567890");
  expect(raw).not.toContain("live-token-abc");
  expect(raw).not.toContain("hunter2-secret");
  expect(raw).not.toContain("api-key-live");
  expect(raw).not.toContain("translate this user prompt");
  expect(raw).not.toContain("user content message");
  expect(raw).not.toContain("file content body");
  expect(raw).not.toContain("secret-query");
  expect(raw).not.toContain("nested-secret");
  expect(raw).not.toContain(home);
  expect(raw).toContain("~/workflow-toolkit/config.json");
  expect(raw).not.toContain("fn30 (");
  expect(raw).toContain("70 more");

  const records = readRecords(stateDir);
  expect(records.length).toBe(1);
  for (const { record } of records) assertJsonValue(record);
});

describe("redact", () => {
  test("coerces non-JSON values into JsonValue", () => {
    expect(redact(undefined)).toBeNull();
    expect(redact(() => 1)).toBeNull();
    expect(redact(12n)).toBeNull();
    expect(redact(5)).toBe(5);
    expect(redact("plain")).toBe("plain");
  });

  test("recursively redacts secrets and content by key", () => {
    expect(redact({ token: "t" })).toEqual({ token: "[REDACTED]" });
    expect(redact({ prompt: "p" })).toEqual({ prompt: "[REDACTED]" });
    expect(redact({ nested: { apiKey: "k" } })).toEqual({ nested: { apiKey: "[REDACTED]" } });
    expect(redact(["a", { password: "x" }])).toEqual(["a", { password: "[REDACTED]" }]);
    expect(redact({ messages: [{ role: "user" }] })).toEqual({ messages: "[REDACTED]" });
  });

  test("redacts value patterns for tokens, queries, and home prefixes", () => {
    expect(redact("Bearer abc123")).toBe("[REDACTED]");
    expect(redact("https://x.test/p?token=t&a=b")).toBe("https://x.test/p?[REDACTED]");
    expect(redact(path.join(os.homedir(), "repo"))).toBe("~/repo");
  });

  test("bounds long fields and stacks", () => {
    expect(redact("x".repeat(500))).toHaveLength(201);
    const stack = Array.from({ length: 100 }, (_, i) => `    at fn${i}`).join("\n");
    const bounded = redact({ stack }) as { stack: string };
    expect(bounded.stack).toContain("70 more");
    expect(bounded.stack).not.toContain("fn50");
  });
});

describe("resolveStateDir", () => {
  const keys = ["WORKFLOW_TOOLKIT_STATE", "XDG_STATE_HOME", "HOME", "LOCALAPPDATA"];
  const saved = new Map<string, string | undefined>();
  const setEnv = (values: Record<string, string | undefined>): void => {
    for (const key of keys) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
  };
  const restoreEnv = (): void => {
    for (const key of saved) {
      if (key[1] === undefined) delete process.env[key[0]];
      else process.env[key[0]] = key[1];
    }
    saved.clear();
  };

  test("honors the WORKFLOW_TOOLKIT_STATE override", () => {
    setEnv({ WORKFLOW_TOOLKIT_STATE: "/tmp/wf-state", XDG_STATE_HOME: undefined, HOME: undefined });
    expect(resolveStateDir()).toBe("/tmp/wf-state");
    restoreEnv();
  });

  test("uses XDG_STATE_HOME when set", () => {
    setEnv({
      WORKFLOW_TOOLKIT_STATE: undefined,
      XDG_STATE_HOME: "/xdg/state",
      HOME: undefined,
    });
    expect(resolveStateDir()).toBe(path.join("/xdg/state", "workit"));
    restoreEnv();
  });

  test.skipIf(process.platform !== "linux")("falls back to ~/.local/state on Linux", () => {
    setEnv({
      WORKFLOW_TOOLKIT_STATE: undefined,
      XDG_STATE_HOME: undefined,
      HOME: "/fake/home",
    });
    expect(resolveStateDir()).toBe(path.join("/fake/home", ".local", "state", "workit"));
    restoreEnv();
  });
});
