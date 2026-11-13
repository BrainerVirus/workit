// #328 ruling C: a stop signals a process group only while its leader is still
// the recorded process, checked before SIGTERM and again before SIGKILL.
import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { groupRss, identity, procTree, stopGroup } from "@/packages/workit-core/src/core/proc-tree";

const saved = { ...procTree };
const children: number[] = [];
afterEach(() => {
  Object.assign(procTree, saved);
  for (const pid of children.splice(0))
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
});

const group = (script: string) => {
  const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
  children.push(child.pid!);
  return child.pid!;
};

const alive = (target: number) => {
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
};

test("Given a live group whose leader start time matches, When stopGroup runs, Then SIGTERM ends it", async () => {
  const pid = group("while :; do sleep 1; done");
  await Bun.sleep(50);
  const result = await stopGroup({ pid, pgid: pid, pidStart: procTree.start(pid) }, 2_000);
  expect(result).toEqual({ outcome: "stopped", signal: "SIGTERM" });
  expect(alive(-pid)).toBe(false);
});

test("Given a child that ignores SIGTERM, When stopGroup runs, Then it is killed after the grace", async () => {
  const pid = group(`sh -c 'trap "" TERM; while :; do sleep 1; done' & while :; do sleep 1; done`);
  await Bun.sleep(100);
  const result = await stopGroup({ pid, pgid: pid, pidStart: procTree.start(pid) }, 300);
  expect(result).toEqual({ outcome: "stopped", signal: "SIGKILL" });
  await Bun.sleep(50);
  expect(alive(-pid)).toBe(false);
});

test("Given a pid whose start time differs from the recorded one, When stopGroup runs, Then nothing is signalled", async () => {
  const pid = group("while :; do sleep 1; done");
  const sent: Array<[number, string | number]> = [];
  procTree.kill = (target, signal) => {
    if (signal !== 0) sent.push([target, signal]);
    process.kill(target, signal);
  };
  expect(identity(pid, "not-its-start")).toBe("reused");
  const result = await stopGroup({ pid, pgid: pid, pidStart: "not-its-start" }, 300);
  expect(result).toEqual({ outcome: "reused" });
  expect(sent).toEqual([]);
  expect(alive(pid)).toBe(true);
});

test("Given the leader's pid is taken by another process during the grace, When the grace ends, Then SIGKILL is never sent", async () => {
  const pid = group(`trap "" TERM; while :; do sleep 1; done`);
  await Bun.sleep(50);
  const real = procTree.start(pid);
  const sent: Array<string | number> = [];
  let afterTerm = false;
  procTree.kill = (target, signal) => {
    if (signal === "SIGTERM") afterTerm = true;
    if (signal !== 0) sent.push(signal);
    process.kill(target, signal);
  };
  // After SIGTERM the pid reads as another process's.
  procTree.start = (target) => (afterTerm ? "someone-else" : saved.start(target));
  const result = await stopGroup({ pid, pgid: pid, pidStart: real }, 200);
  expect(result).toEqual({ outcome: "reused" });
  expect(sent).toEqual(["SIGTERM"]);
});

test("Given Windows, When stopGroup runs, Then it is report-only and signals nothing", async () => {
  procTree.platform = "win32";
  const result = await stopGroup({ pid: 1234, pgid: null, pidStart: null });
  expect(result.outcome).toBe("refused");
});

test("Given a fake process table, When groupRss reads a group, Then it sums its members' RSS in bytes", () => {
  procTree.table = () => " 10  100\n 10  50\n 11  999\n";
  expect(groupRss(10)).toBe(150 * 1024);
  expect(groupRss(12)).toBeNull();
  procTree.table = () => null;
  expect(groupRss(10)).toBeNull();
});
