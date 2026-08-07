export type Detection = { choices: string[]; pattern: "alpha" | "numeric" } | null;

// Interrogative gate: a literal question mark OR explicit interrogative phrases.
// Plain "I want to confirm..." or "the script which runs" must NOT match.
const INTERROGATIVE = /[?¿]|which\s+one|choose\s+(?:one|between|among)|do\s+you\s+(?:want|prefer)|want\s+me\s+to/i;

export const detectProseChoices = (text: string): Detection => {
  if (!INTERROGATIVE.test(text)) return null;

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  const alphaAll = [...text.matchAll(/([a-dA-D])[.)]\s+([^\n]*?)(?=\s+[a-dA-D][.)]\s|$)/g)]
    .map((m) => ({ letter: m[1].toLowerCase(), choice: m[2].trim() }));
  const alphaLines = lines
    .map((l) => /^([a-dA-D])[.)]\s+(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ letter: m[1].toLowerCase(), choice: m[2] }));
  const alpha = alphaAll.length >= alphaLines.length ? alphaAll : alphaLines;

  if (alpha.length >= 2) {
    const letters = alpha.map((a) => a.letter);
    const expected = ["a", "b", "c", "d"].slice(0, alpha.length);
    if (letters.every((l, i) => l === expected[i])) {
      return { choices: alpha.map((a) => a.choice), pattern: "alpha" };
    }
  }

  const numericAll = [...text.matchAll(/(\d+)[.)]\s+([^\n]*?)(?=\s+\d+[.)]\s|$)/g)]
    .map((m) => ({ num: Number(m[1]), choice: m[2].trim() }));
  const numericLines = lines
    .map((l) => /^(\d+)[.)]\s+(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ num: Number(m[1]), choice: m[2] }));
  const numeric = numericAll.length >= numericLines.length ? numericAll : numericLines;

  if (numeric.length >= 2) {
    const nums = numeric.map((n) => n.num);
    if (nums.every((n, i) => n === i + 1)) {
      return { choices: numeric.map((n) => n.choice), pattern: "numeric" };
    }
  }

  return null;
};
