import { TextInput } from "@inkjs/ui";
import { useCallback, useLayoutEffect, useRef, type ComponentProps, type JSX } from "react";
import { colorEnabled, type StyleOptions } from "../style";

// Ink screens speak the same semantic roles as style.ts (ok / fail / warn /
// accent), mapped once to Ink color props. With color off (NO_COLOR, a pipe,
// CI, TERM=dumb) every role resolves to undefined, so the Text stays plain.
const INK_COLORS = {
  ok: "green",
  fail: "red",
  warn: "yellow",
  accent: "cyan",
} as const;
export type InkRole = keyof typeof INK_COLORS;

export function inkColor(
  role: InkRole,
  options: StyleOptions = { stream: process.stdout, env: process.env },
): (typeof INK_COLORS)[InkRole] | undefined {
  return colorEnabled(options) ? INK_COLORS[role] : undefined;
}

type TextInputProps = ComponentProps<typeof TextInput>;

// @inkjs/ui re-runs its onChange effect whenever the onChange identity changes
// while the typed value differs from its internal previous value, which is
// always after the first keystroke. An inline handler that dispatches into
// parent state is a new function every render, so every dispatch re-rendered,
// re-fired the effect and looped ("Maximum update depth exceeded"). Handing it
// one stable callback that reads the latest handler from a ref breaks the loop.
export function StableTextInput({ onChange, ...rest }: TextInputProps): JSX.Element {
  const latest = useRef(onChange);
  useLayoutEffect(() => {
    latest.current = onChange;
  }, [onChange]);
  const stable = useCallback((value: string) => latest.current?.(value), []);
  return <TextInput {...rest} onChange={onChange ? stable : undefined} />;
}
