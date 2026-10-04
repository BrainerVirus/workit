import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  gateCheckNames,
  loadCheckConfig,
  matchesNamedCheck,
  splitCommand,
} from "@/packages/workit-core/src/check-config";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, utimesSync } from "node:fs";
import { worktreeSignal } from "@/packages/workit-core/src/git/rev";
import {
  MAX_LOG_BYTES,
  StreamRedactor,
  TailBuffer,
  cmdArgument,
  planSpawn,
  pruneCheckLogs,
  redactLog,
  runCheckCommand,
  tailLines,
} from "@/packages/workit-core/src/checks";

// Named-check config and the bounded, redacted runner behind `workit check` (S9b).

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const dir = (files: Record<string, string> = {}): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-checks-"));
  dirs.push(root);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(root, name), text);
  return root;
};

test("splitCommand groups quotes and refuses shell syntax", () => {
  expect(splitCommand(`bun test --filter "a b" 'c'`)).toEqual([
    "bun",
    "test",
    "--filter",
    "a b",
    "c",
  ]);
  for (const shell of ["bun test | tee x", "echo $HOME", "a && b", "ls *.ts", "x > y"])
    expect(splitCommand(shell)).toBeInstanceOf(Error);
  expect(splitCommand(`echo "open`)).toBeInstanceOf(Error);
  expect(splitCommand("   ")).toBeInstanceOf(Error);
});

test("workit.checks.json wins; argv must match exactly, from the repo top", () => {
  const root = dir({
    "workit.checks.json": JSON.stringify({
      checks: { test: "bun test", lint: ["bun", "run", "lint"] },
    }),
    "package.json": JSON.stringify({ scripts: { typecheck: "tsc" } }),
  });
  const config = loadCheckConfig(root);
  expect(config).toMatchObject({ source: "workit.checks.json", error: null });
  expect(config.checks.map((check) => check.name)).toEqual(["test", "lint"]);
  expect(matchesNamedCheck(config, "test", ["bun", "test"], ".")).toBe(true);
  expect(matchesNamedCheck(config, "test", ["bun", "test", "--bail"], ".")).toBe(false);
  expect(matchesNamedCheck(config, "test", ["true"], ".")).toBe(false);
  expect(matchesNamedCheck(config, "test", ["bun", "test"], "packages/x")).toBe(false);
  expect(matchesNamedCheck(config, null, ["bun", "test"], ".")).toBe(false);
  expect(matchesNamedCheck(config, "typecheck", ["bun", "run", "typecheck"], ".")).toBe(false);
  expect(gateCheckNames(config, "testing")).toEqual(["test"]);
  expect(gateCheckNames(config, "verification")).toEqual(["test", "lint"]);
});

test("package.json scripts are named checks run through the lockfile's package manager", () => {
  const bun = loadCheckConfig(
    dir({ "bun.lock": "", "package.json": JSON.stringify({ scripts: { test: "x", build: "y" } }) }),
  );
  expect(bun.source).toBe("defaults");
  expect(bun.checks).toEqual([
    { name: "test", argv: ["bun", "run", "test"], accepts: [["bun", "run", "test"]] },
  ]);
  // `bun test` is bun's own runner, not the script.
  expect(matchesNamedCheck(bun, "test", ["bun", "test"], ".")).toBe(false);
  const npm = loadCheckConfig(
    dir({ "package.json": JSON.stringify({ scripts: { test: "x", lint: "y" } }) }),
  );
  expect(matchesNamedCheck(npm, "test", ["npm", "test"], ".")).toBe(true);
  expect(matchesNamedCheck(npm, "lint", ["npm", "lint"], ".")).toBe(false);
  const pnpm = loadCheckConfig(
    dir({ "pnpm-lock.yaml": "", "package.json": JSON.stringify({ scripts: { lint: "y" } }) }),
  );
  expect(matchesNamedCheck(pnpm, "lint", ["pnpm", "lint"], ".")).toBe(true);
  // testing binds only to `test`, never to "any configured check".
  expect(gateCheckNames(pnpm, "testing")).toEqual([]);
  expect(gateCheckNames(pnpm, "verification")).toEqual(["lint"]);
  expect(loadCheckConfig(dir())).toMatchObject({ source: "none", checks: [], error: null });
  expect(gateCheckNames(loadCheckConfig(dir()), "testing")).toEqual([]);
});

