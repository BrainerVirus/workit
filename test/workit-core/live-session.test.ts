import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkoutKey,
  claimLiveSession,
  hostPid,
  leadOf,
  liveConflict,
  liveOwner,
  liveProbe,
  markerFile,
  type LiveMarker,
  type LiveOwner,
} from "@/packages/workit-core/src/core/live-session";
import { shellGate, writeGate } from "@/packages/workit-core/src/hooks/write-gate";

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
  const owner = liveOwner(input("sub-1", "conv-lead"), "in-process-plugin", {});
  expect(owner).toMatchObject({ host: "cursor", session: "sub-1", leads: ["sub-1", "conv-lead"] });
  expect(owner?.pid()).toBe(process.pid);
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

// --- markers on a real checkout ---------------------------------------------

const dirs: string[] = [];
let previousState: string | undefined;
let sleeper: ChildProcess | undefined;
const probe = { ...liveProbe };
beforeEach(() => {
  previousState = process.env.WORKFLOW_TOOLKIT_STATE;
  const state = mkdtempSync(path.join(os.tmpdir(), "wk-live-unit-state-"));
  dirs.push(state);
  process.env.WORKFLOW_TOOLKIT_STATE = state;
});
afterEach(() => {
  Object.assign(liveProbe, probe);
  if (previousState === undefined) delete process.env.WORKFLOW_TOOLKIT_STATE;
  else process.env.WORKFLOW_TOOLKIT_STATE = previousState;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  sleeper?.kill();
  sleeper = undefined;
});

const checkout = (): string => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-live-unit-repo-")));
  dirs.push(root);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  return root;
};

const livePid = (): number => {
  sleeper ??= spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
  return sleeper.pid as number;
};

const seed = (root: string, marker: Partial<LiveMarker>) => {
  const file = markerFile(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      session: "foreign",
      leads: ["foreign"],
      host: "claude_code",
      pid: livePid(),
      pidStart: null,
      machine: os.hostname(),
      checkout: root,
      heartbeatAt: new Date().toISOString(),
      ...marker,
    }),
  );
  return file;
};

const owner = (session: string, pid: number | null, host = "claude_code"): LiveOwner => ({
  host,
  session,
  leads: [leadOf(session)],
  pid: () => pid,
});

test("G macOS (ps for the process table), W the owning session writes again and again, T the host pid is never looked up", () => {
  let calls = 0;
  liveProbe.platform = "darwin";
  liveProbe.run = () => {
    calls++;
    return "1 /usr/local/bin/claude\n";
  };
  liveProbe.start = () => {
    calls++;
    return null;
  };
  const root = checkout();
  seed(root, { session: "lead-1", leads: ["lead-1"], pidStart: "Mon Jan  1 00:00:00 2026" });
  const self = liveOwner(
    { host: "claude_code", session: { id: "lead-1:agent-2", parentId: null } },
    "hook-process",
    {},
  );
  for (let index = 0; index < 20; index++) {
    expect(shellGate(root, "git commit -m x", self).kind).toBe("none");
    expect(writeGate(root, ["a.ts"], self).kind).toBe("none");
  }
  expect(calls).toBe(0);
});

test("G a foreign marker, W the pid is read, T at most one ancestry walk per process", () => {
  let calls = 0;
  liveProbe.platform = "freebsd";
  liveProbe.run = () => {
    calls++;
    return "1 /usr/local/bin/cursor\n";
  };
  liveProbe.start = () => null;
  const root = checkout();
  seed(root, { session: "foreign", pid: livePid() });
  const other = liveOwner(
    { host: "cursor", session: { id: "conv-2", parentId: null } },
    "hook-process",
    {},
  );
  for (let index = 0; index < 5; index++)
    expect(shellGate(root, "git commit -m x", other).kind).toBe("deny");
  expect(calls).toBeLessThanOrEqual(1);
});

