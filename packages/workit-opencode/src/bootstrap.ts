import { invariantBootstrap } from "@brainervirus/workit-core/src/core";
const marker = "<workit-contract>";

let cached: string | null | undefined;

export const getWorkitBootstrap = (): string | null => {
  if (cached !== undefined) return cached;
  cached = `${marker}\n${invariantBootstrap()}\nOpenCode Workit decisions use the native question header "Workit decision: <purpose>", the exact presented question, and exactly two options: approved (description = approved content) and rejected (description = Reject this decision).`;
  return cached;
};

export const isWorkitBootstrap = (text: string) => text.includes(marker);
