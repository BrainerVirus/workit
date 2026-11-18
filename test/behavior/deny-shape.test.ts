// D5 drift test 3 (decision first-try 2026-11-18): a Workit hook's deny must
// fix the next call. Every deny reason in the layer-0 corpus
// (test/behavior/cases, the hook cases) has the two-line shape: line 1
// `workit <gate>: <what, 15 words or fewer>.`, line 2 `Retry as: <complete
// call>`, at most one `Why:` sentence after, 400 characters in all. A case
// whose deny breaks the shape today sits in deny-shape.baseline.json, which
// only shrinks.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  handleHook,
} from "@/packages/workit-core/src/hooks/index";
import { fixture, tempRoot } from "@/test/workit-core/hooks/hook-fixtures";

const CASES = path.join(import.meta.dir, "cases");
const BASELINE = path.join(import.meta.dir, "deny-shape.baseline.json");
const ADAPTERS = { "claude-code": claudeCodeAdapter, codex: codexAdapter, cursor: cursorAdapter };

/** Why `reason` breaks the deny shape, or null when it has it. */
export const shapeError = (reason: string): string | null => {
  if (reason.length > 400) return `${reason.length} characters, over 400`;
  const [first = "", second = "", ...rest] = reason.split("\n");
  const head = /^workit [\w-]+(?: [\w-]+)*: (.+)\.$/u.exec(first);
  if (!head) return "line 1 is not `workit <gate>: <what>.`";
  if (head[1].split(/\s+/u).length > 15) return "line 1 says what in more than 15 words";
  if (!/^Retry as: \S/u.test(second)) return "line 2 is not `Retry as: <call>`";
  if (rest.length > 1 || (rest.length === 1 && !/^Why: (?:(?!\. [A-Z]).)+$/u.test(rest[0])))
    return "more than one `Why:` sentence after the retry";
  return null;
};

type HookCase = {
  id: string;
  repo?: { branch?: string };
  hook?: { host: keyof typeof ADAPTERS; fixture: string; overrides?: Record<string, unknown> };
};

const roots: string[] = [];
const KEYS = ["PATH", "HOME", "WORKIT_STATE_DIR", "WORKIT_CONFIG_DIR", "XDG_CONFIG_HOME"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  const world = tempRoot("workit-deny-shape-");
  roots.push(world);
  const [bin, home, state, config] = ["bin", "home", "state", "config"].map((name) => {
    const dir = path.join(world, name);
    mkdirSync(dir);
    return dir;
  }) as [string, string, string, string];
  writeFileSync(path.join(bin, "workit"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "workit"), 0o755);
  writeFileSync(
    path.join(config, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
    }),
  );
  Object.assign(process.env, {
    PATH: `${bin}${path.delimiter}${saved.PATH ?? ""}`,
    HOME: home,
    WORKIT_STATE_DIR: state,
    WORKIT_CONFIG_DIR: config,
    XDG_CONFIG_HOME: path.join(home, ".config"),
  });
});
afterEach(() => {
  for (const key of KEYS)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});

const repo = (branch?: string): string => {
  const root = tempRoot("workit-deny-shape-repo-");
  roots.push(root);
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  if (branch) git("checkout", "-q", "-b", branch);
  mkdirSync(path.join(root, ".git", "workit"), { recursive: true });
  return root;
};

/** The deny reason the case's hook gives, or null when it does not deny. */
const denyOf = (spec: HookCase): string | null => {
  if (!spec.hook) return null;
  const cwd = repo(spec.repo?.branch);
  const adapter = ADAPTERS[spec.hook.host];
  const overrides = JSON.parse(
    JSON.stringify(spec.hook.overrides ?? {}).replaceAll("__CWD__", cwd),
  ) as Record<string, unknown>;
  const parsed = adapter.parse(
    fixture(spec.hook.host, spec.hook.fixture, cwd, overrides),
    process.env,
  );
  if (!parsed.ok) throw new Error(`${spec.id}: payload does not parse: ${parsed.error}`);
  const decision = handleHook(parsed.input, {
    descriptor: { ...adapter.descriptor, host: parsed.input.host },
    addendum: adapter.addendum?.(parsed.input) ?? null,
  });
  return decision.kind === "deny" ? decision.reason : null;
};

test("Given deny reasons, When their shape is checked, Then only the two-line form passes", () => {
  expect(
    shapeError(
      "workit judge: `git status` takes a lock in the candidate.\nRetry as: git --no-optional-locks -C /w status --short\nWhy: an index refresh rewrites .git/index.",
    ),
  ).toBeNull();
  expect(shapeError("workit judge: denied.")).toBe("line 2 is not `Retry as: <call>`");
  expect(shapeError("blocked: run it differently")).toBe("line 1 is not `workit <gate>: <what>.`");
  expect(shapeError(`workit judge: x.\nRetry as: ${"y".repeat(400)}`)).toContain("over 400");
});

test("Given the layer-0 hook corpus, When each deny reason is checked, Then only the baselined cases break the shape (the baseline only shrinks)", () => {
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as string[];
  const broken: string[] = [];
  for (const name of readdirSync(CASES)
    .filter((each) => each.endsWith(".json"))
    .toSorted()) {
    const spec = JSON.parse(readFileSync(path.join(CASES, name), "utf8")) as HookCase;
    const reason = denyOf(spec);
    const why = reason === null ? null : shapeError(reason);
    if (why) broken.push(`${spec.id}: ${why}`);
  }
  const fresh = broken.filter((hit) => !baseline.includes(hit));
  const fixed = baseline.filter((hit) => !broken.includes(hit));
  expect(fresh, "a deny reason breaks the two-line shape").toEqual([]);
  expect(fixed, `fixed: drop these lines from ${path.basename(BASELINE)}`).toEqual([]);
});
