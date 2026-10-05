import { invariantBootstrap } from "@brainervirus/workit-core/src/core";
const marker = "<workit-contract>";

let cached: string | null | undefined;

export const getWorkitBootstrap = (): string | null => {
  if (cached !== undefined) return cached;
  cached = `${marker}\n${invariantBootstrap()}\nOn OpenCode, use native host tools for external mutations; workit_context is read-only and there is no managed external-action executor. Record a meaningful user choice with workit_decision directly; it needs no question.`;
  return cached;
};
