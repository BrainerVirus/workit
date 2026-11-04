// #423: a cached "latest" older than the running CLI (a stale cache, a
// lagging mirror, a run right after a publish) never reads as an update and
// never reads as the latest version.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "@/packages/workit-cli/src/admin/doctor";
import {
  latestNotOlder,
  launchUpdateCheck,
  writeUpdateCache,
} from "@/packages/workit-cli/src/update-check";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 10, 3, 12);

const setup = () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-update-stale-"));
  homes.push(home);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    WORKFLOW_TOOLKIT_STATE: path.join(home, "state"),
    TERM: "xterm-256color",
    PATH: "/usr/bin",
  };
  writeUpdateCache(env, { checkedAt: NOW, latest: "8.52.3" });
  return { home, env };
};

test("latestNotOlder keeps a newer latest and lifts an older one to the running version", () => {
  expect(latestNotOlder("9.0.0", "8.55.0")).toBe("9.0.0");
  expect(latestNotOlder("8.52.3", "8.55.0")).toBe("8.55.0");
  expect(latestNotOlder(undefined, "8.55.0")).toBeUndefined();
});

test("Given a cached latest older than the running CLI, When a person launches workit, Then nothing is offered", async () => {
  const { env } = setup();
  const asked: string[] = [];
  const code = await launchUpdateCheck(
    { argv: ["status"], command: "status", json: false },
    {
      env,
      stdin: { isTTY: true },
      stdout: { isTTY: true },
      stderr: { isTTY: true, write: () => true } as never,
      write: () => {},
      now: () => NOW,
      installed: "8.55.0",
      refresh: () => {},
      ask: async (question) => {
        asked.push(question);
        return "u";
      },
      upgrade: async () => ({ code: 0, failed: [] }),
    },
  );
  expect(code).toBeUndefined();
  expect(asked).toEqual([]);
});

test("Given a cached latest older than the running CLI, Then doctor's updates row reports the running version as latest", () => {
  const { home, env } = setup();
  const updates = runDoctor({
    host: "cli",
    home,
    cwd: home,
    workspaceRoot: home,
    configDir: path.join(home, ".config/workit"),
    stateDir: path.join(home, "state"),
    env,
    cliVersion: "8.55.0",
  }).checks.find((check) => check.id === "updates")!;
  expect(updates.detail).toContain("latest CLI 8.55.0");
  expect(updates.detail).not.toContain("8.52.3");
});
