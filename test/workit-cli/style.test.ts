import { expect, test } from "bun:test";
import {
  colorDiff,
  colorEnabled,
  createStyle,
  spinnerPaint,
  terminalMode,
  wrap,
} from "@/packages/workit-cli/src/style";
import { createProgress } from "@/packages/workit-cli/src/progress";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { runInNewContext } from "node:vm";

const tty = { isTTY: true, columns: 80 };

test("color is on only for a TTY without NO_COLOR, CI or TERM=dumb", () => {
  expect(colorEnabled({ stream: tty, env: {} })).toBe(true);
  expect(colorEnabled({ stream: { isTTY: false }, env: {} })).toBe(false);
  expect(colorEnabled({ stream: undefined, env: {} })).toBe(false);
  expect(colorEnabled({ stream: tty, env: { NO_COLOR: "1" } })).toBe(false);
  expect(colorEnabled({ stream: tty, env: { TERM: "dumb" } })).toBe(false);
  expect(colorEnabled({ stream: tty, env: { CI: "true" } })).toBe(false);
  expect(colorEnabled({ stream: tty, env: {}, json: true })).toBe(false);
});

test("FORCE_COLOR forces color on a pipe but never under --json", () => {
  expect(colorEnabled({ stream: { isTTY: false }, env: { FORCE_COLOR: "1" } })).toBe(true);
  expect(colorEnabled({ stream: undefined, env: { FORCE_COLOR: "1" } })).toBe(false);
  expect(colorEnabled({ stream: { isTTY: false }, env: { FORCE_COLOR: "0" } })).toBe(false);
  expect(colorEnabled({ stream: { isTTY: false }, env: { FORCE_COLOR: "1" }, json: true })).toBe(
    false,
  );
});

test("the progress spinner and the style share one terminal decision", () => {
  for (const env of [{}, { NO_COLOR: "1" }, { TERM: "dumb" }, { CI: "1" }]) {
    for (const stream of [tty, { isTTY: false }]) {
      const progress = createProgress({ stream: { ...stream, write: () => {} }, env });
      expect(progress.mode).toBe(terminalMode({ stream, env }));
    }
  }
});

test("helpers wrap text in SGR codes with color on and return it unchanged off", () => {
  const on = createStyle({ stream: tty, env: {} });
  const off = createStyle({ stream: { isTTY: false }, env: {} });
  const names = [
    "ok",
    "fail",
    "warn",
    "info",
    "dim",
    "bold",
    "accent",
    "diffAdd",
    "diffDel",
    "diffHunk",
    "path",
    "command",
  ] as const;
  for (const name of names) {
    expect(off[name]("text")).toBe("text");
    expect(on[name]("text").startsWith("\x1b[")).toBe(true);
    expect(on[name]("text").endsWith("mtext\x1b[0m")).toBe(true);
    expect(stripAnsi(on[name]("text"))).toBe("text");
  }
  expect(on.ok("x")).toBe("\x1b[32mx\x1b[0m");
  expect(on.fail("x")).toBe("\x1b[1;31mx\x1b[0m");
  expect(on.warn("x")).toBe("\x1b[33mx\x1b[0m");
  expect(on.ok("")).toBe("");
  expect(on.width).toBe(80);
  expect(off.width).toBeUndefined();
});

test("wrap breaks between words with a hanging indent and never mid-word", () => {
  const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";
  const out = wrap(text, 30, 6, 10);
  const lines = out.split("\n");
  expect(lines[0]).toBe("alpha beta gamma");
  for (const line of lines.slice(1)) {
    expect(line.startsWith("      ")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(30);
  }
  expect(out.replace(/\n +/g, " ")).toBe(text);
  expect(wrap(text, undefined, 6)).toBe(text);
});

test("wrap splits only a word wider than a whole line", () => {
  const out = wrap(`see ${"x".repeat(50)} end`, 30, 4);
  for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(30);
  expect(out.replace(/\n +/g, "")).toContain("x".repeat(50));
});

test("colorDiff colors +, -, @@ and headers, dims context; off is identity", () => {
  const diff = "--- a\n+++ b\n@@ -1 +1 @@\n keep\n-old\n+new\n…";
  const on = colorDiff(diff, createStyle({ stream: tty, env: {} })).split("\n");
  expect(on[0]).toBe("\x1b[1m--- a\x1b[0m");
  expect(on[1]).toBe("\x1b[1m+++ b\x1b[0m");
  expect(on[2]).toBe("\x1b[36m@@ -1 +1 @@\x1b[0m");
  expect(on[3]).toBe("\x1b[2m keep\x1b[0m");
  expect(on[4]).toBe("\x1b[31m-old\x1b[0m");
  expect(on[5]).toBe("\x1b[32m+new\x1b[0m");
  expect(on[6]).toBe("\x1b[36m…\x1b[0m");
  expect(colorDiff(diff, createStyle({ stream: { isTTY: false }, env: {} }))).toBe(diff);
});

test("spinner color slides violet to cyan in truecolor, 256-color, or plain cyan", () => {
  expect(spinnerPaint(1800, { COLORTERM: "truecolor" }, "◐")).toBe(
    "\x1b[38;2;170;120;255m◐\x1b[0m",
  );
  expect(spinnerPaint(600, { COLORTERM: "24bit" }, "◐")).toBe("\x1b[38;2;80;200;255m◐\x1b[0m");
  expect(spinnerPaint(600, { TERM: "xterm-256color" }, "◓")).toBe("\x1b[38;5;81m◓\x1b[0m");
  expect(spinnerPaint(600, { TERM: "xterm" }, "◑")).toBe("\x1b[36m◑\x1b[0m");
});

test("spinnerPaint is self-contained, so the helper process can run its source", () => {
  // A fresh context has none of this module's names: a closure would throw.
  const copy = runInNewContext(`(${spinnerPaint.toString()})`, {}) as typeof spinnerPaint;
  for (const env of [{ COLORTERM: "truecolor" }, { TERM: "xterm-256color" }, {}])
    expect(copy(1234, env, "◒")).toBe(spinnerPaint(1234, env, "◒"));
});

test("the `workit: error:` outcome line is red on a color stderr and plain otherwise", async () => {
  const { withFailureLine } = await import("@/packages/workit-cli/src/output");
  const run = async (terminals: { stderr?: { isTTY?: boolean } } | undefined) => {
    const err: string[] = [];
    const io = {
      json: false,
      cwd: "/",
      env: {},
      stdout: () => {},
      stderr: (text: string) => void err.push(text),
      ...(terminals ? { terminals } : {}),
    };
    await withFailureLine(io, "pr merge", async () => 1, "PR not merged");
    return err.at(-1);
  };
  expect(await run(undefined)).toBe("workit: error: PR not merged (failed, exit 1)\n");
  expect(await run({ stderr: { isTTY: false } })).toBe(
    "workit: error: PR not merged (failed, exit 1)\n",
  );
  expect(await run({ stderr: { isTTY: true } })).toBe(
    "\x1b[1;31mworkit: error: PR not merged (failed, exit 1)\x1b[0m\n",
  );
});