test("a broken workit.checks.json is an error, and nothing matches it", () => {
  for (const text of [
    "{",
    JSON.stringify({ checks: [] }),
    JSON.stringify({ checks: { test: "a | b" } }),
    JSON.stringify({ checks: { "Bad Name": "x" } }),
  ]) {
    const config = loadCheckConfig(dir({ "workit.checks.json": text }));
    expect(config.error, text).toBeString();
    expect(matchesNamedCheck(config, "test", ["a"], ".")).toBe(false);
  }
});

test("redactLog masks tokens, key=value secrets, URL credentials and escapes", () => {
  const out = redactLog(
    [
      "\u001b[31mFAIL\u001b[0m",
      "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "clone https://user:hunter2@example.com/repo.git",
      "auth: Bearer abcdefghijklmnop",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
    ].join("\n"),
  );
  expect(out).toContain("FAIL");
  expect(out).not.toContain("\u001b");
  // Observed output is otherwise kept as is (no path rewriting).
  expect(redactLog('at C:\\repo\\src\\a.ts:1 "q\\"q"')).toBe('at C:\\repo\\src\\a.ts:1 "q\\"q"');
  for (const secret of ["ghp_abcdefghij", "hunter2", "abcdefghijklmnop", "MIIabc"])
    expect(out).not.toContain(secret);
});

test("tailLines keeps the last lines, bounded in width", () => {
  const text = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
  expect(tailLines(`${text}\n\n`, 3)).toEqual(["line 197", "line 198", "line 199"]);
  expect(tailLines("x".repeat(1000), 1)[0]).toHaveLength(401);
});

test("runCheckCommand streams output, keeps only the newest bytes, and mirrors the exit code", async () => {
  let streamed = 0;
  const big = await runCheckCommand(
    [
      process.execPath,
      "-e",
      `process.stdout.write("x".repeat(${MAX_LOG_BYTES}) + "\\nlast line\\n"); process.exitCode = 7`,
    ],
    { cwd: os.tmpdir(), onStdout: (text) => void (streamed += text.length) },
  );
  expect(big.exitCode).toBe(7);
  expect(streamed).toBe(MAX_LOG_BYTES + 11);
  expect(big.truncated).toBe(true);
  expect(Buffer.byteLength(big.log)).toBeLessThanOrEqual(MAX_LOG_BYTES);
  expect(tailLines(big.log, 1)).toEqual(["last line"]);
  const missing = await runCheckCommand(["workit-no-such-binary-xyz"], { cwd: os.tmpdir() });
  expect(missing).toMatchObject({ exitCode: 127, spawnError: "ENOENT" });
  // A spawn that throws synchronously (invalid argument) also settles as 127.
  const invalid = await runCheckCommand(["bad\0name"], { cwd: os.tmpdir(), timeoutMs: 1000 });
  expect(invalid.exitCode).toBe(127);
  expect(invalid.spawnError).toBeString();
});

test("ecosystem defaults: go, cargo, pytest and a Makefile test target are named `test` checks", () => {
  const argvOf = (files: Record<string, string>) => loadCheckConfig(dir(files)).checks[0]?.argv;
  expect(argvOf({ "go.mod": "module x\n" })).toEqual(["go", "test", "./..."]);
  expect(argvOf({ "Cargo.toml": "[package]\n" })).toEqual(["cargo", "test"]);
  expect(argvOf({ "pytest.ini": "[pytest]\n" })).toEqual(["pytest"]);
  expect(argvOf({ "pyproject.toml": "[tool.pytest.ini_options]\n" })).toEqual(["pytest"]);
  expect(argvOf({ "pyproject.toml": "[tool.black]\n" })).toBeUndefined();
  expect(argvOf({ Makefile: "build:\n\tcc x.c\ntest: build\n\t./run\n" })).toEqual([
    "make",
    "test",
  ]);
  expect(argvOf({ Makefile: "test := 1\n" })).toBeUndefined();
  // package.json scripts come first.
  expect(
    argvOf({ "go.mod": "", "package.json": JSON.stringify({ scripts: { test: "x" } }) }),
  ).toEqual(["npm", "run", "test"]);
  expect(loadCheckConfig(dir({ "go.mod": "" })).source).toBe("defaults");
});

