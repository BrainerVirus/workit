import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATION_FAMILIES } from "@/packages/workit-core/src/core/task-contract";
import { main, parseGlobals } from "@/packages/workit-cli/src/main";
import { emit, fail, type EnvelopeCode, type Io } from "@/packages/workit-cli/src/output";
import { lockPathFor } from "@/packages/workit-core/src/core/store-lock";
import { TASK_FAMILY_NAMES, VERBS } from "@/packages/workit-cli/src/verbs/registry";

// S9a router (design §2.0 / §5): the verb table, the shared envelope and exit
// codes, and the cold-path guarantee that no verb statically loads ink/react.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliSrc = path.join(repoRoot, "packages/workit-cli/src");
const mainEntry = path.join(cliSrc, "main.ts");

const run = async (argv: string[], cwd?: string) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    ...(cwd ? { cwd } : {}),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr };
};

// ---------------------------------------------------------------------------
// Module graph: bundle the entry with a metafile and walk only STATIC imports.

type MetaInput = { imports?: Array<{ path: string; kind: string }> };
let inputs: Record<string, MetaInput> = {};
const scratch = mkdtempSync(path.join(os.tmpdir(), "wk-router-graph-"));

beforeAll(() => {
  const metafile = path.join(scratch, "meta.json");
  const built = spawnSync(
    process.execPath,
    [
      "build",
      mainEntry,
      "--target",
      "node",
      "--outdir",
      path.join(scratch, "out"),
      `--metafile=${metafile}`,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  expect(built.status, built.stderr).toBe(0);
  inputs = JSON.parse(readFileSync(metafile, "utf8")).inputs;
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const keyFor = (file: string): string => {
  const rel = path.relative(repoRoot, file).split(path.sep).join("/");
  const key = Object.keys(inputs).find((input) => input === rel || input.endsWith(`/${rel}`));
  if (!key) throw new Error(`${rel} is not in the bundle graph`);
  return key;
};

// Metafile edges are absolute paths (or importer-relative specifiers); input
// keys are repo-relative.
const resolveEdge = (importer: string, spec: string): string | null => {
  const base = path.isAbsolute(spec)
    ? spec
    : spec.startsWith(".")
      ? path.resolve(repoRoot, path.dirname(importer), spec)
      : null;
  if (!base) return null;
  const rel = path.relative(repoRoot, base).split(path.sep).join("/");
  return [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`].find((key) => key in inputs) ?? null;
};

const staticClosure = (start: string): Set<string> => {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const next = queue.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const edge of inputs[next]?.imports ?? []) {
      if (edge.kind === "dynamic-import") continue;
      const target = resolveEdge(next, edge.path);
      if (target) queue.push(target);
    }
  }
  return seen;
};

const UI = /node_modules\/(ink|react|react-reconciler|@inkjs\/ui|yoga-layout)\//u;

const verbModule = (name: string): string => {
  const file = path.join(cliSrc, "verbs", `${name}.ts`);
  try {
    return keyFor(file);
  } catch {
    return keyFor(path.join(cliSrc, "verbs", "family.ts"));
  }
};

test("given any verb, then ink/react are not statically imported (module graph)", () => {
  // The guard can see ink at all: it is in the graph, reachable only lazily.
  expect(Object.keys(inputs).some((input) => UI.test(input))).toBe(true);
  for (const entry of VERBS) {
    const offenders = [...staticClosure(verbModule(entry.name))].filter((input) => UI.test(input));
    expect(offenders, entry.name).toEqual([]);
  }
  // The router itself: `--version`/`help` load no dependency at all.
  const cold = [...staticClosure(keyFor(mainEntry))];
  expect(cold.filter((input) => input.includes("node_modules/"))).toEqual([]);
  expect(cold.some((input) => input.includes("workit-core/"))).toBe(false);
});

test("given workit --help, then it lists every registered verb", () => {
  const help = spawnSync("bun", [mainEntry, "--help"], { cwd: repoRoot, encoding: "utf8" });
  expect(help.status, help.stderr).toBe(0);
  for (const entry of VERBS) {
    if (entry.planned) expect(help.stdout).not.toContain(`workit ${entry.name} `);
    else if ((TASK_FAMILY_NAMES as readonly string[]).includes(entry.name))
      expect(help.stdout).toContain(`<family>: ${TASK_FAMILY_NAMES.join(", ")}`);
    else expect(help.stdout).toContain(`  ${entry.usage}\n      ${entry.summary}\n`);
  }
});

test("help, version and per-verb usage answer through the envelope", async () => {
  const version = await run(["--version", "--json"]);
  expect(version.code).toBe(0);
  const pkg = JSON.parse(
    readFileSync(path.join(repoRoot, "packages/workit-cli/package.json"), "utf8"),
  );
  expect(JSON.parse(version.stdout)).toEqual({
    ok: true,
    code: "ok",
    data: { version: pkg.version },
  });

  const help = await run(["help", "--json"]);
  const listed = JSON.parse(help.stdout);
  expect(listed.ok).toBe(true);
  expect(listed.data.verbs.map((verb: { name: string }) => verb.name)).toEqual(
    VERBS.filter((entry) => !entry.planned).map((entry) => entry.name),
  );

  // Every verb explains itself on request; none is a stub any more.
  expect(VERBS.filter((entry) => entry.planned)).toEqual([]);
  const usage = await run(["help", "stack"]);
  expect(usage.code).toBe(0);
  expect(usage.stdout).toContain("usage: workit stack plan");
  expect(usage.stdout).not.toContain("coming in");

  expect((await run([])).stdout).toContain("Usage: workit <command>");
});

test("unknown commands and bad global flags are usage errors with an unblock hint", async () => {
  const unknown = await run(["frobnicate", "--json"]);
  expect(unknown.code).toBe(2);
  expect(JSON.parse(unknown.stdout)).toEqual({
    ok: false,
    code: "invalid_input",
    data: {},
    error: 'unknown command "frobnicate"',
    unblock: "workit help",
  });
  const human = await run(["frobnicate"]);
  expect(human.stderr).toBe('workit: unknown command "frobnicate"\n  unblock: workit help\n');
  expect((await run(["check", "--cwd"])).code).toBe(2);
});

test("global --json works before and after the command", async () => {
  for (const argv of [
    ["--json", "--version"],
    ["--version", "--json"],
  ]) {
    const result = await run(argv);
    expect(result.code, argv.join(" ")).toBe(0);
    expect(JSON.parse(result.stdout).data.version).toBeString();
  }
  for (const argv of [["--json", "help"], ["help", "--json"], ["--json"]]) {
    const result = await run(argv);
    expect(result.code, argv.join(" ")).toBe(0);
    expect(JSON.parse(result.stdout).data.verbs.length).toBeGreaterThan(0);
  }
  for (const argv of [
    ["--json", "stack", "frob"],
    ["stack", "frob", "--json"],
    ["stack", "--json", "frob"],
  ]) {
    const result = await run(argv);
    expect(result.code, argv.join(" ")).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "invalid_input",
      error: 'unknown stack subcommand "frob"',
    });
  }
  // Existing verbs that parse --json themselves get it from either position.
  const doctor = spawnSync("bun", [mainEntry, "--json", "--cwd", repoRoot, "doctor"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  expect(() => JSON.parse(doctor.stdout)).not.toThrow();
  expect(parseGlobals(["--json", "--cwd", "/x", "doctor"])).toEqual({
    json: true,
    cwd: "/x",
    rest: ["doctor"],
  });
});

test("envelope codes map to the shared exit codes", () => {
  const io: Io = { json: true, cwd: ".", env: {}, stdout: () => {}, stderr: () => {} };
  const expected: Array<[Exclude<EnvelopeCode, "ok">, number]> = [
    ["failed", 1],
    ["not_found", 1],
    ["invalid_input", 2],
    ["not_implemented", 2],
    ["blocked", 3],
    ["busy", 4],
    ["pending", 4],
    ["unavailable", 5],
  ];
  for (const [code, exit] of expected) expect(emit(io, fail(code, code)), code).toBe(exit);
  let stderr = "";
  const human: Io = { ...io, json: false, stderr: (text) => void (stderr += text) };
  expect(
    emit(human, fail("blocked", "grant_required: merge", { unblock: "workit grant set w merge" })),
  ).toBe(3);
  expect(stderr).toBe("workit: grant_required: merge\n  unblock: workit grant set w merge\n");
});

test("global flags: --json is seen anywhere, --cwd is consumed, -- ends parsing", () => {
  expect(parseGlobals(["check", "test", "--json", "--cwd", "/x"])).toEqual({
    json: true,
    cwd: "/x",
    rest: ["check", "test", "--json"],
  });
  expect(parseGlobals(["check", "--cwd=/y", "--", "bun", "--json", "--cwd", "z"])).toEqual({
    json: false,
    cwd: "/y",
    rest: ["check", "--", "bun", "--json", "--cwd", "z"],
  });
});

test("the registry's task families match the core contract", () => {
  expect([...TASK_FAMILY_NAMES]).toEqual([...OPERATION_FAMILIES]);
});

test("existing task families still route through the router (with --cwd)", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-router-task-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    const argv = [mainEntry, "task", "list", "--json", "--cwd", root];
    const listed = spawnSync("bun", argv, {
      cwd: repoRoot,
      encoding: "utf8",
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== "WORKFLOW_WORKSPACE_ROOT"),
      ),
    });
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({ ok: true, data: [] });

    // An explicit --cwd beats an inherited WORKFLOW_WORKSPACE_ROOT.
    const bogus = path.join(root, "does-not-exist");
    const inheritedArgv = argv.slice(0, -2);
    const inherited = spawnSync("bun", inheritedArgv, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, WORKFLOW_WORKSPACE_ROOT: bogus },
    });
    expect(inherited.status).toBe(1);
    const explicit = spawnSync("bun", argv, {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, WORKFLOW_WORKSPACE_ROOT: bogus },
    });
    expect(explicit.status, explicit.stderr).toBe(0);
    expect(JSON.parse(explicit.stdout)).toMatchObject({ ok: true, data: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Error paths per verb. Every registered verb needs an entry, so a new verb
// cannot ship without proving its --json stdout is one JSON document.
const JSON_ERROR_PATHS: Record<string, string[][]> = {
  init: [[]],
  upgrade: [["--bogus"]],
  launch: [[], ["nohost"]],
  doctor: [["--fix-lock", "--force"]],
  gc: [["--dry-run"]],
  uninstall: [[]],
  task: [[], ["bogus"]],
  policy: [["bogus"]],
  evidence: [["bogus"]],
  finding: [["bogus"]],
  decision: [["bogus"]],
  worker: [["bogus"]],
  state: [["bogus"]],
  check: [["test"]],
  pr: [["status"]],
  ci: [["wait"]],
  git: [["push"]],
  "verify-delivery": [["push"]],
  stack: [["plan"]],
  ledger: [["list"]],
  handoff: [[], ["--task"]],
  "test-audit": [["--bogus"], ["--diff", "no-such-base"]],
  knowledge: [[], ["bogus"], ["lint"]],
  grant: [["bogus"], ["set"], ["set", "w", "merge=verified"]],
  youtrack: [[], ["note"]],
  changelog: [[], ["apply"]],
};

test("under --json every verb's stdout is exactly one JSON document, error paths included", () => {
  expect(Object.keys(JSON_ERROR_PATHS).toSorted()).toEqual(
    VERBS.map((entry) => entry.name).toSorted(),
  );
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-router-json-"));
  try {
    const home = path.join(root, "home");
    const cwd = path.join(root, "work");
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd });
    // An unverifiable lock makes `doctor --fix-lock --force` (no --yes) refuse.
    const lock = lockPathFor(cwd);
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(
      lock,
      JSON.stringify({ pid: 1, processStart: null, host: "elsewhere", nonce: "n" }),
    );
    const env = Object.fromEntries(
      Object.entries({
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        WORKFLOW_TOOLKIT_CONFIG: path.join(home, ".config", "workit"),
        WORKFLOW_TOOLKIT_STATE: path.join(home, ".local", "state", "workit"),
      }).filter(([key]) => key !== "WORKFLOW_WORKSPACE_ROOT"),
    );
    for (const [verb, cases] of Object.entries(JSON_ERROR_PATHS))
      for (const args of cases)
        for (const argv of [
          ["--json", verb, ...args],
          [verb, ...args, "--json"],
        ]) {
          const label = `workit ${argv.join(" ")}`;
          const result = spawnSync("bun", [mainEntry, ...argv], {
            cwd,
            env,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30_000,
          });
          expect(result.status, `${label}\n${result.stderr}`).not.toBeNull();
          const text = result.stdout.trim();
          expect(text, label).not.toBe("");
          let parsed: unknown;
          expect(() => (parsed = JSON.parse(text)), `${label}\n${text}`).not.toThrow();
          expect(typeof parsed, label).toBe("object");
          // The refused forced lock clear is a precise envelope, not a fallback.
          if (verb === "doctor")
            expect(parsed, label).toMatchObject({
              ok: false,
              code: "blocked",
              unblock: "workit doctor --fix-lock --force --yes",
              data: { lock: { present: true } },
            });
        }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);

test("under --json a verb's plain-text stdout becomes an envelope with its exit code", async () => {
  const result = await run(["--json", "launch"]);
  expect(result.code).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    code: "invalid_input",
    error: expect.stringContaining("Usage: workit launch"),
  });
  expect(result.stderr).toContain("Usage: workit launch");
});
