// #859: `workit doctor` as a verb read the process's HOME and config, so an
// injected env could not steer it (only runDoctor took one). The run below
// calls main in a child whose own HOME is a decoy: a path not taken from
// io.env names the decoy (and fails the test), never the developer's home.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountHome } from "@/packages/workit-core/src/core/account-home";
import { guardRealHome } from "@/test/shared/real-state-guard";

const MAIN = path.resolve(import.meta.dir, "../../packages/workit-cli/src/main.ts");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Given main(['doctor', '--fix', '--json']) in process with an injected env, When it runs, Then every path it reports is from that env and nothing is written outside it", () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-real-home-doctor-")));
  roots.push(root);
  const [fixture, decoy, work] = ["fixture", "decoy", "work"].map((dir) => path.join(root, dir));
  for (const dir of [decoy, work, path.join(fixture, ".claude")])
    mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(fixture, ".claude", "settings.json"), "{}\n");
  let realHomeUnchanged = () => {};
  guardRealHome(accountHome(), (check) => {
    realHomeUnchanged = check;
  });
  const PATH = "/usr/bin:/bin";
  const script = `const { main } = await import(${JSON.stringify(MAIN)});
const out = [];
const code = await main(["doctor", "--fix", "--json"], {
  cwd: ${JSON.stringify(work)},
  env: { HOME: ${JSON.stringify(fixture)}, PATH: ${JSON.stringify(PATH)} },
  stdout: (text) => void out.push(text),
  stderr: (text) => void out.push(text),
});
console.log(JSON.stringify({ code, out: out.join("") }));`;
  const child = spawnSync(process.execPath, ["-e", script], {
    cwd: work,
    env: {
      HOME: decoy,
      PATH,
      WORKIT_TEST_RUN: process.env.WORKIT_TEST_RUN,
      WORKIT_STATE_DIR: process.env.WORKIT_STATE_DIR,
      WORKIT_NO_YTRACK: "1",
      WORKIT_NO_PRESSURE_GATE: "1",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(child.status, child.stderr).toBe(0);
  const { out } = JSON.parse(child.stdout.trim().split("\n").at(-1)!) as { out: string };
  const report = JSON.parse(out) as { checks: { id: string; detail?: string }[] };
  const text = JSON.stringify(report);
  // The fixture's Claude settings are the ones it read; the decoy appears nowhere.
  expect(text).toContain(path.join(fixture, ".claude", "settings.json"));
  expect(text).not.toContain(decoy);
  const home = accountHome();
  if (home)
    for (const dir of [".claude", ".cursor", ".codex", ".config/workit"])
      expect(text).not.toContain(path.join(home, dir));
  expect(readdirSync(decoy)).toEqual([]);
  expect(realHomeUnchanged).not.toThrow();
});
