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
  advance(120);
  advance(1200);
  expect(writes[0]).toContain("· Updating codex (0s)");
  expect(writes[1]).toContain("✢ Updating codex (0s)");
  expect(writes[2]).toContain("✳ Updating codex (1s)");
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
