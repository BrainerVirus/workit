import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import { useMemo, useState, type JSX } from "react";

// Teams-style language × nationality rows → BCP-47 tag. Includes every core
// localeOptions default (en, es-CL, es-MX, es-AR, pt-BR). The Español block
// leads so the 5-row cap keeps the whole language family visible together for
// the shared "es" prefix.
export const LOCALE_LANGUAGE_MAP: { label: string; locale: string }[] = [
  { label: "Español (España)", locale: "es-ES" },
  { label: "Español (Latinoamérica)", locale: "es-419" },
  { label: "Español (Chile)", locale: "es-CL" },
  { label: "Español (México)", locale: "es-MX" },
  { label: "Español (Argentina)", locale: "es-AR" },
  { label: "English", locale: "en" },
  { label: "English (United States)", locale: "en-US" },
  { label: "English (United Kingdom)", locale: "en-GB" },
  { label: "Português (Brasil)", locale: "pt-BR" },
  { label: "Português (Portugal)", locale: "pt-PT" },
  { label: "Français (France)", locale: "fr-FR" },
  { label: "Français (Canada)", locale: "fr-CA" },
  { label: "Deutsch (Deutschland)", locale: "de-DE" },
  { label: "中文（简体）", locale: "zh-CN" },
  { label: "中文（繁體）", locale: "zh-TW" },
  { label: "日本語", locale: "ja-JP" },
  { label: "한국어", locale: "ko-KR" },
  { label: "Italiano", locale: "it-IT" },
  { label: "Русский", locale: "ru-RU" },
  { label: "العربية", locale: "ar-SA" },
  { label: "हिन्दी", locale: "hi-IN" },
  { label: "Nederlands (Nederland)", locale: "nl-NL" },
  { label: "Polski (Polska)", locale: "pl-PL" },
  { label: "Türkçe (Türkiye)", locale: "tr-TR" },
  { label: "Svenska (Sverige)", locale: "sv-SE" },
];

const VISIBLE_ROWS = 5;

// Case-insensitive substring over label or value; capped at the visible rows
// the component renders. Pure — unit-tested without Ink.
export function filterOptions<T extends string>(
  options: { label: string; value: T }[],
  query: string,
  limit: number = VISIBLE_ROWS,
): { label: string; value: T }[] {
  const q = query.trim().toLowerCase();
  if (!q) return options.slice(0, limit);
  return options
    .filter(
      (option) => option.label.toLowerCase().includes(q) || option.value.toLowerCase().includes(q),
    )
    .slice(0, limit);
}

// Searchable list control (@inkjs/ui has no Autocomplete): typing filters the
// rows, up/down move within the filtered set, Enter selects the highlighted
// row. Esc is deliberately unhandled so it bubbles to the screen's cancel/back
// handling. The query is owned here — an uncontrolled TextInput notifies via a
// post-paint effect, which lags the filtered list one frame behind the visible
// text — so the TextInput below is a keyed, disabled display of that state and
// all input handling lives in this one hook. Like SelectList (WZ-13), arrow
// state changes never dispatch from inside a setState updater and nothing
// commits until Enter.
export function SearchSelect<T extends string>({
  options,
  value,
  placeholder,
  onSelect,
}: {
  options: { label: string; value: T }[];
  value?: T;
  placeholder?: string;
  onSelect: (value: T) => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterOptions(options, query), [options, query]);
  const [rawIndex, setRawIndex] = useState(() =>
    Math.max(
      0,
      options.findIndex((option) => option.value === value),
    ),
  );
  // Clamped highlight: narrowing can never leave it pointing past the last row.
  const index = Math.min(rawIndex, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    // A query change resets the highlight to the top of the filtered set.
    const type = (next: string): void => {
      setQuery(next);
      setRawIndex(0);
    };
    if (key.downArrow) {
      setRawIndex(Math.min(index + 1, filtered.length - 1));
    } else if (key.upArrow) {
      setRawIndex(Math.max(index - 1, 0));
    } else if (key.return) {
      if (filtered[index]) onSelect(filtered[index].value);
    } else if (key.backspace || key.delete) {
      type(query.slice(0, Math.max(0, query.length - 1)));
    } else if (input && !key.ctrl && !key.meta && !key.escape && !key.tab) {
      type(query + input);
    }
  });

  return (
    <Box flexDirection="column" gap={0}>
      <TextInput key={query} isDisabled defaultValue={query} placeholder={placeholder} />
      {filtered.length === 0 ? (
        <Text dimColor>No matching language</Text>
      ) : (
        filtered.map((option, i) => (
          <Text key={option.value} color={i === index ? "cyan" : "dim"}>
            {i === index ? "❯ " : "  "}
            {option.label}
          </Text>
        ))
      )}
    </Box>
  );
}