test("gates map in workit.checks.json binds a gate to named checks, and must name configured ones", () => {
  const config = loadCheckConfig(
    dir({
      "workit.checks.json": JSON.stringify({
        checks: { unit: "bun test", e2e: "bun run e2e", lint: "bun run lint" },
        gates: { testing: ["unit", "e2e"], verification: "lint" },
      }),
    }),
  );
  expect(config.error).toBeNull();
  expect(gateCheckNames(config, "testing")).toEqual(["unit", "e2e"]);
  expect(gateCheckNames(config, "verification")).toEqual(["lint"]);
  for (const gates of [{ testing: "missing" }, { deploy: "unit" }, { testing: [] }, []])
    expect(
      loadCheckConfig(
        dir({ "workit.checks.json": JSON.stringify({ checks: { unit: "bun test" }, gates }) }),
      ).error,
    ).toBeString();
});

test("Windows: argv[0] resolves through PATH/PATHEXT and .cmd shims run via an escaped cmd line", () => {
  const files = new Set([
    "C:\\tools\\npm.cmd",
    "C:\\bin\\bun.exe",
    "C:\\repo\\node_modules\\.bin\\vitest.cmd",
  ]);
  const options = {
    platform: "win32" as const,
    env: {
      Path: "C:\\bin;C:\\tools",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      ComSpec: "C:\\Windows\\cmd.exe",
    },
    cwd: "C:\\repo",
    // NTFS is case-insensitive; PATHEXT entries are upper case.
    isFile: (file: string) => [...files].some((item) => item.toLowerCase() === file.toLowerCase()),
  };
  expect(planSpawn(["bun", "test"], options)).toEqual({
    file: "C:\\bin\\bun.EXE",
    args: ["test"],
    verbatim: false,
    shell: false,
  });
  expect(
    planSpawn(["npm", "run", "test", "a b", 'say "hi"', "x&y", "100%", "end\\"], options),
  ).toEqual({
    file: "C:\\Windows\\cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      '"C:\\tools\\npm.CMD ^"run^" ^"test^" ^"a^ b^" ^"say^ \\^"hi\\^"^" ^"x^&y^" ^"100^%^" ^"end\\\\^""',
    ],
    verbatim: true,
    shell: false,
  });
  // node_modules/.bin shims re-parse their arguments: double escaping.
  const shim = planSpawn(["node_modules\\.bin\\vitest", "a&b"], options);
  expect(shim.args[3]).toBe('"C:\\repo\\node_modules\\.bin\\vitest.CMD ^^^"a^^^&b^^^""');
  // Unresolved commands are left to the OS (ENOENT → exit 127).
  expect(planSpawn(["nope"], options)).toMatchObject({ file: "nope", verbatim: false });
  expect(planSpawn(["npm", "test"], { ...options, platform: "linux" })).toEqual({
    file: "npm",
    args: ["test"],
    verbatim: false,
    shell: false,
  });
  expect(cmdArgument("plain")).toBe('^"plain^"');
});

test("redaction happens before bounding: a key cut from its header never leaks", () => {
  const out: string[] = [];
  const redactor = new StreamRedactor((text) => out.push(text));
  const key = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    ...Array(3000).fill("b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB"),
    "-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");
  // Split the key across many writes and both streams' interleaving.
  for (let index = 0; index < key.length; index += 997)
    redactor.write("stdout", key.slice(index, index + 997));
  redactor.write("stdout", "\nafter the key\n");
  redactor.end();
  const text = out.join("");
  expect(text).toContain("[REDACTED PRIVATE KEY]");
  expect(text).toContain("after the key");
  expect(text).not.toContain("b3BlbnNz");
  // Bounding the redacted text to fewer bytes than the key cannot expose it.
  const buffer = new TailBuffer(200);
  buffer.push(text);
  expect(buffer.text()).not.toContain("b3BlbnNz");
});

