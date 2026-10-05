import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStore } from "@/packages/workit-core/src/store/paths";
import {
  abandonedLaunches,
  cancelHint,
  clearLaunch,
  recordLaunch,
} from "@/packages/workit-pi/src/launches";

const checkout = () => mkdtempSync(path.join(os.tmpdir(), "wk-pi-launch-"));

test("Given two Pi processes launching one worker, When both claim it, Then only the first claim is recorded", () => {
  const root = checkout();
  try {
    const attempt = { taskId: "t", workerId: "w1", session: "pi-worker-w1-aaaa" };
    expect(recordLaunch(root, attempt)).toBe(true);
    expect(recordLaunch(root, { ...attempt, session: "pi-worker-w1-bbbb" })).toBe(false);
    // The launcher is this live process, so nothing is abandoned yet.
    expect(abandonedLaunches(root)).toEqual([]);
    clearLaunch(root, "w1");
    expect(recordLaunch(root, attempt)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Given a launch marker left by a dead launcher, When a Pi session starts, Then it is reported as abandoned with a cancel hint", () => {
  const root = checkout();
  try {
    expect(recordLaunch(root, { taskId: "t", workerId: "w2", session: "pi-worker-w2-cccc" })).toBe(
      true,
    );
    const location = resolveStore(root);
    if (location instanceof Error) throw location;
    const dir = path.join(location.dir, "pi-launches");
    const [name] = readdirSync(dir);
    writeFileSync(
      path.join(dir, name),
      JSON.stringify({
        taskId: "t",
        workerId: "w2",
        session: "pi-worker-w2-cccc",
        pid: 2_147_483_646,
        host: os.hostname(),
        at: new Date().toISOString(),
      }),
    );
    expect(abandonedLaunches(root)).toMatchObject([
      { workerId: "w2", session: "pi-worker-w2-cccc" },
    ]);
    expect(cancelHint("w2")).toContain('workit_worker {"action":"cancel","workerId":"w2"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
