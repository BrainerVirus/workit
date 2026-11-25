// #934: `fanout worktree create` gives a slice worktree its own frozen install
// of its lockfile by default; a linked node_modules from the main checkout can
// drift from that lockfile and fail tests only in slice worktrees. When the
// package manager is missing, fails or times out, it falls back to linking and
// says so in the output, --json and the brief; `--deps link` links as before.
// Real git repositories and the real CLI entry; the package manager is a fake
// `bun` on the PATH the CLI is given, so no test installs from a registry.
import "@/test/shared/state-isolation";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { parseDuration } from "@/packages/workit-core/src/duration";
import { frozenInstall, installCommand } from "@/packages/workit-core/src/worktree-deps";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-worktree-install-config-");
});
afterAll(() => configHome.restore());

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true });
});

/** A workspace over every test repo (they live in the temp dir) with these fanout settings. */
const workspaceFanout = (fanout: Record<string, unknown>) =>
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({ workspaces: [{ name: "tmp", glob: `${os.tmpdir()}/**`, fanout }] }),
  );

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

// No host of the shell running the suite, so the brief renders for the host named.
const HOST_VARS = [
  "WORKIT_HOST",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "OPENCODE",
  "OPENCODE_SESSION_ID",
  "CURSOR_AGENT",
  "CURSOR_TRACE_ID",
  "PI_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
  "CODEX_ELECTRON_RESOURCES_PATH",
];

const run = async (cwd: string, argv: string[], extraEnv: NodeJS.ProcessEnv = {}) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of HOST_VARS) delete env[key];
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...env, WORKIT_SESSION_ID: "lead-1", ...extraEnv },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "app", "devDependencies": { "leftpad": "1.0.0" } } },
  "packages": {
    "leftpad": ["leftpad@1.0.0", "", {}, "sha512-l"],
  }
}
`;

/**
 * A fake `bun` in its own bin dir. FAKE_BUN picks what it does: `ok` installs
 * leftpad 2.0.0 (the lockfile's own install, unlike the main checkout's
 * 1.0.0), `fail` leaves a partial node_modules and exits 1, `hang` starts a
 * child that sleeps (its pid in FAKE_BUN_LOG.child) and waits on it. Each run
 * appends its cwd and argv to FAKE_BUN_LOG.
 */
const fakeBun = (): { bin: string; log: string } => {
  const bin = tempDir("wk-fake-bun-");
  const log = path.join(bin, "calls.log");
  const script = path.join(bin, "bun");
  writeFileSync(
    script,
    `#!/bin/sh
echo "$PWD $*" >> "$FAKE_BUN_LOG"
case "$FAKE_BUN" in
  hang) sleep 30 & echo $! > "$FAKE_BUN_LOG.child"; wait; exit 0 ;;
  fail) mkdir -p node_modules/partial; echo "error: lockfile had changes, but lockfile is frozen" >&2; exit 1 ;;
  empty) exit 0 ;;
