// The host-approval store (docs/workit-next/host-approval.md): request shape
// and expiry, host and terminal grants, and the one-time consume a later
// consumer verb calls right before its side effect.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  approvalHash,
  consumeApproval,
  createApprovalRequest,
  GRANT_TTL_MS,
  liveApprovalRequest,
  recordApprovalAsked,
  recordApprovalGrant,
  REQUEST_TTL_MS,
  type ApprovalFields,
} from "@/packages/workit-core/src/approvals/store";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-approvals-store-")));
const saved = process.env.WORKIT_STATE_DIR;
let run = 0;
beforeEach(() => {
  run += 1;
  process.env.WORKIT_STATE_DIR = path.join(base, `state-${run}`);
});
afterAll(() => {
  if (saved === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = saved;
  rmSync(base, { recursive: true, force: true });
});

const T0 = new Date("2026-11-11T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

const draft = (sha: string): ApprovalFields => ({
  kind: "release-notes",
  action: "workit git push --release 4.5.0",
  target: { repo: "/r/.git", version: "4.5.0" },
  effect: "publishes the forge release 4.5.0 with this draft",
  subject: { draft: ".workit/release-notes/4.5.0.md", sha256: sha },
});

const use = { session: "consumer-session", verb: "git push --release" };

/** A host grant the way Claude Code records one: the ask on a tool call, then the grant on its PostToolUse. */
const hostYes = (id: string, now: Date, session = "lead-session") => {
  recordApprovalAsked({ toolUseId: "toolu_1", session, host: "claude_code", ids: [id] }, now);
  return recordApprovalGrant(
    { id, host: "claude_code", session, toolUseId: "toolu_1", via: "host" },
    { now },
  );
};

test("Given a request, Then it carries id, kind, action, target, effect, subject, a sha256 over those fields, its session and a 30-minute expiry", () => {
  const request = createApprovalRequest(draft("aaa"), { session: "s1", now: T0 });
  expect(request.id).toMatch(/^ap_[a-z2-7]{8}$/);
  expect(request).toMatchObject({ ...draft("aaa"), session: "s1", created: T0.toISOString() });
  expect(request.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(request.hash).toBe(approvalHash(draft("aaa")));
  expect(request.hash).not.toBe(approvalHash(draft("aab")));
  expect(Date.parse(request.expires) - T0.getTime()).toBe(REQUEST_TTL_MS);
  expect(liveApprovalRequest(request.id, at(REQUEST_TTL_MS - 1)).ok).toBe(true);
  expect(liveApprovalRequest(request.id, at(REQUEST_TTL_MS))).toMatchObject({ ok: false });
  expect(createApprovalRequest(draft("aaa"), { session: "s1", now: T0 }).id).not.toBe(request.id);
});

test("Given a request file changed after it was written, Then it is no request at all", () => {
  const request = createApprovalRequest(draft("aaa"), { session: "s1", now: T0 });
  const file = path.join(
    process.env.WORKIT_STATE_DIR!,
    "approvals",
    "requests",
    `${request.id}.json`,
  );
  const stored = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...stored, effect: "something else" }));
  expect(liveApprovalRequest(request.id, T0)).toMatchObject({ ok: false });
});

test("Given a host grant, Then it needs the ask that showed this hash on the same call, and lasts 15 minutes", () => {
  const request = createApprovalRequest(draft("aaa"), { session: "s1", now: T0 });
  const unasked = recordApprovalGrant(
    { id: request.id, host: "claude_code", session: "s1", toolUseId: "toolu_9", via: "host" },
    { now: T0 },
  );
  expect(unasked.ok).toBe(false);
  const granted = hostYes(request.id, at(1000));
  expect(granted.ok).toBe(true);
  if (!granted.ok) return;
  expect(granted.grant).toMatchObject({ hash: request.hash, observer: "host_hook", via: "host" });
  expect(Date.parse(granted.grant.expires) - at(1000).getTime()).toBe(GRANT_TTL_MS);
});

