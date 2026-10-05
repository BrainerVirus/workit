import { invariantBootstrap } from "@brainervirus/workit-core/src/core";
const marker = "<workit-contract>";

let cached: string | null | undefined;

export const getWorkitBootstrap = (): string | null => {
  if (cached !== undefined) return cached;
  cached = `${marker}\n${invariantBootstrap()}\nOn OpenCode, run external mutations with native host tools or the workit CLI; workit_context is read-only and there is no managed external-action executor, so do not create proposals or request Workit approvals merely to invoke native tools.\nOpenCode Workit decisions use the native question header "Workit decision: <purpose>", the exact presented question, and exactly two options: approved (description = approved content) and rejected (description = Reject this decision).`;
  return cached;
};
