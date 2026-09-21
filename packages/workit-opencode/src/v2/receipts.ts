/** V2 question results deliver answers through `result.metadata.answers`; V1
 * observed `[[label]]`. Normalize the observed shapes to the single-selection
 * shape the shared semantic recognizer consumes, and pass anything ambiguous
 * through untouched so no receipt is minted for it. */
export const normalizeQuestionAnswers = (answers: unknown): unknown => {
  const singleValue = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value : null;
  if (answers === null || typeof answers !== "object") return answers;
  if (Array.isArray(answers)) {
    if (answers.length === 0) return answers;
    const first = answers[0];
    const direct = singleValue(first);
    if (direct) return [[direct]];
    if (Array.isArray(first)) {
      if (first.length !== 1) return answers;
      const only = singleValue(first[0]);
      return only ? [[only]] : answers;
    }
    if (first && typeof first === "object") {
      const values = Object.values(first as Record<string, unknown>);
      if (values.length > 0 && values.every((entry) => singleValue(entry) !== null))
        return [[singleValue(values[0])]];
    }
    return answers;
  }
  const values = Object.values(answers as Record<string, unknown>);
  if (values.length > 0 && values.every((entry) => singleValue(entry) !== null))
    return [[singleValue(values[0])]];
  return answers;
};
