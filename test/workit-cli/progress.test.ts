import { expect, test } from "bun:test";
import { createProgress, type ProgressOptions } from "@/packages/workit-cli/src/progress";

const rig = (overrides: Partial<ProgressOptions> & { isTTY?: boolean } = {}) => {
  const writes: string[] = [];
  let clock = 0;
  let tick: (() => void) | null = null;
  let cleared = false;
  const { isTTY = true, ...rest } = overrides;
  const progress = createProgress({
    stream: { isTTY, write: (text) => writes.push(text) },
    env: {},
    now: () => clock,
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      cleared = true;
      tick = null;
    },
    ...rest,
  });
  return {
    progress,
    writes,
    advance: (ms: number) => {
      clock += ms;
      tick?.();
    },
    cleared: () => cleared,
  };
};

test("spinner frames advance with elapsed seconds and the line clears on done", () => {
  const { progress, writes, advance, cleared } = rig();
  const step = progress.start("Updating codex");
  advance(140);
  advance(1200);
  expect(writes[0]).toContain("\x1b[36m◐\x1b[0m Updating codex (0s)");
  expect(writes[1]).toContain("◓\x1b[0m Updating codex (0s)");
  expect(writes[2]).toContain("◑\x1b[0m Updating codex (1s)");
  step.end("done");
  expect(cleared()).toBe(true);
  const last = writes.at(-1)!;
  expect(last.startsWith("\r\x1b[2K")).toBe(true);
  expect(last).toContain("✓");
  expect(last.endsWith("Updating codex\n")).toBe(true);
});

test("label updates redraw and failed and skipped steps leave one line each", () => {
  const { progress, writes } = rig();
  const step = progress.start("Waiting for CI");
  step.label("Waiting for CI: 2 checks pending");
  expect(writes.at(-1)).toContain("Waiting for CI: 2 checks pending (0s)");
  step.end("failed", "boom");
  expect(writes.at(-1)).toContain("✗");
  expect(writes.at(-1)).toContain("Waiting for CI: 2 checks pending: boom\n");
  const skipped = progress.start("Cursor");
  skipped.end("skipped");
  expect(writes.at(-1)).toContain("– Cursor\n");
});

test("Given a transient progress on a color TTY, When steps end, Then done and skipped steps clear their line and a failed one stays", () => {
  const { progress, writes } = rig({ transient: true });
  progress.start("[1/2] Updating codex").end("done");
  expect(writes.at(-1)).toBe("\r\x1b[2K");
  progress.start("[2/2] Updating pi").end("skipped", "close pi");
  expect(writes.at(-1)).toBe("\r\x1b[2K");
  progress.start("Updating cursor").end("failed", "npm exited 1");
  expect(writes.at(-1)).toContain("Updating cursor: npm exited 1\n");
});

test("Given a transient progress off a color TTY, When a step ends, Then a pipe gets nothing and NO_COLOR keeps the line", () => {
  const { progress, writes } = rig({ transient: true, isTTY: false });
  progress.start("Updating codex").end("done");
  expect(writes).toEqual([]);
  const plain = rig({ transient: true, env: { NO_COLOR: "1" } });
  plain.progress.start("Updating codex").end("done");
  expect(plain.writes.at(-1)).toBe("✓ Updating codex\n");
});

test("runSync draws a static line, not an animation, and classifies the result", () => {
  const { progress, writes } = rig();
  const value = progress.runSync(
    "Planning",
    () => 7,
    (n) => (n > 5 ? "failed" : "done"),
  );
  expect(value).toBe(7);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toContain("✗");
});

test("run ends a throwing step as failed and rethrows", async () => {
  const { progress, writes } = rig();
  await expect(
    progress.run("Boom", async () => {
      throw new Error("x");
    }),
  ).rejects.toThrow("x");
  expect(writes.at(-1)).toContain("✗");
});

test("nothing is drawn for a non-TTY stream, --json or CI", () => {
  for (const options of [{ isTTY: false }, { json: true }, { env: { CI: "true" } }]) {
    const { progress, writes } = rig(options);
    expect(progress.mode).toBe("off");
    progress.runSync("Step", () => 1);
    progress.start("Other").end("failed");
    expect(writes).toEqual([]);
  }
});

test("NO_COLOR and TERM=dumb print plain finished lines without animation", () => {
  const color = rig({ env: { NO_COLOR: "1" } });
  expect(color.progress.mode).toBe("plain");
  color.progress.runSync("Step", () => 1);
  expect(color.writes).toEqual(["✓ Step\n"]);
  const dumb = rig({ env: { TERM: "dumb" } });
  dumb.progress.start("Step").end("failed");
  expect(dumb.writes).toEqual(["x Step\n"]);
});