test("TailBuffer drops the partial first line after a cut, and only then", () => {
  const buffer = new TailBuffer(25);
  buffer.push("first-line-0123456789\n");
  buffer.push("second-line\nthird\n");
  expect(buffer.text()).toBe("second-line\nthird\n");
  const whole = new TailBuffer(100);
  whole.push("a\nb\n");
  expect(whole.text()).toBe("a\nb\n");
});

test.skipIf(process.platform === "win32")(
  "--timeout kills the whole process group and returns near the timeout, leaving no orphan",
  async () => {
    const marker = `${Math.floor(Math.random() * 1000)}.37`;
    const started = Date.now();
    const run = await runCheckCommand(
      ["sh", "-c", `sleep 8.${marker.replace(".", "")}; echo done`],
      {
        cwd: os.tmpdir(),
        timeoutMs: 400,
      },
    );
    expect(run.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(run.exitCode).toBe(128 + os.constants.signals.SIGKILL);
    const ps = spawnSync("ps", ["-eo", "args"], { encoding: "utf8" }).stdout;
    expect(ps).not.toContain(`sleep 8.${marker.replace(".", "")}`);
    // A background leftover holding the pipes open cannot hang a finished run.
    const leftover = await runCheckCommand(
      ["sh", "-c", `sleep 9.${marker.replace(".", "")} & echo hi`],
      {
        cwd: os.tmpdir(),
      },
    );
    expect(leftover.exitCode).toBe(0);
    expect(leftover.log).toContain("hi");
    expect(spawnSync("ps", ["-eo", "args"], { encoding: "utf8" }).stdout).not.toContain(
      `sleep 9.${marker.replace(".", "")}`,
    );
  },
);

test("pruneCheckLogs keeps the newest logs within count, age and size caps", () => {
  const root = dir();
  const logs = path.join(root, "blobs", "logs");
  mkdirSync(logs, { recursive: true });
  const now = Date.now();
  for (let index = 0; index < 5; index += 1) {
    const file = path.join(logs, `${index}.log`);
    writeFileSync(file, "x".repeat(10));
    const at = (now - index * 86_400_000) / 1000;
    utimesSync(file, at, at);
  }
  writeFileSync(path.join(logs, "old.log.1.2.tmp"), "t");
  utimesSync(
    path.join(logs, "old.log.1.2.tmp"),
    (now - 7_200_000) / 1000,
    (now - 7_200_000) / 1000,
  );
  expect(
    pruneCheckLogs(root, {
      dryRun: true,
      now,
      retention: { maxCount: 3, maxAgeMs: 10 * 86_400_000 },
    }),
  ).toEqual({ removed: 3, removedBytes: 21, kept: 3 });
  expect(readdirSync(logs)).toHaveLength(6);
  expect(pruneCheckLogs(root, { now, retention: { maxAgeMs: 1.5 * 86_400_000 } })).toMatchObject({
    kept: 2,
  });
  expect(readdirSync(logs).toSorted()).toEqual(["0.log", "1.log"]);
  expect(pruneCheckLogs(root, { now, retention: { maxBytes: 15 } })).toMatchObject({ kept: 1 });
});

const gitIn = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", ["-c", "protocol.file.allow=always", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
const gitRepo = (): string => {
  const root = dir();
  gitIn(root, "init", "-q", "-b", "main");
  gitIn(root, "config", "user.email", "t@example.invalid");
  gitIn(root, "config", "user.name", "T");
  gitIn(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "a.txt"), "one\n");
  gitIn(root, "add", ".");
  gitIn(root, "commit", "-qm", "base");
  return root;
};

