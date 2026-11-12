// Eval world isolation (scripts/eval/isolation.ts, #822): inside a bench
// world every Workit path a spawned process resolves is the world's, a write
// through $HOME or ~ lands in the world, and a case that permits a shell
// wrapper starts only after the world passes the self-check. HOME points at a
// fake real home for the whole file, so a broken isolation lands there and
// never in the account's.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EvalCase } from "@/scripts/eval/cases";
import { linkLogin, permitsShellWrappers, selfCheck } from "@/scripts/eval/isolation";
import { opencodeEnv } from "@/scripts/eval/opencode";
import { childEnv, main } from "@/scripts/eval/run";
import { makeWorld, type World } from "@/scripts/eval/scaffold";
import { armTripwire, checkTripwire, guardFor, tripwireBase } from "@/scripts/eval/tripwire";

const REPO = path.resolve(import.meta.dir, "..", "..");
const RUN = path.join(REPO, "scripts", "eval", "run.ts");
/** The `workit` each host's agent runs: the Claude Code plugin's shim, this checkout's CLI. */
const CLI_BIN = path.join(REPO, "packages", "workit-claude-code", "bin");
const SPEC: EvalCase = { id: "iso", source: "test", tier: "full", prompt: "p" };

const roots: string[] = [];
const worlds: World[] = [];
afterAll(() => {
  for (const dir of [...roots, ...worlds.map((world) => world.dir)])
    rmSync(dir, { recursive: true, force: true });
});

const savedHome = process.env.HOME;
let root = "";
let realHome = "";
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "workit-isolation-test-"));
  roots.push(root);
  realHome = path.join(root, "real-home");
  for (const dir of [".claude", ".local/share/opencode", ".config/workit"])
    mkdirSync(path.join(realHome, dir), { recursive: true });
  writeFileSync(path.join(realHome, ".claude.json"), "{}");
  writeFileSync(path.join(realHome, ".config", "workit", "workspaces.json"), '{"workspaces":[]}');
  process.env.HOME = realHome;
});
afterEach(() => {
  process.env.HOME = savedHome;
});

type HostEnv = { host: "claude-code" | "opencode"; world: World; env: Record<string, string> };

const worldFor = (host: HostEnv["host"]): HostEnv => {
  const world = makeWorld(SPEC);
  worlds.push(world);
  linkLogin(world.home, host, realHome);
  const env = childEnv(world, CLI_BIN);
  return {
    host,
    world,
    env: host === "opencode" ? opencodeEnv(env, path.join(world.dir, "xdg"), world) : env,
  };
};

test.each(["claude-code", "opencode"] as const)(
  "Given a %s world, When a spawned process resolves the config, grants, state, approvals and issued dirs, and runs workit dir, grant show and workspace list, Then every path is inside the world",
  (host) => {
    const { world, env } = worldFor(host);
    const check = selfCheck(world.dir, world.repo, env, [
      process.execPath,
      RUN,
      "--isolation-probe",
    ]);

    expect(check.outside).toEqual([]);
    expect(check.ok).toBe(true);
    for (const key of ["home", "config", "grants", "state", "approvals", "issued"])
      expect(check.paths[key]?.startsWith(`${world.dir}/`)).toBe(true);
    expect(check.paths.grants).toBe(path.join(world.home, ".config", "workit"));
    for (const verb of ["dir config", "dir state", "grant show --json", "workspace list --json"])
      expect(Object.keys(check.paths).some((key) => key.startsWith(`workit ${verb} #`))).toBe(true);
  },
);

test.each(["claude-code", "opencode"] as const)(
  "Given a %s world, Then only the host's own login is linked in from the real home",
  (host) => {
    const { world } = worldFor(host);
    const login = host === "claude-code" ? ".claude" : ".local/share/opencode";
    expect(readlinkSync(path.join(world.home, login))).toBe(path.join(realHome, login));
    expect(existsSync(path.join(world.home, ".config", "workit"))).toBe(false);
    expect(lstatSync(world.home).isSymbolicLink()).toBe(false);
  },
);

const WRITER = `#!/bin/sh
# Every way #822's agent could reach the config: $HOME, ~, python, the CLI.
mkdir -p "$HOME/.config/workit" ~/.local/state/workit/approvals/grants ~/.local/state/workit/issued
printf '{"workspaces":[{"name":"eval","glob":"/**","autonomy":{"merge":true}}]}' > "$HOME/.config/workit/workspaces.json"
python3 -c 'import os; open(os.path.expanduser("~/.config/workit/config.json"), "w").write("{}")'
echo forged > ~/.local/state/workit/approvals/grants/g.json
echo forged > ~/.local/state/workit/issued/i
workit workspace add extra --glob "$PWD/**"
workit workspace set extra branchPolicy.integration=merge
workit workspace rm extra
workit grant set eval merge=false
workit grant set eval merge=true
exit 0
`;

