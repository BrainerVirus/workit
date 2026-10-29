// Terminal styling for human output: semantic ANSI helpers, word wrapping and
// unified-diff coloring. One place decides interactive output (`terminalMode`),
// shared with the progress spinner: color only on a TTY, never under --json,
// CI, NO_COLOR or TERM=dumb, unless FORCE_COLOR asks for it. With color off
// every helper returns its input unchanged, so pipes, CI logs and agent hosts
// stay byte-identical. Dependency-free.

import { stripVTControlCharacters } from "node:util";

export type TerminalStream = { isTTY?: boolean; columns?: number };
type TerminalMode = "spinner" | "plain" | "off";
export type StyleOptions = { stream?: TerminalStream; env?: NodeJS.ProcessEnv; json?: boolean };

const truthy = (value: string | undefined): boolean =>
  value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";

/** off: no decoration at all; plain: a TTY without color; spinner: a color TTY. */
export const terminalMode = (options: StyleOptions): TerminalMode => {
  const env = options.env ?? process.env;
  if (options.json || !options.stream?.isTTY || truthy(env.CI)) return "off";
  if (truthy(env.NO_COLOR) || env.TERM === "dumb") return "plain";
  return "spinner";
};

/**
 * Color on for a color TTY. FORCE_COLOR forces it on any real stream (a pipe)
 * but never under --json, nor without a stream (a capture or a test fake).
 */
export const colorEnabled = (options: StyleOptions): boolean => {
  if (options.json || !options.stream) return false;
  if (truthy((options.env ?? process.env).FORCE_COLOR)) return true;
  return terminalMode(options) === "spinner";
};

type Paint = (text: string) => string;
export type Style = {
  readonly enabled: boolean;
  /** Wrap width for human text: the TTY's columns when styled, else none. */
  readonly width: number | undefined;
  ok: Paint;
  fail: Paint;
  warn: Paint;
  info: Paint;
  dim: Paint;
  bold: Paint;
  accent: Paint;
  diffAdd: Paint;
  diffDel: Paint;
  diffHunk: Paint;
  path: Paint;
  command: Paint;
};

const sgr =
  (open: string): Paint =>
  (text) =>
    text === "" ? text : `\x1b[${open}m${text}\x1b[0m`;
const same: Paint = (text) => text;

export function createStyle(options: StyleOptions = {}): Style {
  const enabled = colorEnabled(options);
  const pick = (open: string): Paint => (enabled ? sgr(open) : same);
  return {
    enabled,
    width: enabled ? options.stream?.columns || undefined : undefined,
    ok: pick("32"),
    fail: pick("1;31"),
    warn: pick("33"),
    info: pick("2"),
    dim: pick("2"),
    bold: pick("1"),
    accent: pick("36"),
    diffAdd: pick("32"),
    diffDel: pick("31"),
    diffHunk: pick("36"),
    path: pick("2"),
    command: pick("1;36"),
  };
}

const visibleLength = (text: string): number => Array.from(stripVTControlCharacters(text)).length;

/**
 * Word-wrap `text` to `width` columns: the first line starts after `lead`
 * (already printed, `firstUsed` columns wide), the rest hang under `indent`.
 * Never splits a word unless the word alone is wider than a line.
 */
export function wrap(
  text: string,
  width: number | undefined,
  indent: number,
  firstUsed = indent,
): string {
  if (!width || width <= indent + 10) return text;
  const lines: string[] = [];
  let line = "";
  let room = width - firstUsed;
  const place = (word: string) => {
    let rest = word;
    // A word longer than a whole line: break it, nothing better exists.
    while (visibleLength(rest) > room) {
      const chars = Array.from(rest);
      lines.push(chars.slice(0, room).join(""));
      rest = chars.slice(room).join("");
      room = width - indent;
    }
    line = rest;
  };
  for (const word of text.split(/ +/)) {
    if (word === "") continue;
    if (line === "") place(word);
    else if (visibleLength(line) + 1 + visibleLength(word) <= room) line = `${line} ${word}`;
    else {
      lines.push(line);
      room = width - indent;
      place(word);
    }
  }
  lines.push(line);
  return lines.join(`\n${" ".repeat(indent)}`);
}

/** Color a unified diff: +/- lines, @@ and … markers, file headers, dim context. */
export function colorDiff(text: string, style: Style): string {
  if (!style.enabled) return text;
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return style.bold(line);
      if (line.startsWith("+")) return style.diffAdd(line);
      if (line.startsWith("-")) return style.diffDel(line);
      if (line.startsWith("@@") || line.trim() === "…" || line.trim() === "...")
        return style.diffHunk(line);
      return style.dim(line);
    })
    .join("\n");
}

// The spinner's shaded sphere and its violet-to-cyan color slide.
export const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];
export const SPINNER_FRAME_MS = 140;

/**
 * Paint one spinner frame `elapsed` ms in: a ~2.4 s slide between violet
 * (170,120,255) and cyan (80,200,255), truecolor when COLORTERM says so, else
 * the nearest 256-color, else plain cyan. Self-contained (no outer names): the
 * progress helper process runs its source text too.
 */
export function spinnerPaint(
  elapsed: number,
  env: Record<string, string | undefined>,
  glyph: string,
): string {
  const k = (Math.sin((elapsed / 2400) * Math.PI * 2) + 1) / 2;
  const [r, g, b] = [
    [170, 80],
    [120, 200],
    [255, 255],
  ].map(([from, to]) => Math.round(from + (to - from) * k));
  const depth = (env.COLORTERM || "").toLowerCase();
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  const code =
    depth === "truecolor" || depth === "24bit"
      ? `38;2;${r};${g};${b}`
      : /256/.test(env.TERM || "")
        ? `38;5;${16 + 36 * level(r) + 6 * level(g) + level(b)}`
        : "36";
  return `\x1b[${code}m${glyph}\x1b[0m`;
}
