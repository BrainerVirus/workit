// The Cursor hook launcher (packages/workit-cursor/hooks/launch.mjs) as Cursor
// runs it: `node <plugin>/hooks/launch.mjs <bin>` with the payload on stdin.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveCursorHookLaunch,
  runCursorHookLaunch,
} from "@/packages/workit-cursor/hooks/launch-runtime.mjs";

const HOOKS_SRC = path.resolve(import.meta.dir, "../../packages/workit-cursor/hooks");
const PKG = "@brainervirus/workit-cursor";
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const scratch = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wk-cursor-launch-")));
  roots.push(root);
  return root;
};

const executable = (file: string, body: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  chmodSync(file, 0o755);
};

/** A plugin dir with the real launcher, a version, and optional bundled hook. */
const plugin = (opts: { version?: string; bundled?: string } = {}) => {
  const root = scratch();
  mkdirSync(path.join(root, "hooks"), { recursive: true });
  for (const file of ["launch.mjs", "launch-runtime.mjs"])
    copyFileSync(path.join(HOOKS_SRC, file), path.join(root, "hooks", file));
  if (opts.version)
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: PKG, version: opts.version }),
    );
  if (opts.bundled !== undefined)
    executable(path.join(root, "dist", "workit-hook.js"), opts.bundled);
  return root;
};

// Cursor runs the launcher with node; the children get a controlled PATH.
const NODE = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();

const launch = (root: string, payload: unknown, env: Record<string, string>) =>
  spawnSync(NODE, [path.join(root, "hooks", "launch.mjs"), "workit-cursor-hook"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env,
  });

const SHELL_PAYLOAD = {
  hook_event_name: "beforeShellExecution",
  conversation_id: "c1",
  workspace_roots: ["/tmp"],
  command: "ls",
};

test("resolution order is bundled dist, then a global bin on PATH, then npx pinned to the plugin version", () => {
  const root = plugin({ version: "9.9.9", bundled: "// bundled\n" });
  const bin = path.join(scratch(), "bin");
  executable(path.join(bin, "workit-cursor-hook"), "#!/bin/sh\necho '{}'\n");
  executable(path.join(bin, "npx"), "#!/bin/sh\necho '{}'\n");
  const env = { PATH: bin };
  const order = () =>
    resolveCursorHookLaunch({ root, bin: "workit-cursor-hook", env, node: "/node" }).map((c) => [
      c.mode,
      c.command,
      ...c.args,
    ]);

  expect(order()).toEqual([
    ["local", "/node", path.join(root, "dist", "workit-hook.js")],
    ["local", path.join(bin, "workit-cursor-hook")],
    [
      "npx-pinned",
      path.join(bin, "npx"),
      "-y",
      "--prefer-offline",
      `--package=${PKG}@9.9.9`,
      "workit-cursor-hook",
    ],
  ]);
  rmSync(path.join(root, "dist"), { recursive: true });
  expect(order().map((c) => c[1])).toEqual([
    path.join(bin, "workit-cursor-hook"),
    path.join(bin, "npx"),
  ]);
  rmSync(path.join(bin, "workit-cursor-hook"));
  expect(order().map((c) => c[0])).toEqual(["npx-pinned"]);
  rmSync(path.join(bin, "npx"));
  expect(order()).toEqual([]);
});

test("npx is never offered without a pinned plugin version, and never with @latest", () => {
  const bin = path.join(scratch(), "bin");
  executable(path.join(bin, "npx"), "#!/bin/sh\necho '{}'\n");
  expect(
    resolveCursorHookLaunch({ root: plugin(), bin: "workit-cursor-hook", env: { PATH: bin } }),
  ).toEqual([]);
  const [npx] = resolveCursorHookLaunch({
    root: plugin({ version: "1.2.3" }),
    bin: "workit-cursor-hook",
    env: { PATH: bin },
  });
  expect(npx.args.join(" ")).not.toContain("latest");
  expect(npx.args.join(" ")).not.toContain("--prefer-online");
});

test("a bundled hook's own policy deny passes through with exit 2", () => {
  const deny =
    '{"permission":"deny","user_message":"Workit blocked this action","agent_message":"no"}';
  const root = plugin({
    bundled: `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(${JSON.stringify(deny)});process.exitCode=2;});\n`,
  });
  const result = launch(root, SHELL_PAYLOAD, { PATH: "" });
  expect(result.status).toBe(2);
  expect(result.stdout).toBe(deny);
});

test("the bundled hook receives the payload and its answer is passed through", () => {
  const root = plugin({
    bundled:
      'let s="";process.stdin.on("data",(c)=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({seen:JSON.parse(s).command})));\n',
  });
  const result = launch(root, SHELL_PAYLOAD, { PATH: "" });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ seen: "ls" });
});

test("offline: an npx that fails (network error) fails open with {} and exit 0", () => {
  const bin = path.join(scratch(), "bin");
  executable(path.join(bin, "npx"), "#!/bin/sh\necho 'npm error network' >&2\nexit 1\n");
  const result = launch(plugin({ version: "1.2.3" }), SHELL_PAYLOAD, { PATH: bin });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("{}");
  expect(result.stderr).toContain("[workit] Cursor hook unavailable:");
  expect(result.stderr).toContain("exited 1");
});

test("a hung runtime is killed at the timeout and fails open", () => {
  const bin = path.join(scratch(), "bin");
  executable(path.join(bin, "npx"), "#!/bin/sh\nsleep 30\n");
  const result = launch(plugin({ version: "1.2.3" }), SHELL_PAYLOAD, {
    PATH: bin,
    WORKIT_CURSOR_HOOK_TIMEOUT_MS: "300",
  });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("{}");
  expect(result.stderr).toContain("[workit] Cursor hook unavailable:");
});

test("nothing to run (no dist, no global bin, no npx) fails open", () => {
  const result = launch(plugin({ version: "1.2.3" }), SHELL_PAYLOAD, { PATH: "" });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("{}");
  expect(result.stderr).toContain("[workit] Cursor hook unavailable:");
});

test("a spawn failure falls through to the next candidate, and fails open when none starts", () => {
  const payload = JSON.stringify(SHELL_PAYLOAD);
  const missing = {
    mode: "local" as const,
    source: "/nope/workit-cursor-hook",
    command: "/nope/workit-cursor-hook",
    args: [],
    timeoutMs: 1_000,
  };
  const echo = { ...missing, source: "echo", command: "/bin/sh", args: ["-c", "cat"] };
  expect(runCursorHookLaunch({ candidates: [missing, echo], payload, env: {} })).toEqual({
    stdout: payload,
    exitCode: 0,
    warning: null,
  });
  const failed = runCursorHookLaunch({ candidates: [missing], payload, env: {} });
  expect(failed.stdout).toBe("{}\n");
  expect(failed.exitCode).toBe(0);
  expect(failed.warning).toContain("/nope/workit-cursor-hook");
});
