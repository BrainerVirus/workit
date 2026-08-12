import { PassThrough } from "node:stream";
import { render as inkRender } from "ink";
import React from "react";
import StdinContext from "../../../node_modules/ink/build/components/StdinContext.js";

// Deterministic Ink TTY harness. No real terminal, no timers: frames are the
// written stdout chunks, input is injected synchronously through a fake stdin,
// and renders are flushed with waitUntilRenderFlush (never wall-clock sleeps).
//
// inputListenerCount() reports how many useInput handlers are mounted: it reads
// Ink's internal input EventEmitter (StdinContext exposes it) one microtask
// after the commit, so all mount effects have registered. The wizard is
// expected to hold exactly one screen control + its own nav handler + Ink's
// tab-navigation listener, i.e. a constant count across every screen.

// Strip ANSI escape sequences and control characters from a frame so tests
// assert on the visible text only. A hand-rolled scanner avoids the
// no-control-regex lint rule and keeps unicode glyphs (❯ • —) intact.
function clean(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const code = raw.charCodeAt(i);
    if (code === 0x1b) {
      if (raw[i + 1] === "[") {
        // CSI: ESC [ params intermediates final
        i += 2;
        while (i < raw.length) {
          const c = raw.charCodeAt(i);
          if ((c >= 0x30 && c <= 0x3f) || (c >= 0x20 && c <= 0x2f)) i += 1;
          else break;
        }
        if (i < raw.length) i += 1;
      } else if (raw[i + 1] === "]") {
        // OSC: skip until BEL or ESC backslash
        i += 2;
        while (i < raw.length && raw.charCodeAt(i) !== 0x07) {
          if (raw.charCodeAt(i) === 0x1b && raw[i + 1] === "\\") {
            i += 2;
            break;
          }
          i += 1;
        }
        if (i < raw.length && raw.charCodeAt(i) === 0x07) i += 1;
      } else {
        i += 2;
      }
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      i += 1;
      continue;
    }
    out += raw[i];
    i += 1;
  }
  return out;
}

export type InkTty = {
  lastFrame(): string;
  key(key: string): Promise<void>;
  keys(...keys: string[]): Promise<void>;
  inputListenerCount(): number;
  unmount(): void;
};

function InputListenerProbe({ counts }: { counts: number[] }): null {
  const { internal_eventEmitter } = React.useContext(StdinContext);
  React.useEffect(() => {
    queueMicrotask(() => {
      counts.push(internal_eventEmitter.listenerCount("input"));
    });
  });
  return null;
}

export async function renderInk(
  element: React.ReactElement,
  options: { exitOnCtrlC?: boolean } = {},
): Promise<InkTty> {
  const stdout = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  stdout.isTTY = true;
  stdout.columns = 120;
  stdout.rows = 40;

  const stdin = new PassThrough() as PassThrough & { isTTY: boolean };
  stdin.isTTY = true;
  (stdin as unknown as { ref(): void }).ref = () => {};
  (stdin as unknown as { unref(): void }).unref = () => {};
  (stdin as unknown as { setRawMode(_enabled: boolean): void }).setRawMode = () => {};

  const frames: string[] = [];
  stdout.on("data", (chunk: Buffer) => frames.push(clean(chunk.toString("utf8"))));

  const counts: number[] = [];
  const instance = inkRender(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(InputListenerProbe, { counts }),
      element,
    ),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      interactive: true,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
      exitOnCtrlC: options.exitOnCtrlC ?? true,
    },
  );

  // Let the first commit's effects register the input handlers and the probe
  // push its count before any test asserts on listener counts.
  await instance.waitUntilRenderFlush();
  await new Promise((resolve) => setImmediate(resolve));

  const tty: InkTty = {
    lastFrame() {
      for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i].trim().length > 0) return frames[i];
      }
      return "";
    },
    async key(key: string) {
      stdin.write(key);
      await instance.waitUntilRenderFlush();
      await new Promise((resolve) => setImmediate(resolve));
    },
    async keys(...keysToPress: string[]) {
      for (const key of keysToPress) await this.key(key);
    },
    inputListenerCount() {
      return counts[counts.length - 1] ?? -1;
    },
    unmount: () => instance.unmount(),
  };
  return tty;
}
