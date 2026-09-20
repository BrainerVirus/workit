export const rejectedDescription = "Reject this decision";

/**
 * The exact binding-question content a Workit decision receipt is minted
 * against: header, presented question, and the two canonical options. Shared
 * by every host so the semantic recognizer mints identical receipts.
 */
export const decisionContent = (
  purpose: "design" | "action" | "limitation" | "preference",
  question: string,
  approvedContent: string,
) => ({
  header: `Workit decision: ${purpose}`,
  question,
  options: [
    { label: "approved", description: approvedContent },
    { label: "rejected", description: rejectedDescription },
  ],
});

/**
 * Concise approval text always needs a live proposal to bind it; an exact
 * descriptor, plan list, or bare operation binds its own bytes.
 */
export const isSelfAuthorizingActionContent = (content: string): boolean => {
  try {
    const value = JSON.parse(content) as { operation?: unknown };
    return typeof value.operation === "string" && value.operation.length > 0;
  } catch {
    return /^[a-z][a-z_]*\.[a-z_]+$/.test(content);
  }
};