test.each(["claude-code", "opencode"] as const)(
  "Given a %s world, When a script writes the config and state through $HOME, ~, python and workit grant|workspace verbs, Then nothing outside the world changes",
  (host) => {
    const { world, env } = worldFor(host);
    const tripwire = tripwireBase(realHome);
    armTripwire(tripwire, guardFor(realHome));
    const script = path.join(root, "writer.sh");
    writeFileSync(script, WRITER);
    chmodSync(script, 0o755);

    const run = spawnSync(script, [], { cwd: world.repo, env, encoding: "utf8", timeout: 60_000 });

    expect(run.status).toBe(0);
    expect(checkTripwire(tripwire)).toBeNull();
    expect(
      readFileSync(path.join(world.home, ".config", "workit", "workspaces.json"), "utf8"),
    ).toContain("merge");
    expect(existsSync(path.join(world.home, ".local", "state", "workit", "issued", "i"))).toBe(
      true,
    );
  },
);

test.each([
  [{ prompt: "run python3 to fix it" }, [], true],
  [{ prompt: "write a script and run it with bash" }, [], true],
  [{ prompt: "commit the change" }, ["Bash(python3 *)"], true],
  [{ prompt: "commit the change" }, ["Bash"], true],
  [{ prompt: "commit the change" }, ["Bash(*)"], true],
  [{ prompt: "commit the change" }, ["Bash(eval *)"], true],
  [{ prompt: "commit the change", permissionMode: "bypassPermissions" }, [], true],
  [{ prompt: "commit the change" }, ["Bash(git *)", "Bash(workit *)", "Bash(cat *)"], false],
  [{ prompt: "Without running any tools, tell me" }, [], false],
] as const)("Given case %j with tools %j, Then permitsShellWrappers is %p", (part, tools, want) => {
  expect(permitsShellWrappers({ ...SPEC, ...part }, [...tools])).toBe(want);
});

/** A fake `claude` that logs each start, and a plugin whose `workit` prints `say`. */
const bench = (say: string, lines: string[]): { exit: number; starts: number } => {
  const cases = path.join(root, "cases");
  const plugin = path.join(root, "plugin");
  mkdirSync(cases, { recursive: true });
  mkdirSync(path.join(plugin, "skills"), { recursive: true });
  mkdirSync(path.join(plugin, "bin"), { recursive: true });
  writeFileSync(path.join(plugin, "bin", "workit"), `#!/bin/sh\necho "${say}"\n`);
  chmodSync(path.join(plugin, "bin", "workit"), 0o755);
  writeFileSync(
    path.join(cases, "wrap.json"),
    JSON.stringify({
      id: "wrap",
      source: "test",
      tier: "smoke",
      prompt: "fix the config with a python3 script",
      allowedTools: ["Bash(python3 *)"],
    }),
  );
  const log = path.join(root, "starts.log");
  const claude = path.join(root, "claude");
  writeFileSync(
    claude,
    `#!/bin/sh\ncat > /dev/null\necho start >> "${log}"\necho '{"type":"result","subtype":"success","num_turns":1}'\n`,
  );
  chmodSync(claude, 0o755);
  const exit = main(
    [
      "--model",
      "haiku",
      "--force",
      "--bin",
      claude,
      "--plugin-dir",
      plugin,
      "--results",
      path.join(root, "results"),
      "--cases-dir",
      cases,
      "--real-home",
      realHome,
    ],
    (text) => lines.push(text),
  );
  const starts = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0;
  return { exit, starts };
};

test("Given a case that permits python3 and a world whose workit resolves a path outside it, When run, Then the host never starts and the run fails as isolation", () => {
  const lines: string[] = [];
  const { exit, starts } = bench("/etc/workit-outside", lines);

  expect(starts).toBe(0);
  expect(exit).toBe(1);
  const stored = JSON.parse(readFileSync(path.join(root, "results", "haiku", "wrap.json"), "utf8"));
  expect(stored.refused).toBe("isolation");
  expect(stored.grade.failures[0].rule).toBe("isolation");
  expect(stored.grade.failures[0].detail).toContain("/etc/workit-outside");
});

test("Given a case that permits python3 and a world that passes the self-check, When run, Then the host starts", () => {
  const { exit, starts } = bench("$WORKIT_CONFIG_DIR", []);
  expect(starts).toBe(1);
  expect(exit).toBe(0);
});
