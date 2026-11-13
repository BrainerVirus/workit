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
//   <state>/approvals/inline/<ticket>.json an ask on the action itself (#864): the
//                                          host showed the full text on one call
//
// The write gate denies an agent's edit or shell write under approvals/
// (hooks/write-gate.ts). Like that guard, this stops honest mistakes and
// accidental self-approval, not a determined agent (D18).
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
  "youtrack-write",
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
type Part = "requests" | "asked" | "grants" | "consumed" | "rejected" | "inline";
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

const names = (part: Part): string[] => {
  try {
    return readdirSync(dirOf(part)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
};
const later = (now: Date, ms: number) => new Date(now.getTime() + ms).toISOString();

/**
 * The live request for these fields: the one already written for their hash
 * (#864: a refusal never mints a second id for the same text), else a new
 * one. Needs no authority: it grants nothing.
 */
export const createApprovalRequest = (
  fields: ApprovalFields,
  options: { session: string | null; now?: Date; ttlMs?: number },
): ApprovalRequest => {
  const now = options.now ?? new Date();
  const hash = approvalHash(fields);
  const known = pendingApprovalRequests(now, { granted: true }).find(
    (request) => request.hash === hash,
  );
  if (known) return known;
  const request: ApprovalRequest = {
    id: newApprovalId(),
    kind: fields.kind,
    action: fields.action,
    target: fields.target,
    effect: fields.effect,
    subject: fields.subject,
    hash,
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

/**
 * The live requests, oldest first: not expired, used or rejected. A request
 * whose live yes is not used yet is left out unless `granted`.
 */
export const pendingApprovalRequests = (
  now: Date = new Date(),
  options: { granted?: boolean } = {},
): ApprovalRequest[] =>
  names("requests")
    .map((name) => liveApprovalRequest(name.slice(0, -5), now))
    .flatMap((found) => (found.ok ? [found.request] : []))
    .filter((request) => {
      if (options.granted) return true;
      const grant = readJson(fileOf("grants", request.id)) as ApprovalGrant | null;
      return !grant || grant.hash !== request.hash || !live(grant.expires, now);
    })
    .toSorted((a, b) => a.created.localeCompare(b.created));

/** Lines past this are summed up as "N more lines": the prompt stays readable. */
export const SHOWN_LINES = 60;

/** `text` indented, cut after SHOWN_LINES lines with how many more there are. */
export const shownText = (text: string, indent = "    "): string[] => {
  const lines = text.trimEnd().split(/\r?\n/u);
  const more = lines.length - SHOWN_LINES;
  if (more > 0) lines.splice(SHOWN_LINES, more, `… ${more} more lines`);
  return lines.map((line) => indent + line);
};

/** Each subject field; a text of several lines is shown in full, below its name. */
const subjectLines = (subject: Record<string, unknown>): string[] =>
  Object.entries(subject).flatMap(([key, value]) =>
    typeof value === "string" && value.includes("\n")
      ? [`  ${key}:`, ...shownText(value)]
      : [`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`],
  );

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
    ...subjectLines(request.subject),
    `  hash: ${request.hash.slice(0, 12)}  expires: ${request.expires}`,
  ].join("\n");

/**
 * The terminal fallback for `request` (#864), on hosts with no ask on the
 * action itself: one short command, with the id only when another request
 * is pending too (`workit approve` alone takes the single pending one).
 */
export const approveCommand = (request: ApprovalRequest, now: Date = new Date()): string => {
  const pending = pendingApprovalRequests(now);
  return pending.length === 1 && pending[0]?.id === request.id
    ? "workit approve"
    : `workit approve ${request.id}`;
};

/** The line a refusal prints on a host with no ask on the action: the user's terminal step. */
export const approveLine = (request: ApprovalRequest, now: Date = new Date()): string =>
  `approve: ask the user to run \`${approveCommand(request, now)}\` in a terminal (it shows the full text and asks y/N), then run this call again`;

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

/** The hosts whose own code records an ask row and then the grant on the same call. */
const ASKING_HOSTS = new Set(["claude_code", "pi"]);

/**
 * A grant only from a path that records one: `workit approve` at the user's
 * terminal, or a Claude Code or Pi grant with the same host's ask row behind
 * it. The ask row catches a hand-edited grant, not a forger who writes both
 * files (D18).
 */
const trusted = (grant: ApprovalGrant): boolean => {
  if (grant.via === "terminal")
    return grant.host === "terminal" && grant.toolUseId === null && grant.observer === null;
  if (grant.via !== "host" || grant.observer !== "host_hook" || !ASKING_HOSTS.has(grant.host))
    return false;
  const asked =
    grant.session && grant.toolUseId ? readApprovalAsked(grant.session, grant.toolUseId) : null;
  return asked?.host === grant.host && asked.hashes[grant.id] === grant.hash;
};

const grants = (): ApprovalGrant[] =>
  names("grants")
    .map((name) => readJson(path.join(dirOf("grants"), name)) as ApprovalGrant | null)
    .filter((grant): grant is ApprovalGrant => grant !== null && isApprovalId(grant.id));

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
      message: `approval_stale: the user approved ${stale.hash.slice(0, 12)} but ${fields.action} is now ${hash.slice(0, 12)}; a changed subject needs a new yes. ${approveLine(request, now)}`,
      request,
    };
  return {
    ok: false,
    code: "approval_needed",
    message: `approval_needed: ${fields.action} needs the user's yes. ${approveLine(request, now)}`,
    request,
  };
};

// --- the ask on the action itself (#864) -----------------------------------

/** An inline ask lives this long after the host showed it: time to read the text and answer. */
export const INLINE_ASK_TTL_MS = 2 * 60_000;
/** The env prefix the host adds to the one call it asked about: the ticket. */
export const INLINE_TICKET_ENV = "WORKIT_APPROVAL_TICKET";
/** The env prefix naming a host mode where no person sees a prompt: the verb names it. */
export const INLINE_UNASKED_ENV = "WORKIT_APPROVAL_UNASKED";

/**
 * Only the host's own rewrite puts either name on a call: a command or file an
 * agent writes that names one (quotes and backslashes removed) is refused, so
 * a ticket read from the transcript cannot be replayed.
 */
export const namesTicket = (text: string): boolean =>
  /WORKIT_APPROVAL_(?:TICKET|UNASKED)/u.test(text.replace(/['"\\]/gu, ""));
export const TICKET_DENY = "Only the host's prompt adds an approval ticket.";

/**
 * A host prompt that showed one call's full text (Claude Code PreToolUse,
 * Pi's dialog). The ticket itself is never stored: only its sha256, so the
 * row on disk cannot be replayed (D18: a reader of the host's own transcript
 * can, until the row is used, expires or a newer ask replaces it).
 */
export type InlineAsked = {
  ticketHash: string;
  kind: ApprovalKind;
  /** sha256 of the call's words past its verb. */
  argvHash: string;
  /** sha256 of what the call posts: its words and every file it reads. */
  contentHash: string;
  host: string;
  session: string | null;
  /** The subagent that made the call; null for the session's own (lead) call. */
  agent: string | null;
  toolUseId: string | null;
  at: string;
  expires: string;
};

/** Delete every inline row `drop` matches (and any unreadable one). */
const dropInline = (drop: (row: InlineAsked) => boolean): void => {
  for (const name of names("inline")) {
    const file = path.join(dirOf("inline"), name);
    const row = readJson(file) as InlineAsked | null;
    if (!row || drop(row)) rmSync(file, { force: true });
  }
};

/**
 * Close the unused asks of `session` (#864): the user's next message (all of
 * them) or the end of its lead's turn (`lead`: only the session's own calls),
 * so a yes is used in the turn it was given and a rejected prompt's ticket
 * dies with the turn.
 */
export const dropInlineAsks = (session: string, lead = false): void =>
  dropInline((row) => row.session === session && !(lead && row.agent));

const TICKET = /^[A-Za-z0-9_-]{32}$/u;
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Record an ask on one call and return its ticket, which the host passes to
 * that call only. Every older unused ask for the same call and content is
 * closed first: only the call the person was asked about last can use a yes.
 */
export const recordInlineAsk = (
  input: Omit<InlineAsked, "ticketHash" | "at" | "expires">,
  now: Date = new Date(),
  ttlMs: number = INLINE_ASK_TTL_MS,
): { ticket: string; asked: InlineAsked } => {
  dropInline((row) => row.argvHash === input.argvHash && row.contentHash === input.contentHash);
  const ticket = randomBytes(24).toString("base64url");
  const asked: InlineAsked = {
    ...input,
    ticketHash: sha(ticket),
    at: now.toISOString(),
    expires: later(now, ttlMs),
  };
  write(fileOf("inline", asked.ticketHash), asked);
  return { ticket, asked };
};

export type InlineConsumed = {
  ticketHash: string;
  kind: ApprovalKind;
  contentHash: string;
  verb: string;
  host: string;
  session: string | null;
  askSession: string | null;
  at: string;
};

/**
 * Use the yes a host prompt gave this very call, once, right before its side
 * effect. The ticket must name a live ask for the same kind, words and
 * content; anything else (no ticket, a ticket from another call, a changed
 * file, a second use, an expired or replaced ask) is refused.
 */
export const consumeInlineAsk = (
  input: {
    ticket: string;
    kind: ApprovalKind;
    argvHash: string;
    contentHash: string;
    verb: string;
    session: string | null;
  },
  now: Date = new Date(),
): { ok: true; asked: InlineAsked; consumed: InlineConsumed } | { ok: false; reason: string } => {
  if (!TICKET.test(input.ticket)) return { ok: false, reason: "the ticket is malformed" };
  const ticketHash = sha(input.ticket);
  const file = fileOf("inline", ticketHash);
  const asked = readJson(file) as InlineAsked | null;
  if (!asked || asked.ticketHash !== ticketHash)
    return {
      ok: false,
      reason: "no host ask matches it (used, expired, replaced by a newer ask, or never asked)",
    };
  if (asked.kind !== input.kind || asked.argvHash !== input.argvHash)
    return { ok: false, reason: "the host asked about another call" };
  if (asked.contentHash !== input.contentHash)
    return { ok: false, reason: "the text or a file changed after the host showed it" };
  if (!live(asked.expires, now))
    return { ok: false, reason: `the host ask expired at ${asked.expires}` };
  const consumed: InlineConsumed = {
    ticketHash,
    kind: asked.kind,
    contentHash: asked.contentHash,
    verb: input.verb,
    host: asked.host,
    session: input.session,
    askSession: asked.session,
    at: now.toISOString(),
  };
  mkdirSync(dirOf("consumed"), { recursive: true });
  const won =
    writeFileExclusive(
      fileOf("consumed", `inline-${ticketHash}`),
      `${JSON.stringify(consumed, null, 2)}\n`,
    ) === "created";
  rmSync(file, { force: true });
  return won ? { ok: true, asked, consumed } : { ok: false, reason: "its yes was already used" };
};
