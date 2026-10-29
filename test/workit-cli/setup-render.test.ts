// `workit setup` shows its permission diff as a colored unified diff in a
// terminal; a pipe, an agent host, NO_COLOR and --json keep the plain text.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Io } from "@/packages/workit-cli/src/output";
import { run } from "@/packages/workit-cli/src/verbs/setup";

const scratch = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "wk-setup-render-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const home = path.join(scratch, "home");
mkdirSync(path.join(home, ".codex/rules"), { recursive: true });
// A stale Workit rules file: the diff has removed, added and context lines.
writeFileSync(
  path.join(home, ".codex/rules/workit.rules"),
  "# Workit-owned: written by `workit setup`, removed by `workit uninstall`.\nstale line\n",
);

const dryRun = async (extra: Partial<Io>, env: NodeJS.ProcessEnv = {}) => {
  const out: string[] = [];
  const code = await run(["--dry-run", "--hosts=codex", "--no-shell"], {
    json: false,
    cwd: home,
    env: { HOME: home, PATH: process.env.PATH, ...env },
    stdout: (text) => void out.push(text),
    stderr: (text) => void out.push(text),
    ...extra,
  });
  expect(code).toBe(0);
  return out.join("");
};

test("Given no terminal, NO_COLOR or CI, When setup shows the diff, Then it is plain text", async () => {
  const plain = await dryRun({});
  expect(plain).not.toContain("\x1b[");
  expect(plain).toContain("--- ");
  expect(plain).toContain("\n- stale line\n");
  expect(await dryRun({ terminals: { stdout: { isTTY: false } } })).toBe(plain);
  expect(await dryRun({ terminals: { stdout: { isTTY: true } } }, { NO_COLOR: "1" })).toBe(plain);
  expect(await dryRun({ terminals: { stdout: { isTTY: true } } }, { CI: "true" })).toBe(plain);
});

test("Given a color terminal or FORCE_COLOR, When setup shows the diff, Then +/- lines, header and context are colored", async () => {
  const plain = await dryRun({});
  for (const [terminals, env] of [
    [{ stdout: { isTTY: true } }, {}],
    [{ stdout: { isTTY: false } }, { FORCE_COLOR: "1" }],
  ] as const) {
    const colored = await dryRun({ terminals }, env);
    expect(stripVTControlCharacters(colored)).toBe(plain);
    expect(colored).toContain(`\x1b[1m--- ${path.join(home, ".codex/rules/workit.rules")}\x1b[0m`);
    expect(colored).toContain("\x1b[31m- stale line\x1b[0m");
    expect(colored).toContain("\x1b[32m+ prefix_rule(\x1b[0m");
    expect(colored).toContain("\x1b[2m  # Workit-owned");
  }
});