esac
mkdir -p node_modules/leftpad
echo '{"name":"leftpad","version":"2.0.0"}' > node_modules/leftpad/package.json
`,
  );
  chmodSync(script, 0o755);
  return { bin, log };
};

/** A repo with bun.lock, node_modules installed in the main checkout, and a one-slice plan. */
const repo = async () => {
  const root = tempDir("wk-worktree-install-");
  const cwd = path.join(root, "app");
  const hooks = path.join(root, "hooks");
  mkdirSync(cwd);
  mkdirSync(hooks);
  git(cwd, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "t"],
    ["user.email", "t@t"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", hooks],
  ])
    git(cwd, "config", key, value);
  writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n");
  writeFileSync(path.join(cwd, "bun.lock"), LOCK);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "chore: base");
  mkdirSync(path.join(cwd, "node_modules", "leftpad"), { recursive: true });
  writeFileSync(
    path.join(cwd, "node_modules", "leftpad", "package.json"),
    JSON.stringify({ name: "leftpad", version: "1.0.0" }),
  );
  const file = path.join(root, "plan.json");
  writeFileSync(
    file,
    JSON.stringify({
      name: "deps",
      trunk: "main",
      slices: [
        {
          id: "a",
          branch: "feature/a",
          tier: "mundane",
          reason: "parallel",
          scope: ["a.ts"],
          goal: "GET /a answers 200",
          acceptance: ["Given the app, When GET /a, Then the status is 200"],
          verify: ["workit check test"],
          forbidden: ["no edits outside SCOPE"],
        },
      ],
    }),
  );
  expect((await run(cwd, ["fanout", "plan", file, "--json"])).code).toBe(0);
  return cwd;
};

type Made = {
  path: string;
  install: string | null;
  dependencies: { from: string } | null;
  deps: { mode: string; from: string | null; command: string | null; fallback: string | null };
  notes: string[];
};

/** `--json` in one fresh repo, the human output of the same create in another. */
const create = async (args: string[], env: NodeJS.ProcessEnv) => {
  const cwd = await repo();
  const json = await run(cwd, ["fanout", "worktree", "create", "a", ...args, "--json"], env);
  expect(json.code, json.stderr + json.stdout).toBe(0);
  const other = await repo();
  const human = await run(other, ["fanout", "worktree", "create", "a", ...args], env);
  expect(human.code, human.stderr + human.stdout).toBe(0);
  return {
    cwd,
    made: json.json().data as Made,
    human: human.stdout.replaceAll(other, "<main>"),
  };
};

const brief = async (cwd: string) => {
  const result = await run(cwd, ["fanout", "brief", "a", "--host", "claude_code", "--json"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  return result.json().data.text as string;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Whether `pid` is gone within a few seconds (a killed orphan is reaped by init). */
const gone = async (pid: number): Promise<boolean> => {
  for (let tries = 0; tries < 30 && alive(pid); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 100));
  const dead = !alive(pid);
  if (!dead) process.kill(pid, "SIGKILL");
  return dead;
};

const leftpad = (wt: string) =>
  JSON.parse(readFileSync(path.join(wt, "node_modules", "leftpad", "package.json"), "utf8"))
    .version as string;

// The fake package manager is a POSIX shell script.
describe.skipIf(process.platform === "win32")("own install", () => {
  test("given bun.lock and bun on PATH, when the worktree is made, then it gets its own frozen install, nothing is linked, and the output and brief say so", async () => {
    const fake = fakeBun();
    const env = {
      PATH: `${fake.bin}${path.delimiter}${process.env.PATH ?? ""}`,
      FAKE_BUN: "ok",
      FAKE_BUN_LOG: fake.log,
    };
    const { cwd, made, human } = await create([], env);
    const command = `bun install --frozen-lockfile --cwd ${made.path}`;
    expect(made.deps).toEqual({ mode: "installed", from: null, command, fallback: null });
    expect(made.dependencies).toBeNull();
    expect(made.install).toBeNull();
    expect(readFileSync(fake.log, "utf8").trim().split("\n")[0]).toBe(
      `${made.path} install --frozen-lockfile`,
    );
    // The worktree's own package, not a link to the main checkout's 1.0.0.
    expect(lstatSync(path.join(made.path, "node_modules", "leftpad")).isSymbolicLink()).toBe(false);
    expect(leftpad(made.path)).toBe("2.0.0");
    expect(made.notes.join("\n")).toContain("installed dependencies from bun.lock");
    expect(human).toContain("  deps own install (bun install --frozen-lockfile --cwd ");
    const text = await brief(cwd);
    expect(text).toContain(`DEPS: own install (\`${command}\`): nothing is linked`);
    expect(text).toContain("the worktree's node_modules is its own install of its lockfile");
    expect(text).not.toContain("LINKED");
  });

  test("given the install fails, then the partial node_modules is removed, the worktree is linked instead, and the output, --json and the brief's verifier line say LINKED", async () => {
    const fake = fakeBun();
    const env = {
      PATH: `${fake.bin}${path.delimiter}${process.env.PATH ?? ""}`,
      FAKE_BUN: "fail",
      FAKE_BUN_LOG: fake.log,
    };
    const { cwd, made, human } = await create([], env);
    expect(made.deps.mode).toBe("linked");
    expect(made.deps.fallback).toContain(
      "bun install --frozen-lockfile exited 1: error: lockfile had changes, but lockfile is frozen",
    );
    expect(made.dependencies?.from).toBe(cwd);
    expect(existsSync(path.join(made.path, "node_modules", "partial"))).toBe(false);
    expect(lstatSync(path.join(made.path, "node_modules", "leftpad")).isSymbolicLink()).toBe(true);
    expect(leftpad(made.path)).toBe("1.0.0");
    expect(made.notes.join("\n")).toContain("LINKED, not installed: bun install --frozen-lockfile");
    expect(human).toContain("  deps LINKED from <main> (bun install --frozen-lockfile exited 1");
    const text = await brief(cwd);
    expect(text).toContain(
      `DEPS: LINKED: node_modules links into the installed packages of ${cwd}`,
    );
    expect(text).toContain("(the own install failed: bun install --frozen-lockfile exited 1");
    expect(text).toMatch(
      /verifier SPAWN: .*the worktree's node_modules is LINKED from .*, not its own install/u,
    );
  });

  test("given a lockfile whose install makes no node_modules (no dependencies), then the brief says own install, not INSTALL", async () => {
    const fake = fakeBun();
    const { cwd, made } = await create([], {
      PATH: `${fake.bin}${path.delimiter}${process.env.PATH ?? ""}`,
      FAKE_BUN: "empty",
      FAKE_BUN_LOG: fake.log,
    });
    expect(made.deps.mode).toBe("installed");
    expect(existsSync(path.join(made.path, "node_modules"))).toBe(false);
    const text = await brief(cwd);
    expect(text).toContain("DEPS: own install");
    expect(text).not.toContain("INSTALL:");
  });

  test("given no bun on PATH, then the worktree is linked and the reason names the missing package manager", async () => {
    const empty = tempDir("wk-empty-path-");
    const { made } = await create([], { PATH: empty });
    expect(made.deps.mode).toBe("linked");
    // Nothing ran, so no log is named.
    expect(made.deps.fallback).toBe("bun is not on PATH");
    expect(made.dependencies).not.toBeNull();
  });

  test("given the install outlives --install-timeout, then it is killed and the worktree is linked", async () => {
    const cwd = await repo();
    const fake = fakeBun();
    const json = await run(
      cwd,
      ["fanout", "worktree", "create", "a", "--install-timeout", "1s", "--json"],
      {
        PATH: `${fake.bin}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_BUN: "hang",
        FAKE_BUN_LOG: fake.log,
      },
    );
    expect(json.code, json.stderr + json.stdout).toBe(0);
    const made = json.json().data as Made;
    expect(made.deps.mode).toBe("linked");
    expect(made.deps.fallback).toStartWith("bun install --frozen-lockfile timed out after 1 s");
    // The whole process tree is killed, not only the package manager: its child is gone too.
    const child = Number(readFileSync(`${fake.log}.child`, "utf8").trim());
    expect(await gone(child)).toBe(true);
  });

  test("given --deps link, then the package manager never runs and the worktree is linked as before", async () => {
    const fake = fakeBun();
    const { cwd, made, human } = await create(["--deps", "link"], {
      PATH: `${fake.bin}${path.delimiter}${process.env.PATH ?? ""}`,
      FAKE_BUN: "ok",
      FAKE_BUN_LOG: fake.log,
    });
    expect(existsSync(fake.log)).toBe(false);
    expect(made.deps).toEqual({
      mode: "linked",
      from: cwd,
      command: `bun install --frozen-lockfile --cwd ${made.path}`,
      fallback: null,
    });
    expect(leftpad(made.path)).toBe("1.0.0");
    expect(human).toContain("  deps LINKED from <main>: shared packages can drift");
  });
});

// Workspace fanout.deps and fanout.installTimeout: the flags override them.
describe.skipIf(process.platform === "win32")("workspace fanout.deps", () => {
  const env = (mode: string) => {
    const fake = fakeBun();
    return {
      fake,
      env: {
        PATH: `${fake.bin}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_BUN: mode,
        FAKE_BUN_LOG: fake.log,
      },
    };
  };

  test("given fanout.deps link, when create runs without --deps, then it links without running the package manager and says the workspace chose it", async () => {
    workspaceFanout({ deps: "link" });
    const { fake, env: vars } = env("ok");
    const { made, human } = await create([], vars);
    expect(existsSync(fake.log)).toBe(false);
    expect(made.deps.mode).toBe("linked");
    expect(made.deps.fallback).toBeNull();
    expect(made.notes).toContain("deps link: workspace tmp sets fanout.deps");
    expect(human).toContain("note: deps link: workspace tmp sets fanout.deps");
  });

  test("given fanout.deps link, when create runs with --deps install, then the flag wins and the worktree gets its own install", async () => {
    workspaceFanout({ deps: "link" });
    const { fake, env: vars } = env("ok");
    const { made } = await create(["--deps", "install"], vars);
    expect(made.deps.mode).toBe("installed");
    expect(leftpad(made.path)).toBe("2.0.0");
    expect(readFileSync(fake.log, "utf8")).toContain("install --frozen-lockfile");
    expect(made.notes.join("\n")).not.toContain("fanout.deps");
  });

  test("given fanout.installTimeout, then it bounds the install, and --install-timeout overrides it", async () => {
    workspaceFanout({ installTimeout: "1s" });
    const configured = await run(
      await repo(),
      ["fanout", "worktree", "create", "a", "--json"],
      env("hang").env,
    );
    expect(configured.code, configured.stderr + configured.stdout).toBe(0);
    const byConfig = configured.json().data as Made;
    expect(byConfig.deps.fallback).toStartWith("bun install --frozen-lockfile timed out after 1 s");
    expect(byConfig.notes).toContain(
      "install timeout 1 s: workspace tmp sets fanout.installTimeout",
    );
    const flagged = await run(
      await repo(),
      ["fanout", "worktree", "create", "a", "--install-timeout", "2s", "--json"],
      env("hang").env,
    );
    expect(flagged.code, flagged.stderr + flagged.stdout).toBe(0);
    const byFlag = flagged.json().data as Made;
    expect(byFlag.deps.fallback).toStartWith("bun install --frozen-lockfile timed out after 2 s");
    expect(byFlag.notes.join("\n")).not.toContain("fanout.installTimeout");
  }, 20_000);

  test("given values Workit does not read, then the defaults apply and the notes name each ignored value", async () => {
    workspaceFanout({ deps: "copy", installTimeout: "soon" });
    const { made } = await create([], env("ok").env);
    expect(made.deps.mode).toBe("installed");
    expect(made.notes).toContain(
      'workspace tmp fanout.deps "copy" is not install or link; ignored',
    );
    expect(made.notes).toContain(
      'workspace tmp fanout.installTimeout "soon" is not a duration such as "90s" or "10m"; ignored',
    );
  });

  test("given fanout.deps link, when --install-timeout is passed without --deps install, then create refuses and names the workspace", async () => {
    workspaceFanout({ deps: "link" });
    const cwd = await repo();
    const result = await run(cwd, [
      "fanout",
      "worktree",
      "create",
      "a",
      "--install-timeout",
      "1m",
      "--json",
    ]);
    expect(result.code).toBe(2);
    expect(result.stdout + result.stderr).toContain(
      "--install-timeout goes with --deps install (workspace tmp sets fanout.deps link)",
    );
  });
});

