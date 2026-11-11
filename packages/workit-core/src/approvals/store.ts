// The host-approval registry (docs/workit-next/host-approval.md): requests a
// Workit verb writes when an action needs the user's yes, the grants host-side
// code records for them, and the one-time consumption a verb makes right
// before its side effect. One registry in the user state dir, so one
// `workit approve` covers several repos:
//
//   <state>/approvals/requests/<id>.json   what the user is asked
//   <state>/approvals/asked/<key>.json     a host ask on one tool call (Claude Code)
//   <state>/approvals/grants/<id>.json     the recorded yes, 15 minutes
//   <state>/approvals/consumed/<id>.json   created once, exclusively
//   <state>/approvals/rejected/<id>.json   a no (or Edit) where the host reports one (Pi)
//
// The write gate denies an agent's edit or shell write under approvals/
// (hooks/write-gate.ts). Like that guard, this stops honest mistakes and
// accidental self-approval, not a determined agent (D18).
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../core/logger";
import { writeFileAtomic, writeFileExclusive } from "../core/safe-write";
import { canonicalJson } from "../core/task-contract";

export const APPROVAL_KINDS = [
  "release-notes",
  "spawn-model",
  "first-push",
  "config",
  "force-push",
  "live-session",
  "discard-work",
  "secrets",
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** A request lives 30 minutes; a grant 15 minutes after the yes (spec decision 2). */
export const REQUEST_TTL_MS = 30 * 60_000;
export const GRANT_TTL_MS = 15 * 60_000;

/** What the yes binds to; `hash` covers exactly these five fields. */
export type ApprovalFields = {
  kind: ApprovalKind;
  /** The verb or call as the user reads it: `workit git push --release 4.5.0`. */
  action: string;
  /** Repo (realpath of the git common dir), branch or version, remote URL. */
  target: Record<string, string>;
  /** One sentence on what happens on yes. */
  effect: string;
  /** Draft path and sha256, spawn args, grant key old → new, paths that would be lost. */
  subject: Record<string, unknown>;
};

export type ApprovalRequest = ApprovalFields & {
  id: string;
  hash: string;
  session: string | null;
  created: string;
  expires: string;
};

export type ApprovalGrant = {
  id: string;
  hash: string;
  host: string;
  session: string | null;
  toolUseId: string | null;
  at: string;
  expires: string;
  /** `host`: host-side code recorded it (a hook or plugin); `terminal`: the user's own terminal. */
  via: "host" | "terminal";
  observer: "host_hook" | null;
};

export type ApprovalAsked = {
  toolUseId: string;
  session: string;
  host: string;
  ids: string[];
  /** One hash per id, as shown in the ask. */
  hashes: Record<string, string>;
  at: string;
};

export type ApprovalConsumed = {
  id: string;
  hash: string;
  verb: string;
  head: string | null;
  /** The consuming session and the one whose grant it was (they may differ, spec decision 7). */
  session: string | null;
  grantSession: string | null;
  via: ApprovalGrant["via"];
  at: string;
};

export type ApprovalRefusal = {
  ok: false;
  code: "approval_needed" | "approval_stale" | "approval_consumed";
  message: string;
  /** The new request to approve (needed, stale); null when consumed. */
  request: ApprovalRequest | null;
};

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ID_PATTERN = /^ap_[a-z2-7]{8}$/u;

export const isApprovalId = (word: string): boolean => ID_PATTERN.test(word);

/** `ap_` + 8 random base32 characters: printed, never derived from content. */
export const newApprovalId = (): string =>
  `ap_${[...randomBytes(8)].map((byte) => ID_ALPHABET[byte % 32]).join("")}`;

/** sha256 over the canonical JSON of kind, action, target, effect and subject. */
export const approvalHash = (fields: ApprovalFields): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        kind: fields.kind,
        action: fields.action,
        target: fields.target,
        effect: fields.effect,
        subject: fields.subject,
      }),
    )
    .digest("hex");

export const approvalsDir = (): string => path.join(resolveStateDir(), "approvals");
type Part = "requests" | "asked" | "grants" | "consumed" | "rejected";
const dirOf = (part: Part) => path.join(approvalsDir(), part);
const fileOf = (part: Exclude<Part, "asked">, id: string) => path.join(dirOf(part), `${id}.json`);
const askedFile = (session: string, toolUseId: string) =>
  path.join(
    dirOf("asked"),
    `${createHash("sha256").update(`${session}\0${toolUseId}`).digest("hex").slice(0, 32)}.json`,
  );

