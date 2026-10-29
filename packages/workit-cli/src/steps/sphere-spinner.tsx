import { Text } from "ink";
import { useEffect, useState, type JSX } from "react";
import {
  SPINNER_FRAMES,
  SPINNER_FRAME_MS,
  spinnerPaint,
  terminalMode,
  type TerminalStream,
} from "../style";

// The wizard's wait indicator: the same sphere, violet-cyan slide, label and
// elapsed seconds the verbs draw through progress.ts, rendered as an Ink
// element. Frames and colors come from style.ts, not a second implementation.
// Only animate work that yields to the event loop: a synchronous call freezes
// every timer, so blocking steps belong to progress.runSync's helper process.
export function SphereSpinner({
  label,
  stream = process.stdout,
  env = process.env,
  now = Date.now,
}: {
  label: string;
  stream?: TerminalStream;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): JSX.Element {
  const mode = terminalMode({ stream, env });
  const [began] = useState(now);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (mode === "off") return;
    const timer = setInterval(() => setTick((n) => n + 1), SPINNER_FRAME_MS);
    return () => clearInterval(timer);
  }, [mode]);
  if (mode === "off") return <Text>{label}…</Text>;
  const elapsed = now() - began;
  const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? "";
  const glyph = mode === "spinner" ? spinnerPaint(elapsed, env, frame) : frame;
  const shown = env.TERM === "dumb" ? "..." : glyph;
  return (
    <Text>
      {shown} {label} ({Math.floor(elapsed / 1000)}s)
    </Text>
  );
}
