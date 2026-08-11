import { createFlowEvidence, type EvidenceResult } from "@brainervirus/workit-core/src/core/flow-state";

/**
 * Cursor native-question adapter (FG-04): turns an answered AskQuestion result
 * into host-bound evidence. Bare booleans never reach this function — the flow
 * transitions only accept the evidence it produces.
 */
export const cursorQuestionEvidence = (
  questionId: string,
  selectedLabel: string,
  recordedAt?: number,
): EvidenceResult => createFlowEvidence("cursor", questionId, selectedLabel, recordedAt);
