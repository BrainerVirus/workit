// `workit uninstall --hosts` safety (#832 review): host lists merge, an agent
// is refused before any plan output, an unreadable file stops its host before
// anything changes, a failure lists what was and was not removed, a changed
// Workit-owned file is kept, and a user file keeps its own formatting.
// Every run uses a temp home passed through io.env.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import { run as uninstall } from "@/packages/workit-cli/src/verbs/uninstall";

const scratch = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "wk-uninstall-safety-"));
afterAll(() => {
  // A test may leave a file mode 000; make everything removable first.
  try {
    chmodSync(path.join(scratch, "unreadable", ".cursor", "cli-config.json"), 0o600);
  } catch {}
  rmSync(scratch, { recursive: true, force: true });
});

const io = (home: string, env: NodeJS.ProcessEnv = {}, json = false) => {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = {
    json,
    cwd: home,
    env: { HOME: home, PATH: process.env.PATH, ...env },
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  };
  return {
    io: value,
    out: () => out.join(""),
    err: () => err.join(""),
    all: () => out.join("") + err.join(""),
  };
};

const lastJson = (text: string) => JSON.parse(text.trim().split("\n").at(-1) ?? "");

test("D4: Given --hosts twice and a duplicate, Then the hosts merge in first-given order without duplicates", async () => {
  const home = path.join(scratch, "merge");
  mkdirSync(home, { recursive: true });
  const run = io(home, { CLAUDECODE: "1" }, true);
  expect(await uninstall(["--hosts=cursor,cursor", "--hosts=pi,cursor", "--yes"], run.io)).toBe(3);
  expect(lastJson(run.out()).unblock).toBe("workit uninstall --hosts=cursor,pi --yes");
  const preview = io(home, {}, true);
  expect(await uninstall(["--hosts=cursor", "--hosts", "pi", "--preview"], preview.io)).toBe(0);
  expect(lastJson(preview.out()).data.hosts).toEqual(["cursor", "pi"]);
});
