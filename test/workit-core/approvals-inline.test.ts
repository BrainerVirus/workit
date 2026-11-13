// #864, the store: one request per text (a refusal never mints a second id),
// and the ask on the action itself, bound to its ticket, used once.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  approveCommand,
  consumeApproval,
  consumeInlineAsk,
  createApprovalRequest,
  pendingApprovalRequests,
  recordApprovalGrant,
  recordInlineAsk,
  type ApprovalFields,
} from "@/packages/workit-core/src/approvals/store";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-approvals-inline-")));
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

const comment = (text: string): ApprovalFields => ({
  kind: "youtrack-write",
  action: "workit youtrack note X-1",
  target: { tracker: "ytrack:default", issue: "X-1" },
  effect: "posts this comment on X-1",
  subject: { comment: text },
});

test("Given the same comment refused three times, When the requests are listed, Then there is one request and one id", () => {
  const ids = [1, 2, 3].map(() => {
    const used = consumeApproval(comment("same text"), { session: "s", verb: "youtrack note" });
    return used.ok ? "" : (used.request?.id ?? "");
  });
  expect(new Set(ids).size).toBe(1);
  expect(pendingApprovalRequests().map((request) => request.id)).toEqual([ids[0]]);
});

test("Given one pending request, When the fallback names it, Then the command has no id; with two, it names the id", () => {
  const first = createApprovalRequest(comment("one"), { session: null });
  expect(approveCommand(first)).toBe("workit approve");
  const second = createApprovalRequest(comment("two"), { session: null });
  expect(approveCommand(second)).toBe(`workit approve ${second.id}`);
});

test("Given a used request, When the same text is refused again, Then a new request is written (the old one is closed)", () => {
  const fields = comment("again");
  const request = createApprovalRequest(fields, { session: null });
  recordApprovalGrant({
    id: request.id,
    host: "terminal",
    session: null,
    toolUseId: null,
    via: "terminal",
  });
  expect(consumeApproval(fields, { session: null, verb: "v" }).ok).toBe(true);
  expect(createApprovalRequest(fields, { session: null }).id).not.toBe(request.id);
});

const asked = {
  kind: "youtrack-write" as const,
  argvHash: "a".repeat(64),
  contentHash: "c".repeat(64),
};
const ask = (now?: Date) =>
  recordInlineAsk(
    { ...asked, host: "claude_code", session: "s", agent: null, toolUseId: "toolu_1" },
    now,
  );
const use = (ticket: string, over: Partial<typeof asked> = {}) =>
  consumeInlineAsk({ ticket, ...asked, ...over, verb: "youtrack note", session: "s" });

test("Given an inline ask, When its call uses the ticket, Then it is consumed once and the ticket is never on disk", () => {
  const { ticket } = ask();
  const dir = path.join(process.env.WORKIT_STATE_DIR!, "approvals", "inline");
  const [file] = readdirSync(dir);
  expect(readFileSync(path.join(dir, String(file)), "utf8")).not.toContain(ticket);
  expect(use(ticket).ok).toBe(true);
  expect(use(ticket)).toMatchObject({ ok: false });
});

test("Given an inline ask, When another call, changed content or a stale ticket tries it, Then each is refused", () => {
  const { ticket } = ask();
  expect(use(ticket, { argvHash: "b".repeat(64) })).toMatchObject({
    ok: false,
    reason: expect.stringContaining("another call"),
  });
  expect(use(ticket, { contentHash: "d".repeat(64) })).toMatchObject({
    ok: false,
    reason: expect.stringContaining("changed"),
  });
  expect(use("not-a-ticket")).toMatchObject({ ok: false });
  const old = ask(new Date(Date.now() - 11 * 60_000));
  expect(use(old.ticket)).toMatchObject({ ok: false });
});

test("Given an ask the user rejected, When the agent's next call is asked again, Then the old ticket no longer works", () => {
  const rejected = ask();
  const next = ask();
  expect(use(rejected.ticket)).toMatchObject({ ok: false });
  expect(use(next.ticket).ok).toBe(true);
});

test("Given an ask from one host session, When another session or none consumes it, Then it is refused; its own session can", () => {
  const { ticket } = ask();
  expect(consumeInlineAsk({ ticket, ...asked, verb: "v", session: "other" })).toMatchObject({
    ok: false,
    reason: expect.stringContaining("another session"),
  });
  expect(consumeInlineAsk({ ticket, ...asked, verb: "v", session: null })).toMatchObject({
    ok: false,
  });
  expect(consumeInlineAsk({ ticket, ...asked, verb: "v", session: "s" }).ok).toBe(true);
});
