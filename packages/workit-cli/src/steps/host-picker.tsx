import { inkColor } from "./ink-style";
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState, type JSX } from "react";
import type { HostDetection, HostId } from "../admin/detect-hosts";
import { PLATFORM_LABELS } from "./options";

// Controlled: the parent owns the selection and gets every change through
// onChange. chosenRef mirrors it so a burst of keys in one stdin chunk toggles
// against the latest selection, not the last rendered one.
export function HostPicker({
  detection,
  selected,
  onChange,
  onSubmit,
}: {
  detection: Record<HostId, HostDetection>;
  selected: string[];
  onChange: (selected: string[]) => void;
  onSubmit: (selected: string[]) => void;
}): JSX.Element {
  const available = PLATFORM_LABELS.filter(({ value }) => detection[value].detected).map(
    ({ value }) => value,
  );
  const options = [
    { label: "Select all available", value: "__all" },
    { label: "Clear all", value: "__none" },
    ...PLATFORM_LABELS.map(({ label, value }) => ({ label, value })),
  ];
  const [index, setIndex] = useState(0);
  const indexRef = useRef(index);
  const chosenRef = useRef(selected);
  useEffect(() => {
    indexRef.current = index;
  }, [index]);
  useEffect(() => {
    chosenRef.current = selected;
  }, [selected]);
  const update = (next: string[]) => {
    chosenRef.current = next;
    onChange(next);
  };
  const checkedHosts = new Set(selected);
  useInput((input, key) => {
    if (key.upArrow || key.downArrow) {
      const next = Math.max(
        0,
        Math.min(options.length - 1, indexRef.current + (key.downArrow ? 1 : -1)),
      );
      indexRef.current = next;
      setIndex(next);
      return;
    }
    if (input === " ") {
      const option = options[indexRef.current];
      if (option.value === "__all") update([...available]);
      else if (option.value === "__none") update([]);
      else if (detection[option.value as HostId].detected) {
        const next = chosenRef.current.includes(option.value)
          ? chosenRef.current.filter((host) => host !== option.value)
          : [...chosenRef.current, option.value];
        update(next);
      }
    } else if (key.return) {
      const option = options[indexRef.current];
      if (option.value === "__all") update([...available]);
      else if (option.value === "__none") update([]);
      onSubmit(chosenRef.current);
    }
  });
  return (
    <Box flexDirection="column" gap={0}>
      {options.map((option, row) => {
        const host =
          option.value === "__all" || option.value === "__none" ? null : (option.value as HostId);
        const detected = host === null || detection[host].detected;
        const checked = host !== null && checkedHosts.has(host);
        const label =
          host === null
            ? option.label
            : `${checked ? "[✓]" : "[ ]"} ${option.label}${detection[host].configured ? " · already configured" : detection[host].detected ? " · detected" : " · unavailable"}`;
        return (
          <Text
            key={option.value}
            color={row === index ? inkColor("accent") : undefined}
            dimColor={!detected}
          >
            {row === index ? "❯ " : "  "}
            {label}
          </Text>
        );
      })}
    </Box>
  );
}
