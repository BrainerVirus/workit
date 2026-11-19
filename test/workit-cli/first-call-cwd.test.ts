import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";

// A judge's verdict line carries --cwd <checkout>; run in process (tests, a
// long-lived host), the CLI must hand the caller's cwd back, or Windows
// cannot delete that checkout while the caller sits in it (EBUSY).

test("main with --cwd returns the process to the caller's cwd after the verb", async () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-cwd-back-")));
  try {
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    const before = process.cwd();
    let stdout = "";
    const code = await main(["ledger", "list", "--cwd", dir, "--json"], {
      cwd: before,
      env: { ...process.env, WORKIT_SESSION_ID: "s-cwd" },
      stdout: (text) => void (stdout += text),
      stderr: () => {},
    });
    expect(code, stdout).toBe(0);
    expect(process.cwd()).toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
