const rejectedDescription = "Reject this decision";

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