/** A stored record, or null when it is missing or unreadable; callers check the fields they use. */
const readJson = (file: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const write = (file: string, value: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
};

const live = (expires: string, now: Date): boolean => Date.parse(expires) > now.getTime();
const later = (now: Date, ms: number) => new Date(now.getTime() + ms).toISOString();

/** Write a new request. Needs no authority: it grants nothing. */
export const createApprovalRequest = (
  fields: ApprovalFields,
  options: { session: string | null; now?: Date; ttlMs?: number },
): ApprovalRequest => {
  const now = options.now ?? new Date();
  const request: ApprovalRequest = {
    id: newApprovalId(),
    kind: fields.kind,
    action: fields.action,
    target: fields.target,
    effect: fields.effect,
    subject: fields.subject,
    hash: approvalHash(fields),
    session: options.session,
    created: now.toISOString(),
    expires: later(now, options.ttlMs ?? REQUEST_TTL_MS),
  };
  mkdirSync(dirOf("requests"), { recursive: true });
  writeFileExclusive(fileOf("requests", request.id), `${JSON.stringify(request, null, 2)}\n`);
  return request;
};

/**
 * The stored request `id`, or null when it is unknown or its hash no longer
 * matches its fields (the file was changed after it was written).
 */
export const readApprovalRequest = (id: string): ApprovalRequest | null => {
  if (!isApprovalId(id)) return null;
  const request = readJson(fileOf("requests", id)) as ApprovalRequest | null;
  if (!request || request.id !== id) return null;
  try {
    return approvalHash(request) === request.hash ? request : null;
  } catch {
    return null;
  }
};

/** A live request, or why there is none. */
export const liveApprovalRequest = (
  id: string,
  now: Date = new Date(),
): { ok: true; request: ApprovalRequest } | { ok: false; reason: string } => {
  const request = readApprovalRequest(id);
  if (!request) return { ok: false, reason: `${id}: no such approval request` };
  if (!live(request.expires, now))
    return {
      ok: false,
      reason: `${id}: the request expired at ${request.expires}`,
    };
  if (readJson(fileOf("consumed", id)))
    return { ok: false, reason: `${id}: already approved and used` };
  if (readJson(fileOf("rejected", id)))
    return {
      ok: false,
      reason: `${id}: the user rejected it or chose to edit its subject`,
    };
  return { ok: true, request };
};

const subjectLine = (subject: Record<string, unknown>): string =>
  Object.entries(subject)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("; ");

/**
 * The text the user approves, rendered by Workit from the stored request,
 * never from text the agent passes.
 */
export const renderApprovalRequest = (request: ApprovalRequest): string =>
  [
    `${request.id} (${request.kind}): ${request.action}`,
    `  target: ${Object.entries(request.target)
      .map(([key, value]) => `${key} ${value}`)
      .join(", ")}`,
    `  effect: ${request.effect}`,
    `  subject: ${subjectLine(request.subject)}`,
    `  hash: ${request.hash.slice(0, 12)}  expires: ${request.expires}`,
  ].join("\n");

/** The line every refusal prints: the fallback that works on every host. */
export const approveLine = (ids: readonly string[]): string =>
  `approve: workit approve ${ids.join(" ")} (or run it in your own terminal)`;

/**
 * A host ask on one tool call (Claude Code PreToolUse): one hash per id with a
 * live request. Null when none of `ids` has one.
 */
export const recordApprovalAsked = (
  input: {
    toolUseId: string;
    session: string;
    host: string;
    ids: readonly string[];
  },
  now: Date = new Date(),
): ApprovalAsked | null => {
  const hashes: Record<string, string> = {};
  for (const id of input.ids) {
    const found = liveApprovalRequest(id, now);
    if (found.ok) hashes[id] = found.request.hash;
  }
  const ids = Object.keys(hashes);
  if (ids.length === 0) return null;
  const asked: ApprovalAsked = {
    toolUseId: input.toolUseId,
    session: input.session,
    host: input.host,
    ids,
    hashes,
    at: now.toISOString(),
  };
  write(askedFile(input.session, input.toolUseId), asked);
  return asked;
};

export const readApprovalAsked = (session: string, toolUseId: string): ApprovalAsked | null => {
  const asked = readJson(askedFile(session, toolUseId)) as ApprovalAsked | null;
  return asked && asked.session === session && asked.toolUseId === toolUseId ? asked : null;
};

/**
 * Record the yes for `id`. A host grant needs the ask that showed this hash
 * on the same tool call; a terminal grant needs the CLI's own checks, done by
 * its caller. Never widens: the grant covers the request's one hash.
 */
export const recordApprovalGrant = (
  input: {
    id: string;
    host: string;
    session: string | null;
    toolUseId: string | null;
    via: ApprovalGrant["via"];
  },
  options: { now?: Date; ttlMs?: number } = {},
): { ok: true; grant: ApprovalGrant } | { ok: false; reason: string } => {
  const now = options.now ?? new Date();
  const found = liveApprovalRequest(input.id, now);
  if (!found.ok) return found;
  if (input.via === "host") {
    const asked =
      input.session && input.toolUseId ? readApprovalAsked(input.session, input.toolUseId) : null;
    if (!asked || asked.hashes[input.id] !== found.request.hash)
      return {
        ok: false,
        reason: `${input.id}: no host ask showed this request on that call`,
      };
  }
  const grant: ApprovalGrant = {
    id: input.id,
    hash: found.request.hash,
    host: input.host,
    session: input.session,
    toolUseId: input.toolUseId,
    at: now.toISOString(),
    expires: later(now, options.ttlMs ?? GRANT_TTL_MS),
    via: input.via,
    observer: input.via === "host" ? "host_hook" : null,
  };
  write(fileOf("grants", input.id), grant);
  return { ok: true, grant };
};

/**
 * A no where the host reports one (Pi's dialog), or Edit: the request is
 * closed, and the verb writes a new one on its next run.
 */
export const recordApprovalRejected = (
  input: { id: string; host: string; session: string | null; edit: boolean },
  now: Date = new Date(),
): void => {
  if (!readApprovalRequest(input.id)) return;
  write(fileOf("rejected", input.id), { ...input, at: now.toISOString() });
};

/** A grant written by host-side code after its ask, or at the user's terminal. */
const trusted = (grant: ApprovalGrant): boolean => {
  if (grant.via === "terminal") return true;
  if (grant.via !== "host" || grant.observer !== "host_hook") return false;
  if (grant.host !== "claude_code") return true;
  const asked =
    grant.session && grant.toolUseId ? readApprovalAsked(grant.session, grant.toolUseId) : null;
  return asked?.hashes[grant.id] === grant.hash;
};

const grants = (): ApprovalGrant[] => {
  let names: string[] = [];
  try {
    names = readdirSync(dirOf("grants"));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(path.join(dirOf("grants"), name)) as ApprovalGrant | null)
    .filter((grant): grant is ApprovalGrant => grant !== null && isApprovalId(grant.id));
};

const sameTarget = (request: ApprovalRequest, fields: ApprovalFields): boolean =>
  request.kind === fields.kind && canonicalJson(request.target) === canonicalJson(fields.target);

/**
 * Consume the user's yes for the action `fields` describe, immediately before
 * its side effect (spec: How a CLI verb checks an approval). Accepts a live,
 * trusted, unconsumed grant whose hash equals the current one, from any
 * session. Otherwise refuses and writes a new request to approve:
 * `approval_stale` when the yes was for an older hash of the same kind and
 * target, `approval_needed` when there is none; `approval_consumed` when the
 * matching yes was already used. A verb that exits before its side effect
 * does not call this.
 */
export const consumeApproval = (
  fields: ApprovalFields,
  use: { session: string | null; verb: string; head?: string | null },
  now: Date = new Date(),
): { ok: true; consumed: ApprovalConsumed; grant: ApprovalGrant } | ApprovalRefusal => {
  const hash = approvalHash(fields);
  const all = grants();
  const matching = all.filter((grant) => {
    const request = readApprovalRequest(grant.id);
    return grant.hash === hash && request?.hash === hash && trusted(grant);
  });
  let used = false;
  for (const grant of matching) {
    if (readJson(fileOf("consumed", grant.id))) {
      used = true;
      continue;
    }
    if (!live(grant.expires, now)) continue;
    const consumed: ApprovalConsumed = {
      id: grant.id,
      hash,
      verb: use.verb,
      head: use.head ?? null,
      session: use.session,
      grantSession: grant.session,
      via: grant.via,
      at: now.toISOString(),
    };
    mkdirSync(dirOf("consumed"), { recursive: true });
    const won =
      writeFileExclusive(fileOf("consumed", grant.id), `${JSON.stringify(consumed, null, 2)}\n`) ===
      "created";
    if (won) return { ok: true, consumed, grant };
    used = true;
  }
  if (used)
    return {
      ok: false,
      code: "approval_consumed",
      message: `approval_consumed: the user's yes for ${fields.action} was already used; one yes covers one run`,
      request: null,
    };
  const stale = all.find((grant) => {
    const request = readApprovalRequest(grant.id);
    return request !== null && grant.hash !== hash && sameTarget(request, fields);
  });
  const request = createApprovalRequest(fields, { session: use.session, now });
  if (stale)
    return {
      ok: false,
      code: "approval_stale",
      message: `approval_stale: the user approved ${stale.hash.slice(0, 12)} but ${fields.action} is now ${hash.slice(0, 12)}; a changed subject needs a new yes. ${approveLine([request.id])}`,
      request,
    };
  return {
    ok: false,
    code: "approval_needed",
    message: `approval_needed: ${fields.action} needs the user's yes. ${approveLine([request.id])}`,
    request,
  };
};
