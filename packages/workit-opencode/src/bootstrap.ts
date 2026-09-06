import { readFileSync } from "node:fs";
import path from "node:path";
import { invariantBootstrap } from "@brainervirus/workit-core/src/core";
const marker = "<workit-contract>";

let cached: string | null | undefined;

export const loadWorkitBootstrap = (rootDir: string): string | null => {
  const contractPath = path.join(rootDir, "templates", "superpowers-doc-contract.md");
  try {
    return readFileSync(contractPath, "utf8");
  } catch {
    return null;
  }
};

export const getWorkitBootstrap = (): string | null => {
  if (cached !== undefined) return cached;
  cached = `${marker}\n${invariantBootstrap()}`;
  return cached;
};

export const isWorkitBootstrap = (text: string) => text.includes(marker);