const procRig = () => {
  const listeners = new Map<string, ((...args: any[]) => void)[]>();
  const kills: [number, string][] = [];
  const proc = {
    pid: 4242,
    on: (event: string, fn: (...args: any[]) => void) =>
      listeners.set(event, [...(listeners.get(event) ?? []), fn]),
    off: (event: string, fn: (...args: any[]) => void) =>
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((x) => x !== fn),
      ),
    kill: (pid: number, signal: string) => kills.push([pid, signal]),
  };
  const count = () => [...listeners.values()].reduce((sum, list) => sum + list.length, 0);
  return { proc, listeners, kills, count };
};

test("a SIGINT mid-step clears the spinner line, removes handlers and re-raises the signal", () => {
  const p = procRig();
  const { progress, writes } = rig({ proc: p.proc });
  progress.start("Updating codex");
  expect(p.count()).toBe(3);
  p.listeners.get("SIGINT")![0]();
  expect(writes.at(-1)).toBe("\r\x1b[2K");
  expect(p.count()).toBe(0);
  expect(p.kills).toEqual([[4242, "SIGINT"]]);
});

test("a SIGTERM re-raises SIGTERM, and exit clears an unfinished line", () => {
  const p = procRig();
  const { progress, writes } = rig({ proc: p.proc });
  progress.start("Updating codex");
  p.listeners.get("exit")![0]();
  expect(writes.at(-1)).toBe("\r\x1b[2K");
  p.listeners.get("SIGTERM")![0]();
  expect(p.kills).toEqual([[4242, "SIGTERM"]]);
});

test("ending a step removes every handler, and off and plain modes install none", () => {
  const p = procRig();
  const { progress } = rig({ proc: p.proc });
  progress.start("one").end("done");
  progress.start("two").end("failed");
  expect(p.count()).toBe(0);
  for (const over of [{ isTTY: false }, { json: true }, { env: { NO_COLOR: "1" } }]) {
    const q = procRig();
    rig({ proc: q.proc, ...over }).progress.start("x");
    expect(q.count()).toBe(0);
  }
});

test("runSync installs no SIGINT/SIGTERM handler while its work blocks the thread", () => {
  // A JS handler defers the signal until the blocking call returns, so the verb
  // would read its killed child as a failure instead of dying by the signal.
  const p = procRig();
  const { progress } = rig({ proc: p.proc, spawnTicker: () => undefined });
  let during: string[] = [];
  const value = progress.runSync("Checking the push", () => {
    during = [...p.listeners.entries()].filter(([, list]) => list.length).map(([event]) => event);
    return 3;
  });
  expect(value).toBe(3);
  expect(during).not.toContain("SIGINT");
  expect(during).not.toContain("SIGTERM");
  expect(p.count()).toBe(0);
});

test("run installs no SIGINT/SIGTERM handler either: its work may block between awaits", async () => {
  const p = procRig();
  const { progress } = rig({ proc: p.proc });
  let during: string[] = [];
  await progress.run("Merging PR #1", async () => {
    during = [...p.listeners.entries()].filter(([, list]) => list.length).map(([event]) => event);
  });
  expect(during).toEqual(["exit"]);
  expect(p.count()).toBe(0);
});

test("run with signals:true registers SIGINT/SIGTERM, clears the line and re-raises", async () => {
  const p = procRig();
  const { progress, writes } = rig({ proc: p.proc });
  let during: string[] = [];
  await progress.run(
    "Updating the CLI",
    async () => {
      during = [...p.listeners.entries()].filter(([, l]) => l.length).map(([e]) => e);
      p.listeners.get("SIGINT")![0]();
    },
    undefined,
    { signals: true },
  );
  expect(during).toEqual(expect.arrayContaining(["SIGINT", "SIGTERM", "exit"]));
  expect(writes.join("")).toContain("\r\x1b[2K");
  expect(p.kills).toEqual([[4242, "SIGINT"]]);
  expect(p.count()).toBe(0);
});

test("Ctrl-C during a runSync wait ends the process by SIGINT at once, as without a spinner", async () => {
  const script = `
    const { spawnSync } = require("node:child_process");
    const { createProgress } = require(${JSON.stringify(require.resolve("@/packages/workit-cli/src/progress"))});
    const progress = createProgress({
      stream: { isTTY: true, write: (t) => process.stderr.write(t) },
      env: {},
      spawnTicker: () => undefined,
    });
    process.stdout.write("ready\\n");
    progress.runSync("Waiting", () => spawnSync("sleep", ["6"]));
    process.stdout.write("returned\\n");
    process.exit(5);
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  let seen = "";
  while (!seen.includes("ready")) seen += new TextDecoder().decode((await reader.read()).value);
  const sent = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.kill("SIGINT");
  await child.exited;
  expect(child.signalCode).toBe("SIGINT");
  expect(Date.now() - sent).toBeLessThan(3000);
}, 15_000);
