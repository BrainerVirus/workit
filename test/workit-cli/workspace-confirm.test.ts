import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import { runGrant, type GrantDeps } from "@/packages/workit-cli/src/verbs/grant";
import { runWorkspace } from "@/packages/workit-cli/src/verbs/workspace";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// #656: one y/N for a batch removal, an overlap list limited to globs that
// really intersect, highlighted human output, and `workspace set --global`.

let configHome: ConfigHome;
let root = "";
beforeAll(() => {
  configHome = useConfigHome("wk-workspace-confirm-");
});
afterAll(() => configHome.restore());

const file = () => path.join(configHome.configDir, "workspaces.json");
const doc = () => JSON.parse(readFileSync(file(), "utf8"));
const GH = { provider: "github", account: "me" };
const seed = (workspaces: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  writeFileSync(file(), `${JSON.stringify({ ...extra, workspaces }, null, 2)}\n`);

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "wk-ws-confirm-root-")).replaceAll("\\", "/");
  mkdirSync(path.join(root, "work", "libs"), { recursive: true });
});
afterEach(() => {
  rmSync(file(), { force: true });
  rmSync(`${file()}.bak`, { force: true });
  rmSync(root, { recursive: true, force: true });
});

const terminalDeps = (answer: boolean, asked: string[]): GrantDeps => ({
  interactive: () => true,
  ask: async () => "",
  confirm: async (question) => {
    asked.push(question);
    return answer;
  },
});

type RunOptions = { json?: boolean; env?: NodeJS.ProcessEnv; color?: boolean };
const make = (options: RunOptions) => {
  let stdout = "";
  const io: Io = {
    json: options.json ?? false,
    cwd: root,
    env: options.env ?? {},
    stdout: (text) => void (stdout += text),
    stderr: () => {},
    ...(options.color ? { terminals: { stdout: { isTTY: true, columns: 120 } } } : {}),
  };
  return { io, out: () => stdout };
};
const workspace = async (argv: string[], deps: GrantDeps, options: RunOptions = {}) => {
  const { io, out } = make(options);
  const code = await runWorkspace(argv, io, deps);
  return { code, out: out(), json: () => JSON.parse(out()) };
};

const loose = (name: string, glob: string) => ({
  name,
  glob,
  vcs: GH,
  autonomy: { push: true, pr: true, merge: true, release: true, rerun: true },
  defaultEndpoint: "merged",
  verification: "proportional",
});
const strict = (name: string, glob: string) => ({
  name,
  glob,
  vcs: GH,
  autonomy: { merge: false },
});

test("rm of three entries that raise nothing writes without asking and lists only the parent as a taker", async () => {
  seed([
    strict("work", `${root}/work/**`),
    strict("a", `${root}/work/libs/a/**`),
    strict("b", `${root}/work/libs/b/**`),
    strict("c", `${root}/work/libs/c/**`),
    strict("elsewhere", `${root}/elsewhere/**`),
  ]);
  const asked: string[] = [];
  const quiet = await workspace(["rm", "a", "b", "c"], terminalDeps(false, asked), { json: true });
  expect(quiet.code).toBe(0);
  expect(asked).toEqual([]);
  expect(quiet.json().data.takers).toEqual(["work"]);
  expect(doc().workspaces.map((entry: { name: string }) => entry.name)).toEqual([
    "work",
    "elsewhere",
  ]);
});

test("rm of a batch that may raise confirms once and the question carries all names", async () => {
  seed([
    loose("work", `${root}/work/**`),
    strict("a", `${root}/work/libs/a/**`),
    strict("b", `${root}/work/libs/b/**`),
    strict("c", `${root}/work/libs/c/**`),
    loose("elsewhere", `${root}/elsewhere/**`),
  ]);
  const asked: string[] = [];
  const done = await workspace(["rm", "a", "b", "c"], terminalDeps(true, asked), { json: true });
  expect(done.code).toBe(0);
  expect(asked).toHaveLength(1);
  for (const name of ['"a"', '"b"', '"c"']) expect(asked[0]).toContain(name);
  // work overlaps the removed globs and is named; elsewhere cannot match them and is not.
  expect(asked[0]).toContain("work (");
  expect(asked[0]).not.toContain("elsewhere (");
  expect(asked[0]).toContain("1 other entry");
  expect(done.json().data.takers).toEqual(["work"]);
  expect(doc().workspaces.map((entry: { name: string }) => entry.name)).toEqual([
    "work",
    "elsewhere",
  ]);
});

