// The read side of the authority seal (#819). A hook predicts writes from the
// command text, so a program that computes the path at run time can still
// rewrite workspaces.json. The seal is checked when authority is read, however
// the file was written: `<account config dir>/workspaces.json.seal` holds the
// digest of the authority fields of every entry, and the last sealed values
// themselves. Only the user's terminal writes it (`workit workspace seal`).
// Threat model (D18): a writer who also forges the seal passes it; the
// storage is one file so a principal outside the agent's OS user (#815) can
// own it later.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  readWorkspacesResult,
  validateWorkspacesDocument,
  type WorkspaceConfig,
} from "./workspaces";

export const SEAL_FILE = "workspaces.json.seal";
const SEAL_VERSION = 1;
/** The terminal command that accepts the current authority fields. */
export const SEAL_COMMAND = "workit workspace seal";

type Seal = {
  version: number;
  sha256: string;
  projection: unknown[];
  sealedAt: string;
};

const pick = (value: unknown, keys: readonly string[]): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out = Object.fromEntries(
    keys.flatMap((key) => {
      const item = (value as Record<string, unknown>)[key];
      return item === undefined ? [] : [[key, item]];
    }),
  );
  return Object.keys(out).length > 0 ? out : undefined;
};

const ENTRY_KEYS = [
  "name",
  "glob",
  "remotes",
  "vcs",
  "autonomy",
  "autoApprove",
  "defaultEndpoint",
  "verification",
  "youtrack",
] as const;

/**
 * The authority fields of every entry, in entry order: name, glob, remotes,
 * vcs.account and vcs.provider, autonomy, legacy autoApprove, defaultEndpoint,
 * verification and youtrack.writes. Roles, branch policy, checks and the rest
 * stay outside, so changing them keeps the seal valid.
 */
export const sealProjection = (entries: readonly unknown[]): Record<string, unknown>[] =>
  entries.map((entry) => {
    const all = pick(entry, ENTRY_KEYS) ?? {};
    return pick(
      {
        ...all,
        vcs: pick(all.vcs, ["provider", "account"]),
        youtrack: pick(all.youtrack, ["writes"]),
      },
      ENTRY_KEYS,
    )!;
  });

/** JSON with every object's keys sorted, so equal values hash equally. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );

export const sealDigest = (projection: readonly unknown[]): string =>
  createHash("sha256").update(canonical(projection)).digest("hex");

/** The seal file's content for `entries` (the terminal writer stores it). */
export const sealDocument = (entries: readonly unknown[], sealedAt: Date): Seal => {
  const projection = sealProjection(entries);
  return {
    version: SEAL_VERSION,
    sha256: sealDigest(projection),
    projection,
    sealedAt: sealedAt.toISOString(),
  };
};

/**
 * `none`: no seal file, nothing changes. `valid`: the authority fields match.
 * `broken`: they do not, or the seal cannot be read; `sealed` holds the last
 * sealed entries when the seal itself is intact, null otherwise.
 */
export type SealCheck =
  | { state: "none" | "valid" }
  | { state: "broken"; reason: string; sealed: WorkspaceConfig[] | null };

const broken = (reason: string, sealed: WorkspaceConfig[] | null = null): SealCheck => ({
  state: "broken",
  reason,
  sealed,
});

/** Compare `<dir>/workspaces.json` with `<dir>/workspaces.json.seal`. */
export function checkSeal(dir: string): SealCheck {
  const file = path.join(dir, SEAL_FILE);
  let seal: Partial<Seal>;
  try {
    seal = JSON.parse(readFileSync(file, "utf8")) as Partial<Seal>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "none" };
    return broken(`${SEAL_FILE} cannot be read`);
  }
  if (
    seal?.version !== SEAL_VERSION ||
    !Array.isArray(seal.projection) ||
    seal.sha256 !== sealDigest(seal.projection)
  )
    return broken(`${SEAL_FILE} is malformed`);
  const sealed = validateWorkspacesDocument({ workspaces: seal.projection }, file);
  if (sealed.status !== "valid") return broken(`${SEAL_FILE} is malformed`);
  const current = readWorkspacesResult(dir);
  const ok = current.status === "valid" || current.status === "missing";
  return ok && sealDigest(sealProjection(current.entries)) === seal.sha256
    ? { state: "valid" }
    : broken("workspaces.json changed since it was sealed", sealed.entries);
}
