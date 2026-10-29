import { inkColor } from "./ink-style";
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState, type JSX } from "react";

// Single-purpose list control: up/down move the highlight (dispatching the
// value), Enter always submits the highlighted option. This is the WZ-11 fix —
// unlike @inkjs/ui Select there is exactly one Enter path and no competing
// onChange/onSubmit handlers, so Enter can never apply a stale value twice.
export function SelectList<T extends string>({
  options,
  value,
  onChange,
  onSelect,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange?: (value: T) => void;
  onSelect: (value: T) => void;
}): JSX.Element {
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      options.findIndex((option) => option.value === value),
    ),
  );
  // Burst-input mirror (Task 1 advisory): two arrow keys can arrive in one
  // stdin chunk, both handled before React re-renders — a closure-read index
  // would collapse them into one step. The ref is updated synchronously in the
  // handler; this effect only re-syncs after commits so render stays pure
  // (react-doctor no-ref-current-in-render). WZ-13 unchanged: no side effects
  // inside setState updaters; onChange stays a sibling of setIndex.
  const indexRef = useRef(index);
  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  useInput((_input, key) => {
    if (key.downArrow || key.upArrow) {
      const next = key.downArrow
        ? Math.min(indexRef.current + 1, options.length - 1)
        : Math.max(indexRef.current - 1, 0);
      // Boundary clamp: an arrow that cannot move neither re-renders nor
      // re-dispatches the already-current value.
      if (next === indexRef.current) return;
      indexRef.current = next;
      setIndex(next);
      onChange?.(options[next].value);
    } else if (key.return) {
      onSelect(options[indexRef.current].value);
    }
  });

  return (
    <Box flexDirection="column" gap={0}>
      {options.map((option, i) => (
        <Text
          key={option.value}
          color={i === index ? inkColor("accent") : undefined}
          dimColor={i !== index}
        >
          {i === index ? "❯ " : "  "}
          {option.label}
        </Text>
      ))}
    </Box>
  );
}