test("worktreeSignal sees re-edits of a dirty file, mode changes, nested-repo commits and submodule moves", () => {
  const root = gitRepo();
  const seen = new Set<string>();
  const next = (label: string) => {
    const value = worktreeSignal(root);
    expect(value, label).toStartWith("sig:");
    expect(seen.has(value!), label).toBe(false);
    seen.add(value!);
  };
  next("clean");
  writeFileSync(path.join(root, "a.txt"), "two\n!\n");
  next("dirty");
  // Re-edit the already-dirty file: status stays " M a.txt", size and mtime move.
  writeFileSync(path.join(root, "a.txt"), "three\n");
  next("re-edited");
  if (process.platform !== "win32") {
    chmodSync(path.join(root, "a.txt"), 0o755);
    next("chmod +x on a dirty file");
  }
  // An untracked nested repository is listed as one directory entry.
  const nested = path.join(root, "nested");
  mkdirSync(nested);
  gitIn(nested, "init", "-q", "-b", "main");
  gitIn(nested, "config", "user.email", "t@example.invalid");
  gitIn(nested, "config", "user.name", "T");
  gitIn(nested, "config", "commit.gpgsign", "false");
  gitIn(nested, "commit", "-q", "--allow-empty", "-m", "n1");
  next("nested repo");
  gitIn(nested, "commit", "-q", "--allow-empty", "-m", "n2");
  next("nested repo commit");
  // A submodule moved twice reads " M sub" both times; its HEAD tells them apart.
  const upstream = gitRepo();
  const first = gitIn(upstream, "rev-parse", "HEAD");
  gitIn(upstream, "commit", "-q", "--allow-empty", "-m", "u2");
  const second = gitIn(upstream, "rev-parse", "HEAD");
  gitIn(upstream, "commit", "-q", "--allow-empty", "-m", "u3");
  gitIn(root, "submodule", "add", "-q", upstream, "sub");
  gitIn(root, "commit", "-qm", "add sub");
  next("submodule recorded");
  gitIn(path.join(root, "sub"), "checkout", "-q", first);
  next("submodule moved");
  gitIn(path.join(root, "sub"), "checkout", "-q", second);
  next("submodule moved again");
  // Unchanged state reads the same signal.
  expect(worktreeSignal(root)).toBe([...seen].at(-1)!);
});

test("a key without END stops being suppressed at the first non-key line; key state spans both streams", () => {
  const out: string[] = [];
  const redactor = new StreamRedactor((text) => out.push(text));
  redactor.write("stderr", "-----BEGIN RSA PRIVATE KEY-----\n");
  redactor.write("stderr", "MIIEowIBAAKCAQEAzjHxV1e7PrivateKeyBody0000000000000\n");
  // A base64-looking line on the other stream while the key is open is dropped…
  redactor.write("stdout", "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIzNDU2Nzg5MA==\n");
  // …but ordinary output from the other stream still passes through.
  redactor.write("stdout", "(pass) other stream keeps flowing\n");
  redactor.write("stderr", "Proc-Type: 4,ENCRYPTED\n");
  redactor.write("stderr", "e7PrivateKeyBody0000000000000000000000000000000000\n");
  // Truncated: no END line; the next ordinary line from stderr ends the key.
  redactor.write("stderr", "error: 3 tests failed\n(fail) the rest of the log survives\n");
  // The key is closed: later base64-looking output is ordinary log again.
  redactor.write("stderr", "deadbeef0123456789\n");
  redactor.end();
  const text = out.join("");
  expect(text).toContain("[REDACTED PRIVATE KEY]");
  expect(text).toContain("(pass) other stream keeps flowing");
  expect(text).toContain("error: 3 tests failed");
  expect(text).toContain("(fail) the rest of the log survives");
  expect(text).toContain("deadbeef0123456789");
  for (const secret of [
    "MIIEowIBAAKCAQEAzjHx",
    "QUJDREVGR0hJSktM",
    "e7PrivateKeyBody",
    "ENCRYPTED",
  ])
    expect(text).not.toContain(secret);
  // A key with neither END nor a non-key line is bounded too.
  const capped: string[] = [];
  const bounded = new StreamRedactor((chunk) => capped.push(chunk));
  bounded.write("stdout", "-----BEGIN PRIVATE KEY-----\n");
  for (let index = 0; index < 5000; index += 1) bounded.write("stdout", "QUFBQUFB\n");
  bounded.write("stdout", "after\n");
  bounded.end();
  expect(capped.join("")).toContain("after");
});