test("Given a granted request, When the consumer runs twice, Then the first consumes it and the second refuses approval_consumed", () => {
  const request = createApprovalRequest(draft("aaa"), { session: "s1", now: T0 });
  hostYes(request.id, T0);
  const first = consumeApproval(draft("aaa"), use, at(60_000));
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.consumed).toMatchObject({ id: request.id, verb: use.verb, session: use.session });
  expect(first.consumed.grantSession).toBe("lead-session");
  const second = consumeApproval(draft("aaa"), use, at(61_000));
  expect(second).toMatchObject({ ok: false, code: "approval_consumed", request: null });
});

test("Given a grant 15 minutes old, When the consumer runs, Then it is not accepted and a new request is written", () => {
  const request = createApprovalRequest(draft("aaa"), { session: "s1", now: T0 });
  hostYes(request.id, T0);
  const late = consumeApproval(draft("aaa"), use, at(GRANT_TTL_MS));
  expect(late.ok).toBe(false);
  if (late.ok) return;
  expect(late.code).toBe("approval_needed");
  expect(late.request?.id).not.toBe(request.id);
  expect(late.message).toContain(`workit approve ${late.request?.id}`);
});

test("Given an approved draft edited by one byte, When the consumer runs, Then it refuses approval_stale naming both hash prefixes and a new id", () => {
  const request = createApprovalRequest(draft("aaa"), { session: "s1", now: T0 });
  hostYes(request.id, T0);
  const stale = consumeApproval(draft("aab"), use, at(1000));
  expect(stale.ok).toBe(false);
  if (stale.ok) return;
  expect(stale.code).toBe("approval_stale");
  expect(stale.message).toContain(request.hash.slice(0, 12));
  expect(stale.message).toContain(approvalHash(draft("aab")).slice(0, 12));
  expect(stale.message).toContain(`workit approve ${stale.request?.id}`);
  // The original grant was not used by the refused run.
  expect(consumeApproval(draft("aaa"), use, at(2000)).ok).toBe(true);
});

test("Given a grant whose stored hash does not match its request, When the consumer runs, Then it is refused", () => {
  const request = createApprovalRequest(draft("aaa"), { session: "s1", now: T0 });
  hostYes(request.id, T0);
  const file = path.join(
    process.env.WORKIT_STATE_DIR!,
    "approvals",
    "grants",
    `${request.id}.json`,
  );
  const grant = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...grant, hash: approvalHash(draft("bbb")) }));
  expect(consumeApproval(draft("bbb"), use, at(1000)).ok).toBe(false);
});

test("Given a host grant without the ask record behind it, When the consumer runs, Then it is refused", () => {
  const request = createApprovalRequest(draft("aaa"), { session: "s1", now: T0 });
  hostYes(request.id, T0);
  rmSync(path.join(process.env.WORKIT_STATE_DIR!, "approvals", "asked"), { recursive: true });
  expect(consumeApproval(draft("aaa"), use, at(1000))).toMatchObject({
    ok: false,
    code: "approval_needed",
  });
});

const grantFile = (id: string) =>
  path.join(process.env.WORKIT_STATE_DIR!, "approvals", "grants", `${id}.json`);

/** Hand-edit a recorded grant: the D18 case the cross-check catches. */
const editGrant = (id: string, fields: Record<string, unknown>) => {
  const grant = JSON.parse(readFileSync(grantFile(id), "utf8"));
  writeFileSync(grantFile(id), JSON.stringify({ ...grant, ...fields }));
};

/** A host grant the way Pi records one: the ask row, then the grant on the same call id. */
const piYes = (id: string, now: Date) => {
  recordApprovalAsked({ toolUseId: "pi-call", session: "pi-session", host: "pi", ids: [id] }, now);
  return recordApprovalGrant(
    { id, host: "pi", session: "pi-session", toolUseId: "pi-call", via: "host" },
    { now },
  );
};

