// W2.14: `fanout worktree create` links the main checkout's node_modules when
// the only packages missing are optional dependencies bun skips on this
// platform (the `@emnapi/*` runtime of a wasm32 binding), while
// `bun install --frozen-lockfile` reports nothing to do. A package that is
// required and missing still blocks the link. Real git repositories, the
// real CLI entry.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-worktree-deps-config-");
});
afterAll(() => configHome.restore());

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

const run = async (cwd: string, argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "lead-1" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

// The shape of bun.lock around oxc-resolver: a wasm32 binding (cpu none) that
// is optional for its parent pulls in @emnapi/*, which @napi-rs/wasm-runtime
// names only as peers.
const LOCK = (extra = "") => `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "app", "devDependencies": { "resolver": "1.0.0"${extra} } },
  },
  "packages": {
    "resolver": ["resolver@1.0.0", "", { "dependencies": { "tslib": "^2.4.0" }, "optionalDependencies": { "@resolver/binding-linux-x64": "1.0.0", "@resolver/binding-wasm32-wasi": "1.0.0" } }, "sha512-r"],
    "@resolver/binding-linux-x64": ["@resolver/binding-linux-x64@1.0.0", "", { "os": "linux", "cpu": "x64" }, "sha512-l"],
    "@resolver/binding-wasm32-wasi": ["@resolver/binding-wasm32-wasi@1.0.0", "", { "dependencies": { "@emnapi/core": "1.11.2", "@emnapi/runtime": "1.11.2", "@napi-rs/wasm-runtime": "^1.1.6" }, "cpu": "none" }, "sha512-w"],
    "@emnapi/core": ["@emnapi/core@1.11.2", "", { "dependencies": { "@emnapi/wasi-threads": "1.2.2", "tslib": "^2.4.0" } }, "sha512-c"],
    "@emnapi/runtime": ["@emnapi/runtime@1.11.2", "", { "dependencies": { "tslib": "^2.4.0" } }, "sha512-u"],
    "@emnapi/wasi-threads": ["@emnapi/wasi-threads@1.2.2", "", { "dependencies": { "tslib": "^2.4.0" } }, "sha512-t"],
    "@napi-rs/wasm-runtime": ["@napi-rs/wasm-runtime@1.2.4", "", { "peerDependencies": { "@emnapi/core": "^1.7.1", "@emnapi/runtime": "^1.7.1" } }, "sha512-n"],
    "tslib": ["tslib@2.8.1", "", {}, "sha512-s"],
  }
}
`;

const install = (cwd: string, versions: Record<string, string>) => {
  for (const [name, version] of Object.entries(versions)) {
    const dir = path.join(cwd, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
  }
};

const create = async (lock: string, installed: Record<string, string>) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-worktree-deps-"));
  dirs.push(root);
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
  writeFileSync(path.join(cwd, "bun.lock"), lock);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "chore: base");
  install(cwd, installed);
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
  const created = await run(cwd, ["fanout", "worktree", "create", "a", "--json"]);
  expect(created.code, created.stderr + created.stdout).toBe(0);
  return created.json().data as {
    path: string;
    install: string | null;
    dependencies: unknown;
    notes: string[];
  };
};

// This platform's own binding, so the lockfile reads as complete here.
const native = `@resolver/binding-${process.platform}-${process.arch}`;
const lockHere = LOCK()
  .replaceAll("@resolver/binding-linux-x64", native)
  .replace('"os": "linux", "cpu": "x64"', `"os": "${process.platform}", "cpu": "${process.arch}"`);

test("given a lockfile whose optional @emnapi deps are absent on this platform, when the worktree is made, then node_modules is linked and no install is asked for", async () => {
  const made = await create(lockHere, {
    resolver: "1.0.0",
    tslib: "2.8.1",
    [native]: "1.0.0",
  });
  expect(made.install).toBeNull();
  expect(made.notes.join("\n")).not.toContain("missing");
  expect(made.dependencies).not.toBeNull();
  expect(existsSync(path.join(made.path, "node_modules", "resolver", "package.json"))).toBe(true);
});

test("given the platform binding bun.lock pins for this machine is missing, then nothing is linked and the install is named", async () => {
  const made = await create(lockHere, { resolver: "1.0.0", tslib: "2.8.1" });
  expect(made.dependencies).toBeNull();
  expect(made.notes.join("\n")).toContain(`${native} missing`);
  expect(made.install).toBe(`bun install --frozen-lockfile --cwd ${made.path}`);
});

test("given a package also required outright is missing, then nothing is linked although an optional package names it too", async () => {
  const made = await create(
    LOCK(', "@emnapi/runtime": "1.11.2"')
      .replaceAll("@resolver/binding-linux-x64", native)
      .replace(
        '"os": "linux", "cpu": "x64"',
        `"os": "${process.platform}", "cpu": "${process.arch}"`,
      ),
    {
      resolver: "1.0.0",
      tslib: "2.8.1",
      [native]: "1.0.0",
    },
  );
  expect(made.dependencies).toBeNull();
  expect(made.notes.join("\n")).toContain("@emnapi/runtime missing");
  expect(made.notes.join("\n")).not.toContain("@emnapi/core missing");
});
