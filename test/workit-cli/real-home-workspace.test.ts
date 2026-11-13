// #859: `workit workspace` reads and writes workspaces.json in the config dir
// io.env names, so an in-process call with a temp config never reaches the
// real one. Read-only here: `list` only.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWorkspace } from "@/packages/workit-cli/src/verbs/workspace";

const dirs: string[] = [];
const saved = process.env.WORKIT_CONFIG;
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.WORKIT_CONFIG;
  else process.env.WORKIT_CONFIG = saved;
});

test("Given io.env naming a temp WORKIT_CONFIG and a process env naming another, When workspace list runs in process, Then it lists io.env's workspaces.json", async () => {
  const [injected, ambient] = ["wk-ws-injected-", "wk-ws-ambient-"].map((prefix) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  });
  const entry = (name: string, dir: string) => ({ workspaces: [{ name, glob: `${dir}/**` }] });
  writeFileSync(
    path.join(injected, "workspaces.json"),
    JSON.stringify(entry("injected", injected)),
  );
  writeFileSync(path.join(ambient, "workspaces.json"), JSON.stringify(entry("ambient", ambient)));
  process.env.WORKIT_CONFIG = ambient;
  const out: string[] = [];
  const code = await runWorkspace(["list"], {
    json: true,
    cwd: injected,
    env: { WORKIT_CONFIG: injected },
    stdout: (text) => void out.push(text),
    stderr: (text) => void out.push(text),
  });
  expect(code, out.join("")).toBe(0);
  const text = out.join("");
  expect(text).toContain('"injected"');
  expect(text).not.toContain('"ambient"');
});
