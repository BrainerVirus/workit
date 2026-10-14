import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { hostPid, leadOf, liveOwner } from "@/packages/workit-core/src/core/live-session";

// #274: who owns a checkout. A session's subagents (`<lead>:<agent>`) and
// fanout workers (`<lead>-w-<slice>`) share its lead; a hook process's owner
// is the long-lived host behind any launcher wrapper.

test("leadOf: an issued subagent id and a fanout worker id resolve to their lead", () => {
  expect(leadOf("abc-123")).toBe("abc-123");
  expect(leadOf("abc-123:agent-9")).toBe("abc-123");
  expect(leadOf("abc-123-w-api")).toBe("abc-123");
  expect(leadOf("abc-123-w-api+try2")).toBe("abc-123");
});

test("liveOwner: no session id is no owner; a parent and a Pi worker's workit id add leads", () => {
  const input = (id: string, parentId: string | null = null) => ({
    host: "cursor",
    session: { id, parentId },
  });
  expect(liveOwner(input(""), "hook-process", {})).toBeNull();
  expect(liveOwner(input("sub-1", "conv-lead"), "in-process-plugin", {})).toEqual({
    host: "cursor",
    session: "sub-1",
    leads: ["sub-1", "conv-lead"],
    pid: process.pid,
  });
  const worker = liveOwner(input("pi-worker-ses"), "in-process-plugin", {
    WORKIT_PI_WORKER_SESSION: "pi-worker-ses",
    WORKIT_SESSION_ID: "pi-lead:pi-worker-ses",
  });
  expect(worker?.leads).toEqual(["pi-worker-ses", "pi-lead"]);
});

test.skipIf(process.platform === "win32")(
  "hostPid: a hook process started through a shell wrapper names the process behind the shell",
  () => {
    const module = path.resolve(
      import.meta.dir,
      "../../packages/workit-core/src/core/live-session.ts",
    );
    const script = `import { hostPid } from ${JSON.stringify(module)}; console.log(hostPid("hook-process"));`;
    // `; true` keeps the shell alive, as a launcher that does not exec would.
    const run = spawnSync(
      "sh",
      ["-c", `"${process.execPath}" -e '${script.replaceAll("'", "'\\''")}'; true`],
      { encoding: "utf8" },
    );
    expect(run.stderr).toBe("");
    expect(Number(run.stdout.trim())).toBe(process.pid);
    expect(hostPid("in-process-plugin")).toBe(process.pid);
  },
);
