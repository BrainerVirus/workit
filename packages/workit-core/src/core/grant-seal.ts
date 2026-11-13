// The read side of the authority seal (#819). A hook predicts writes from the
// command text, so a program that computes the path at run time can still
// rewrite workspaces.json. The seal is checked when authority is read, however
// the file was written: `<account config dir>/workspaces.json.seal` holds the
// digest of the authority fields of every entry, and the last sealed values
// themselves. The user's terminal writes it (`workit workspace seal`); a
// writer reseals only where autonomy.ts sealAfterWrite allows. A missing seal
// counts as the D4 defaults sealed.
// Threat model (D18): a writer who also forges the seal passes it; the
// storage is one file so a principal outside the agent's OS user (#815) can
// own it later.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./safe-write";
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
 * The forge identity of an entry (provider, account, tokenFile, host): a
 * sealed grant rides on it, so it is authority too.
 */
export const IDENTITY_KEYS = ["provider", "account", "tokenFile", "host"] as const;

/**
 * The authority fields of every entry, in entry order: name, glob, remotes,
 * the forge identity (vcs.provider, account, tokenFile, host), autonomy, legacy autoApprove, defaultEndpoint,
 * verification and youtrack.writes. Roles, branch policy, checks and the rest
 * stay outside, so changing them keeps the seal valid.
 */
export const sealProjection = (entries: readonly unknown[]): Record<string, unknown>[] =>
  entries.map((entry) => {
    const all = pick(entry, ENTRY_KEYS) ?? {};
    return pick(
      {
        ...all,
        vcs: pick(all.vcs, IDENTITY_KEYS),
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

/** One comparable string for an entry's forge identity (IDENTITY_KEYS of its vcs). */
export const identityOf = (vcs: unknown): string => canonical(pick(vcs, IDENTITY_KEYS) ?? {});

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

/** The projection the seal holds, or null when there is no readable, intact seal. */
export function sealedProjection(dir: string): Record<string, unknown>[] | null {
  try {
    const seal = JSON.parse(readFileSync(path.join(dir, SEAL_FILE), "utf8")) as Partial<Seal>;
    return seal?.version === SEAL_VERSION &&
      Array.isArray(seal.projection) &&
      seal.sha256 === sealDigest(seal.projection)
      ? (seal.projection as Record<string, unknown>[])
      : null;
  } catch {
    return null;
  }
}

/**
 * Seal the authority fields of `<dir>/workspaces.json` as it is now (the
 * user's terminal, or a writer whose change only lowers the sealed values).
 */
export function writeSeal(dir: string, entries: readonly unknown[], now = new Date()): string {
  const file = path.join(dir, SEAL_FILE);
  writeFileAtomic(file, `${JSON.stringify(sealDocument(entries, now), null, 2)}\n`);
  return file;
}

const show = (value: unknown): string => (value === undefined ? "(unset)" : canonical(value));

/**
 * What sealing would accept, one line per change: every authority field of
 * every entry when nothing is sealed yet, else what was added, removed or
 * changed since the seal (entry order counts: the first match wins a tie).
 */
export function sealDiffLines(
  sealed: readonly Record<string, unknown>[] | null,
  current: readonly unknown[],
): string[] {
  const now = sealProjection(current);
  const label = (entry: Record<string, unknown>, at: number) =>
    typeof entry.name === "string" ? entry.name : `#${at + 1}`;
  const fields = (entry: Record<string, unknown>) =>
    ENTRY_KEYS.filter((key) => key !== "name" && entry[key] !== undefined).map(
      (key) => `${key}=${show(entry[key])}`,
    );
  if (sealed === null)
    return now.length
      ? now.map((entry, at) => `+ ${label(entry, at)}: ${fields(entry).join(", ")}`)
      : ["(no workspace entries: nothing above the defaults)"];
  const lines: string[] = [];
  const byName = (list: readonly Record<string, unknown>[]) =>
    new Map(list.map((entry, at) => [label(entry, at), entry]));
  const before = byName(sealed);
  const after = byName(now);
  for (const [name, entry] of after) {
    const old = before.get(name);
    if (!old) {
      lines.push(`+ ${name}: ${fields(entry).join(", ")}`);
      continue;
    }
    for (const key of ENTRY_KEYS)
      if (key !== "name" && show(old[key]) !== show(entry[key]))
        lines.push(`~ ${name}.${key}: ${show(old[key])} -> ${show(entry[key])}`);
  }
  for (const name of before.keys()) if (!after.has(name)) lines.push(`- ${name}`);
  const order = (list: Map<string, unknown>) => [...list.keys()].join("\0");
  if (lines.length === 0 && order(before) !== order(after)) lines.push("~ entry order changed");
  return lines;
}