test("G no host pid (Windows), W another session of the same host writes, T allowed; another host is still refused", () => {
  const root = checkout();
  seed(root, { session: "claude-a", leads: ["claude-a"], pid: null });
  expect(liveConflict(path.join(root, "x"), owner("claude-cleared", null))).toBeNull();
  seed(root, { session: "codex-a", leads: ["codex-a"], host: "codex_cli", pid: livePid() });
  expect(liveConflict(path.join(root, "x"), owner("codex-sub", null, "codex_desktop"))).toBeNull();
  expect(liveConflict(path.join(root, "x"), owner("claude-b", null))?.marker.session).toBe(
    "codex-a",
  );
});

test("G a marker whose pid now belongs to another process (start time differs), T it is not live", () => {
  const root = checkout();
  const pid = livePid();
  liveProbe.start = () => "Mon Jan  1 00:00:00 2026";
  seed(root, { pid, pidStart: "Sun Dec 31 00:00:00 2023" });
  expect(liveConflict(path.join(root, "x"), owner("mine", 1))).toBeNull();
  seed(root, { pid, pidStart: "Mon Jan  1 00:00:00 2026" });
  expect(liveConflict(path.join(root, "x"), owner("mine", 1))?.marker.session).toBe("foreign");
});

test("G a live foreign marker, W another session claims, T the marker is untouched; its own marker is rewritten at most every 30 s", () => {
  const root = checkout();
  const file = seed(root, { heartbeatAt: new Date(Date.now() - 60_000).toISOString() });
  const before = readFileSync(file, "utf8");
  claimLiveSession(path.join(root, "a.ts"), owner("mine", 1, "cursor"));
  expect(readFileSync(file, "utf8")).toBe(before);

  const fresh = checkout();
  const now = new Date();
  claimLiveSession(path.join(fresh, "a.ts"), owner("mine", 1), { now });
  const first = JSON.parse(readFileSync(markerFile(fresh), "utf8")) as LiveMarker;
  expect(first).toMatchObject({ session: "mine", heartbeatAt: now.toISOString() });
  const soon = new Date(now.getTime() + 10_000);
  claimLiveSession(path.join(fresh, "a.ts"), owner("mine", 1), { now: soon });
  expect(JSON.parse(readFileSync(markerFile(fresh), "utf8")).heartbeatAt).toBe(now.toISOString());
  const later = new Date(now.getTime() + 31_000);
  claimLiveSession(path.join(fresh, "a.ts"), owner("mine", 1), { now: later });
  expect(JSON.parse(readFileSync(markerFile(fresh), "utf8")).heartbeatAt).toBe(later.toISOString());
});

test("G a checkout reached through a symlink, W the marker is seeded under one spelling and looked up under another, T both name one marker", () => {
  const root = checkout();
  const link = path.join(os.tmpdir(), `wk-live-link-${process.pid}-${Date.now()}`);
  dirs.push(link);
  symlinkSync(root, link, process.platform === "win32" ? "junction" : "dir");
  expect(markerFile(link)).toBe(markerFile(root));
  seed(link, {});
  expect(liveConflict(path.join(root, "x"), owner("mine", 1, "cursor"))?.marker.session).toBe(
    "foreign",
  );
});

test("checkoutKey: a missing path keeps its resolved spelling; on Windows lower-cased with backslashes", () => {
  const missing = path.join(os.tmpdir(), "Some", "Repo-Not-There");
  const resolved = path.resolve(missing);
  expect(checkoutKey(missing, "linux")).toBe(resolved);
  expect(checkoutKey(missing, "win32")).toBe(resolved.replaceAll("/", "\\").toLowerCase());
});

test("G Windows (no host pid), W a lead's Cursor marker with a live pid of unknown start, T its subagent may write and a Claude Code session may not", () => {
  liveProbe.platform = "win32";
  const root = checkout();
  seed(root, { host: "cursor", session: "conv-lead", leads: ["conv-lead"], pidStart: null });
  const subagent = liveOwner(
    { host: "cursor", session: { id: "conv-sub", parentId: null } },
    "hook-process",
    {},
  );
  expect(subagent?.pid()).toBeNull();
  expect(liveConflict(path.join(root, "x"), subagent as LiveOwner)).toBeNull();
  const claude = liveOwner(
    { host: "claude_code", session: { id: "claude-1", parentId: null } },
    "hook-process",
    {},
  );
  expect(liveConflict(path.join(root, "x"), claude as LiveOwner)?.marker.session).toBe("conv-lead");
});
