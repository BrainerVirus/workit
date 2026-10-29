import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { render } from "ink";
import React from "react";
import { SphereSpinner } from "../../packages/workit-cli/src/steps/sphere-spinner";
import { SPINNER_FRAMES } from "../../packages/workit-cli/src/style";

const ESC = String.fromCharCode(27);
const TTY = { isTTY: true, columns: 80 };

// Renders one spinner into a fake stdout and returns the raw output so far.
async function frames(env: NodeJS.ProcessEnv, stream: typeof TTY | { isTTY: false }) {
  const stdout = new PassThrough();
  const chunks: string[] = [];
  stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  const instance = render(<SphereSpinner label="Installing hosts" stream={stream} env={env} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  instance.unmount();
  return chunks.join("");
}

test("a waiting step renders a sphere frame, its label and the elapsed seconds in color", async () => {
  const out = await frames({ COLORTERM: "truecolor" }, TTY);
  expect(SPINNER_FRAMES.some((frame) => out.includes(frame))).toBe(true);
  expect(out).toContain("Installing hosts (0s)");
  expect(out).toContain(`${ESC}[38;2;`);
});

test("NO_COLOR keeps the sphere and label with no color codes", async () => {
  const out = await frames({ NO_COLOR: "1" }, TTY);
  expect(SPINNER_FRAMES.some((frame) => out.includes(frame))).toBe(true);
  expect(out).toContain("Installing hosts");
  expect(out).not.toContain(ESC);
});

test("a non-TTY stream renders a static label without a sphere", async () => {
  const out = await frames({}, { isTTY: false });
  expect(out).toContain("Installing hosts…");
  expect(SPINNER_FRAMES.some((frame) => out.includes(frame))).toBe(false);
  expect(out).not.toContain(ESC);
});

test("TERM=dumb renders ASCII without color", async () => {
  const out = await frames({ TERM: "dumb" }, TTY);
  expect(out).toContain("... Installing hosts");
  expect(SPINNER_FRAMES.some((frame) => out.includes(frame))).toBe(false);
  expect(out).not.toContain(ESC);
});