test("Given a Pi grant with its ask row, When the consumer runs, Then it is accepted", () => {
  const request = createApprovalRequest(draft("aaa"), { session: "s1", now: T0 });
  expect(piYes(request.id, T0).ok).toBe(true);
  expect(consumeApproval(draft("aaa"), use, at(1000)).ok).toBe(true);
});

test("Given a Pi grant without its ask row, When the consumer runs, Then it is refused", () => {
  const request = createApprovalRequest(draft("aaa"), { session: "s1", now: T0 });
  piYes(request.id, T0);
  rmSync(path.join(process.env.WORKIT_STATE_DIR!, "approvals", "asked"), { recursive: true });
  expect(consumeApproval(draft("aaa"), use, at(1000))).toMatchObject({
    ok: false,
    code: "approval_needed",
  });
});

test.each(["opencode", "codex", "cursor", "made_up"])(
  "Given a host grant whose host is %s, When the consumer runs, Then it is refused",
  (host) => {
    const request = createApprovalRequest(draft("aaa"), { session: "s1", now: T0 });
    recordApprovalAsked(
      { toolUseId: "toolu_1", session: "lead-session", host, ids: [request.id] },
      T0,
    );
    const recorded = recordApprovalGrant(
      { id: request.id, host, session: "lead-session", toolUseId: "toolu_1", via: "host" },
      { now: T0 },
    );
    expect(recorded.ok).toBe(true);
    expect(consumeApproval(draft("aaa"), use, at(1000)).ok).toBe(false);
  },
);

test("Given a claude_code or pi grant whose ask row names another host, When the consumer runs, Then it is refused", () => {
  const cc = createApprovalRequest(draft("aaa"), { session: "s1", now: T0 });
  hostYes(cc.id, T0);
  editGrant(cc.id, { host: "pi" });
  expect(consumeApproval(draft("aaa"), use, at(1000)).ok).toBe(false);

  const pi = createApprovalRequest(draft("bbb"), { session: "s1", now: T0 });
  piYes(pi.id, T0);
  editGrant(pi.id, { host: "claude_code" });
  expect(consumeApproval(draft("bbb"), use, at(1000)).ok).toBe(false);
});

test.each([
  ["a host other than terminal", { host: "claude_code" }],
  ["a toolUseId", { toolUseId: "toolu_1" }],
  ["an observer", { observer: "host_hook" }],
])("Given a terminal grant with %s, When the consumer runs, Then it is refused", (_, fields) => {
  const request = createApprovalRequest(draft("aaa"), { session: "s1", now: T0 });
  recordApprovalGrant(
    { id: request.id, host: "terminal", session: null, toolUseId: null, via: "terminal" },
    { now: T0 },
  );
  editGrant(request.id, fields);
  expect(consumeApproval(draft("aaa"), use, at(1000)).ok).toBe(false);
});

test("Given a grant from another session (the user's terminal), When the hash matches, Then it is accepted and both sessions are named", () => {
  const request = createApprovalRequest(draft("aaa"), { session: "s1", now: T0 });
  const terminal = recordApprovalGrant(
    { id: request.id, host: "terminal", session: null, toolUseId: null, via: "terminal" },
    { now: T0 },
  );
  expect(terminal.ok).toBe(true);
  const used = consumeApproval(draft("aaa"), { ...use, session: "other" }, at(1000));
  expect(used).toMatchObject({ ok: true, consumed: { session: "other", grantSession: null } });
});

test("Given no grant at all, When the consumer runs, Then it refuses approval_needed with a new request to approve", () => {
  const refused = consumeApproval(draft("aaa"), use, T0);
  expect(refused).toMatchObject({ ok: false, code: "approval_needed" });
  if (refused.ok) return;
  expect(refused.request).toMatchObject({ ...draft("aaa"), session: use.session });
});