test("rm: declining the one confirmation writes nothing", async () => {
  seed([loose("work", `${root}/work/**`), strict("a", `${root}/work/libs/a/**`)]);
  const before = readFileSync(file(), "utf8");
  const asked: string[] = [];
  const result = await workspace(["rm", "a"], terminalDeps(false, asked), { json: true });
  expect(result.json().code).toBe("blocked");
  expect(asked).toHaveLength(1);
  expect(readFileSync(file(), "utf8")).toBe(before);
});

test("rm: a non-TTY or agent shell is still refused with the terminal command", async () => {
  seed([loose("work", `${root}/work/**`), strict("a", `${root}/work/libs/a/**`)]);
  const refused = (error: string) => expect(error).toContain("grant_raise_refused");
  const headless: GrantDeps = {
    interactive: () => false,
    ask: async () => "",
    confirm: async () => {
      throw new Error("must not prompt");
    },
  };
  const result = await workspace(["rm", "a"], headless, { json: true });
  refused(result.json().error);
  expect(result.json().unblock).toContain("workit workspace rm a");
  const agent = await workspace(["rm", "a"], terminalDeps(true, []), {
    json: true,
    env: { CLAUDECODE: "1" },
  });
  refused(agent.json().error);
});

test("rm output on a color terminal colors what changed; NO_COLOR stays plain", async () => {
  seed([loose("work", `${root}/work/**`), strict("a", `${root}/work/libs/a/**`)]);
  const colored = await workspace(["rm", "a"], terminalDeps(true, []), { color: true });
  expect(colored.out).toContain("\x1b[1ma\x1b[0m");
  expect(colored.out).toContain("\x1b[31mremoved\x1b[0m");
  expect(colored.out).toContain("\x1b[32mmerge=true\x1b[0m");
  seed([loose("work", `${root}/work/**`), strict("a", `${root}/work/libs/a/**`)]);
  const plain = await workspace(["rm", "a"], terminalDeps(true, []), {
    color: true,
    env: { NO_COLOR: "1" },
  });
  expect(plain.out).not.toContain("\x1b[");
  expect(plain.out).toContain("a (");
});

test("set --global writes the top-level models key with a backup", async () => {
  seed([loose("work", `${root}/work/**`)]);
  const before = readFileSync(file(), "utf8");
  const result = await workspace(
    ["set", "--global", "models.roles.verifier.claude_code=sonnet"],
    terminalDeps(true, []),
    { json: true, env: { CLAUDECODE: "1" } },
  );
  expect(result.code).toBe(0);
  expect(doc().models).toEqual({ roles: { verifier: { claude_code: "sonnet" } } });
  expect(doc().workspaces).toEqual(JSON.parse(before).workspaces);
  expect(readFileSync(`${file()}.bak`, "utf8")).toBe(before);
  expect(result.json().data.changes[0]).toMatchObject({
    key: "models.roles.verifier.claude_code",
    to: "sonnet",
  });
});

test("set --global refuses a grant key and an unknown key, writing nothing", async () => {
  seed([loose("work", `${root}/work/**`)]);
  const before = readFileSync(file(), "utf8");
  const grant = await workspace(
    ["set", "--global", "autonomy.merge=true"],
    terminalDeps(true, []),
    {
      json: true,
    },
  );
  expect(grant.json().code).toBe("blocked");
  expect(grant.json().unblock).toContain("workit grant set");
  const unknown = await workspace(["set", "--global", "vcs.account=x"], terminalDeps(true, []), {
    json: true,
  });
  expect(unknown.code).toBe(2);
  expect(readFileSync(file(), "utf8")).toBe(before);
});

const grantRun = async (argv: string[], options: RunOptions) => {
  const { io, out } = make(options);
  const asked: string[] = [];
  const code = await runGrant(argv, io, terminalDeps(true, asked));
  return { code, out: out(), asked };
};

test("grant set shows key old -> new with raise green and lower yellow; NO_COLOR is plain", async () => {
  seed([{ name: "w", glob: `${root}/**`, vcs: GH, autonomy: { merge: false, push: true } }]);
  const raise = await grantRun(["set", "w", "merge=true"], { color: true });
  expect(raise.code).toBe(0);
  expect(raise.asked).toHaveLength(1);
  expect(raise.out).toContain("merge\x1b[0m: false -> true");
  expect(raise.out).toContain("\x1b[32m");
  const lower = await grantRun(["set", "w", "push=false"], { color: true });
  expect(lower.out).toContain("push\x1b[0m: true -> false");
  expect(lower.out).toContain("\x1b[33m");
  const plain = await grantRun(["set", "w", "merge=false"], {
    color: true,
    env: { NO_COLOR: "1" },
  });
  expect(plain.out).not.toContain("\x1b[");
  expect(plain.out).toContain("merge: true -> false");
});
