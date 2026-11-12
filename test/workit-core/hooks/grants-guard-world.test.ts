// The write guard (#817) protects the account's grants file in every state,
// a bench world included (#822 F2): a world shows and writes grants in its
// own config dir, but the dir the guard imports (autonomy.ts grantsDir)
// stays the account's, so a session inside a world still cannot write it.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { grantsDir, grantsHome, shownGrantsDir } from "@/packages/workit-core/src/autonomy";
import { EVAL_WORLD_ENV, EVAL_WORLD_MARKER } from "@/packages/workit-core/src/core/eval-world";
import { configDir } from "@/packages/workit-core/src/core/workit-paths.mjs";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { evaluateShellPermission } from "@/packages/workit-opencode/src/v2/permissions";
import { fixture } from "./hook-fixtures";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-eval-guard-")));
const world = path.join(base, "world");
const repo = path.join(world, "repo");
const account = path.join(base, "account");
/** The account's grants dir: what an agent inside the world must not write. */
const ACCOUNT = configDir({ HOME: account });
const KEYS = [EVAL_WORLD_ENV, "XDG_CONFIG_HOME", "WORKIT_CONFIG", "WORKIT_CONFIG_DIR"];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const savedResolve = grantsHome.resolve;
const savedCwd = process.cwd();

beforeEach(() => {
  mkdirSync(repo, { recursive: true });
  mkdirSync(ACCOUNT, { recursive: true });
  mkdirSync(path.join(world, "config"), { recursive: true });
  writeFileSync(path.join(world, EVAL_WORLD_MARKER), "");
  grantsHome.resolve = () => account;
  for (const key of KEYS) delete process.env[key];
  process.env[EVAL_WORLD_ENV] = world;
  // The config dir points elsewhere: neither the world's nor the account's.
  process.env.XDG_CONFIG_HOME = path.join(base, "other");
  process.chdir(repo);
});
afterEach(() => {
  process.chdir(savedCwd);
  grantsHome.resolve = savedResolve;
  for (const key of KEYS)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

type Out = { permissionDecision?: string } | undefined;
const claude = (toolName: string, toolInput: Record<string, unknown>): Out =>
  (
    dispatchHook(
      claudeCodeAdapter,
      fixture("claude-code", "pre-tool-use-write", repo, {
        tool_name: toolName,
        tool_input: toolInput,
      }),
    ).json as { hookSpecificOutput?: Out }
  ).hookSpecificOutput;

test("Given a valid bench world, a cwd inside it and the config dir elsewhere, Then grantsDir is still the account's and the world's dir is only shown", () => {
  expect(shownGrantsDir()).toBe(path.join(world, "config"));
  expect(grantsDir()).toBe(ACCOUNT);
});

test("Given a valid bench world, a cwd inside it and the config dir elsewhere, When a session writes the account's workspaces.json, Then the guard denies it", () => {
  const file = path.join(ACCOUNT, "workspaces.json");
  const sh = file.replaceAll("\\", "/");
  expect(claude("Write", { file_path: file })?.permissionDecision).toBe("deny");
  expect(claude("Bash", { command: `echo '{}' > ${sh}` })?.permissionDecision).toBe("deny");
  const event = {
    action: "edit",
    resources: [file],
    effect: "allow",
    message: undefined as string | undefined,
  };
  evaluateShellPermission(repo, event);
  expect(event.effect).toBe("deny");
});