test("given an unknown --deps or --install-timeout with --deps link, then create refuses with usage", async () => {
  const cwd = await repo();
  const bad = await run(cwd, ["fanout", "worktree", "create", "a", "--deps", "copy", "--json"]);
  expect(bad.code).toBe(2);
  expect(bad.stdout + bad.stderr).toContain("--deps takes install or link (got copy)");
  const both = await run(cwd, [
    "fanout",
    "worktree",
    "create",
    "a",
    "--deps",
    "link",
    "--install-timeout",
    "1m",
    "--json",
  ]);
  expect(both.code).toBe(2);
  expect(both.stdout + both.stderr).toContain("--install-timeout goes with --deps install");
});

test("given the editor schema of fanout.installTimeout, then it accepts what the reader reads and nothing else", () => {
  const schema = JSON.parse(
    readFileSync(
      path.join(import.meta.dir, "../../packages/workit-core/schemas/workspaces.json"),
      "utf8",
    ),
  );
  // The first `installTimeout` property anywhere in the schema (fanout's).
  const find = (node: unknown): { pattern: string } | undefined => {
    if (!node || typeof node !== "object") return undefined;
    const record = node as Record<string, unknown>;
    const own = (record.properties as Record<string, { pattern: string }> | undefined)
      ?.installTimeout;
    return own ?? Object.values(record).map(find).find(Boolean);
  };
  const pattern = new RegExp(find(schema)!.pattern, "u");
  for (const value of ["90s", "10m", "1h30m", "45 minutes", "300", "1500ms"]) {
    expect(pattern.test(value), value).toBe(true);
    expect(parseDuration(value), value).toBeGreaterThan(0);
  }
  for (const value of ["soon", "5 parsecs", "", "m5"]) {
    expect(pattern.test(value), value).toBe(false);
    expect(parseDuration(value), value).toBeNull();
  }
});

test("given each lockfile, then the frozen install is the one its package manager documents", () => {
  const dir = (files: Record<string, string>) => {
    const root = tempDir("wk-lockfile-");
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(root, name), text);
    return root;
  };
  const npm = dir({ "package-lock.json": "{}" });
  expect(installCommand(frozenInstall(npm)!, npm)).toBe(`npm ci --prefix ${npm}`);
  const pnpm = dir({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
  expect(installCommand(frozenInstall(pnpm)!, pnpm)).toBe(
    `pnpm install --frozen-lockfile --dir ${pnpm}`,
  );
  const yarn1 = dir({ "yarn.lock": "# yarn lockfile v1\n" });
  expect(frozenInstall(yarn1)?.args).toEqual(["install", "--frozen-lockfile"]);
  const berry = dir({ "yarn.lock": "# generated\n\n__metadata:\n  version: 8\n" });
  expect(frozenInstall(berry)?.args).toEqual(["install", "--immutable"]);
  expect(frozenInstall(dir({ "bun.lockb": "" }))?.bin).toBe("bun");
  expect(frozenInstall(dir({ "README.md": "no lockfile" }))).toBeNull();
});
