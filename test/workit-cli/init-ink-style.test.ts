import { expect, test } from "bun:test";
import { inkColor } from "../../packages/workit-cli/src/steps/ink-style";

const tty = { isTTY: true, columns: 80 };

test("ink roles map to the style.ts semantic colors on a color terminal", () => {
  const options = { stream: tty, env: {} };
  expect([
    inkColor("ok", options),
    inkColor("fail", options),
    inkColor("warn", options),
    inkColor("accent", options),
  ]).toEqual(["green", "red", "yellow", "cyan"]);
});

test("NO_COLOR, CI and a pipe keep ink text plain", () => {
  for (const options of [
    { stream: tty, env: { NO_COLOR: "1" } },
    { stream: tty, env: { CI: "true" } },
    { stream: { isTTY: false }, env: {} },
  ]) {
    expect(inkColor("ok", options)).toBeUndefined();
  }
});
