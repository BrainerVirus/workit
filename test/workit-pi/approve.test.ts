// Host-approval spec, Pi: in the TUI the tool_call hook shows the stored
// request in a select dialog, records the answer in the host's runtime and
// blocks the shell call with a result naming it. Print and RPC modes fall
// through to the shared gate, which denies the user-only call.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  consumeApproval,
  createApprovalRequest,
  liveApprovalRequest,
  type ApprovalFields,
} from "@/packages/workit-core/src/approvals/store";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";

const base = mkdtempSync(path.join(tmpdir(), "workit-pi-approve-"));
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

const FIELDS: ApprovalFields = {
  kind: "force-push",
  action: "workit git push --force feature/x",
  target: { repo: "/r/.git", branch: "feature/x" },
  effect: "overwrites feature/x on origin",
  subject: { lost: "3 commits by another session" },
};

const ctx = (mode: string, answer: string | undefined, shown: string[] = []) =>
  ({
    cwd: base,
    mode,
    hasUI: mode !== "print",
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "pi-session" },
    ui: {
      select: async (title: string) => {
        shown.push(title);
        return answer;
      },
    },
  }) as never;

const approve = (id: string, context: never) =>
  enforceToolPolicy(
    { toolName: "bash", toolCallId: "call-1", input: { command: `workit approve ${id}` } } as never,
    context,
  );

const grantFile = (id: string) =>
  path.join(process.env.WORKIT_STATE_DIR!, "approvals", "grants", `${id}.json`);

test("Given Pi's TUI, When the user picks Approve once, Then the grant is recorded and the call is blocked with a result naming it", async () => {
  const request = createApprovalRequest(FIELDS, { session: "pi-session" });
  const shown: string[] = [];
  const result = await approve(request.id, ctx("tui", "Approve once", shown));
  expect(shown[0]).toContain(request.id);
  expect(shown[0]).toContain(request.hash.slice(0, 12));
  expect(result).toMatchObject({ block: true, reason: expect.stringContaining("approved") });
  expect(consumeApproval(FIELDS, { session: "pi-session", verb: "git push" }).ok).toBe(true);
});

test("Given a Pi dialog grant whose ask row is gone, When the consumer runs, Then it is refused", async () => {
  const request = createApprovalRequest(FIELDS, { session: "pi-session" });
  await approve(request.id, ctx("tui", "Approve once"));
  expect(existsSync(grantFile(request.id))).toBe(true);
  rmSync(path.join(process.env.WORKIT_STATE_DIR!, "approvals", "asked"), { recursive: true });
  expect(consumeApproval(FIELDS, { session: "pi-session", verb: "git push" })).toMatchObject({
    ok: false,
    code: "approval_needed",
  });
});

test("Given Pi's TUI, When the user rejects, picks Edit or dismisses the dialog, Then no grant is recorded", async () => {
  for (const answer of ["Reject", "Edit", undefined]) {
    const request = createApprovalRequest(FIELDS, { session: "pi-session" });
    const result = await approve(request.id, ctx("tui", answer));
    expect(result, String(answer)).toMatchObject({ block: true });
    expect(existsSync(grantFile(request.id)), String(answer)).toBe(false);
    // A reject or an Edit closes the request; a dismissed dialog leaves it open.
    expect(liveApprovalRequest(request.id).ok, String(answer)).toBe(answer === undefined);
  }
});

test("Given print or RPC mode, When workit approve runs, Then no dialog is shown, nothing is recorded and the shared gate denies it", async () => {
  for (const mode of ["print", "rpc"]) {
    const request = createApprovalRequest(FIELDS, { session: "pi-session" });
    const shown: string[] = [];
    const result = await approve(request.id, ctx(mode, "Approve once", shown));
    expect(shown, mode).toEqual([]);
    expect(result, mode).toMatchObject({
      block: true,
      reason: expect.stringContaining("terminal"),
    });
    expect(existsSync(grantFile(request.id)), mode).toBe(false);
  }
});

test("Given a chain around workit approve, When Pi gates it, Then it is blocked naming the plain form", async () => {
  const request = createApprovalRequest(FIELDS, { session: "pi-session" });
  const result = await enforceToolPolicy(
    {
      toolName: "bash",
      toolCallId: "call-1",
      input: { command: `cd /tmp && workit approve ${request.id}` },
    } as never,
    ctx("tui", "Approve once"),
  );
  expect(result).toMatchObject({
    block: true,
    reason: expect.stringContaining(`\`workit approve ${request.id}\``),
  });
  expect(existsSync(grantFile(request.id))).toBe(false);
});
