import { readFileSync } from "node:fs";
import path from "node:path";

import { EVENT, errorDetail } from "@brainervirus/workit-core/src/core/boundary";
import type { Logger } from "@brainervirus/workit-core/src/core/logger";

export const loadProvenance = (logger: Logger, pkgUrl: string | URL): Record<string, string> => {
  try {
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { name?: string; version?: string };
    return {
      name: String(pkg.name ?? "workit-opencode"),
      version: String(pkg.version ?? "unknown"),
    };
  } catch (err) {
    logger.warn(EVENT.provenance, errorDetail(err));
    return { name: "workit-opencode", version: "unknown" };
  }
};

export const loadCommandTemplates = (
  logger: Logger,
  rootDir: string,
  names: string[],
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of names) {
    try {
      out[name] = readFileSync(path.join(rootDir, "commands", `${name}.md`), "utf8").trim();
    } catch (err) {
      logger.warn(EVENT.assets, { component: "command", name, ...errorDetail(err) });
    }
  }
  return out;
};

export const reportUncaught = (logger: Logger, phase: string, reason: unknown): void => {
  logger.error(EVENT.uncaughtFailure, { phase, ...errorDetail(reason) });
};
