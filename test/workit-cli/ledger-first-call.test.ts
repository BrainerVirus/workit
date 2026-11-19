import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";

// Decision D4: `ledger list --limit n` and `ledger finding …` work on the first try.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const repo = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-ledger-first-"));
  dirs.push(root);
  for (const args of [
    ["init", "-q", "-b", "feature/x"],
    ["config", "user.email", "t@e.invalid"],
    ["config", "user.name", "T"],
    ["commit", "-q", "--allow-empty", "-m", "base"],
  ])
    spawnSync("git", args, { cwd: root });
  return root;
};

const run = async (cwd: string, argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "s-lead" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

test("ledger list --limit n lists the last n rows, like --last n", async () => {
  const root = repo();
  for (const what of ["first", "second", "third"])
    expect(
      (await run(root, ["ledger", "ruling", what, "--why", "w", "--cost-if-wrong", "c"])).code,
    ).toBe(0);

  const limited = await run(root, ["ledger", "list", "--limit", "2", "--json"]);

  expect(limited.code).toBe(0);
  expect(limited.json().data.rows.map((row: { what: string }) => row.what)).toEqual([
    "second",
    "third",
  ]);
});

test("ledger finding with free text is refused with a finding record call that records it", async () => {
  const root = repo();

  const refused = await run(root, [
    "ledger",
    "finding",
    "retry loop swallows the timeout",
    "--json",
  ]);

  expect(refused.code).not.toBe(0);
  const unblock: string = refused.json().unblock;
  const payload = /--payload '(.+)'$/u.exec(unblock)?.[1];
  expect(unblock).toStartWith("Retry as: workit finding record --payload '");
  expect(JSON.parse(payload ?? "null").claim).toBe("retry loop swallows the timeout");

  // The Retry as runs as given, once its placeholder is filled; `ledger finding` routes there too.
  const filled = (payload ?? "").replace("<what goes wrong because of it>", "a hung call passes");
  const recorded = await run(root, ["ledger", "finding", "--payload", filled]);
  expect(recorded.code, recorded.stdout + recorded.stderr).toBe(0);
  expect(recorded.stderr).toContain("running workit finding record");

  const listed = await run(root, ["ledger", "finding", "list", "--json"]);
  expect(listed.code).toBe(0);
  expect(listed.stdout).toContain("retry loop swallows the timeout");
});
