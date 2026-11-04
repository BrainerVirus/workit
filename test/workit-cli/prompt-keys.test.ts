import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { confirmKey, isPromptAbort, selectKey } from "@/packages/workit-cli/src/prompt";

// The single-key prompts (#656): driven through fake streams, as a TTY would.

const streams = () => {
  const input = Object.assign(new PassThrough(), { setRawMode: () => undefined });
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => void (written += String(chunk)));
  return { input, output, written: () => written };
};
const press = (input: PassThrough, ...keys: string[]) => {
  for (const key of keys) input.write(key);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("confirmKey: y proceeds without Enter", async () => {
  const s = streams();
  const answer = confirmKey("Remove?", s);
  press(s.input, "y");
  expect(await answer).toBe(true);
  expect(s.written()).toContain("Remove? [y/N] ");
});

test("confirmKey: Enter or n declines (default No)", async () => {
  for (const key of ["\r", "n", "N"]) {
    const s = streams();
    const answer = confirmKey("Remove?", s);
    press(s.input, key);
    expect(await answer).toBe(false);
  }
});

test("confirmKey: any other key is ignored until y, n or Enter", async () => {
  const s = streams();
  let done: boolean | undefined;
  const answer = confirmKey("Remove?", s).then((value) => (done = value));
  press(s.input, "x", " ", "\x1b[A", "1");
  await settle();
  expect(done).toBeUndefined();
  press(s.input, "y");
  await answer;
  expect(done).toBe(true);
});

test("confirmKey: Ctrl+C rejects with the abort askOrCancel recognizes", async () => {
  const s = streams();
  const answer = confirmKey("Remove?", s);
  press(s.input, "\x03");
  const error = await answer.catch((caught) => caught);
  expect(isPromptAbort(error)).toBe(true);
});

test("selectKey: arrows move, Enter picks, and the list wraps", async () => {
  const s = streams();
  const picked = selectKey("Which?", ["a", "b", "c"], s);
  press(s.input, "\x1b[B", "\x1b[B", "\x1b[B", "\x1b[B", "\r");
  expect(await picked).toBe(1);
  expect(s.written()).toContain("> b");
});

test("selectKey: a digit jumps and Ctrl+D cancels", async () => {
  const s = streams();
  const picked = selectKey("Which?", ["a", "b", "c"], s);
  press(s.input, "3", "\r");
  expect(await picked).toBe(2);
  const t = streams();
  const cancelled = selectKey("Which?", ["a", "b", "c"], t);
  press(t.input, "\x04");
  expect(isPromptAbort(await cancelled.catch((caught) => caught))).toBe(true);
});
