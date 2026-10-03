import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATION_FAMILIES } from "@/packages/workit-core/src/core/task-contract";
import { main, parseGlobals } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
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
    if ((TASK_FAMILY_NAMES as readonly string[]).includes(entry.name))
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
    VERBS.map((entry) => entry.name),
  );

  const usage = await run(["help", "pr"]);
  expect(usage.code).toBe(0);
  expect(usage.stdout).toContain("usage: workit pr status|create|merge");

  expect((await run([])).stdout).toContain("Usage: workit <command>");
});

test("planned S9b–S13 verbs answer not_implemented with exit 2", async () => {
  for (const [verb, slice] of [
    ["check", "S9b"],
    ["pr", "S10/S11"],
    ["ci", "S10"],
    ["git", "S11"],
    ["verify-delivery", "S11"],
    ["stack", "S12"],
    ["ledger", "S13"],
    ["handoff", "S13"],
  ] as const) {
    const result = await run([verb, "status", "--json"]);
    expect(result.code, verb).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      code: "not_implemented",
      data: { verb, subcommand: "status", slice },
      error: `${verb} is not implemented yet (planned in ${slice})`,
    });
  }
  const human = await run(["stack", "plan"]);
  expect(human.stdout).toBe("");
  expect(human.stderr).toContain("stack is not implemented yet (planned in S12)");
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
