// `workit approve <id>…`, the terminal fallback of the host-approval channel:
// a person at a real TTY outside an agent confirms and the grant is
// recorded; an agent shell (or no TTY) only shows the requests.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import { runApprove, type ApproveDeps } from "@/packages/workit-cli/src/verbs/approve";
import {
  consumeApproval,
  createApprovalRequest,
  type ApprovalFields,
} from "@/packages/workit-core/src/approvals/store";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-approve-cli-")));
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
  kind: "config",
  action: "workit grant set personal merge=true",
  target: { workspace: "personal" },
  effect: "lets an agent merge PRs in personal without asking",
  subject: { key: "merge", from: false, to: true },
};

const call = async (
  argv: string[],
  env: NodeJS.ProcessEnv,
  deps: ApproveDeps,
): Promise<{ code: number; out: string; err: string }> => {
  let out = "";
  let err = "";
  const io: Io = {
    json: false,
    cwd: base,
    env,
    stdout: (text) => void (out += text),
    stderr: (text) => void (err += text),
  };
  const code = await runApprove(argv, io, deps);
  return { code, out, err };
};

const terminal = (answer: boolean, asked: string[] = []): ApproveDeps => ({
  interactive: () => true,
  confirm: async (question) => {
    asked.push(question);
    return answer;
  },
});

const grantFile = (id: string) =>
  path.join(process.env.WORKIT_STATE_DIR!, "approvals", "grants", `${id}.json`);

test("Given no host channel, When the user runs workit approve at a real TTY outside an agent and confirms, Then the grant is recorded via the terminal", async () => {
  const request = createApprovalRequest(FIELDS, { session: "agent-session" });
  const asked: string[] = [];
  const result = await call([request.id], {}, terminal(true, asked));
  expect(result.code).toBe(0);
  expect(asked).toHaveLength(1);
  expect(result.out).toContain("workit grant set personal merge=true");
  expect(result.out).toContain(`approved ${request.id}`);
  const used = consumeApproval(FIELDS, { session: "agent-session", verb: "grant set" });
  expect(used).toMatchObject({ ok: true, grant: { via: "terminal" } });
});

test("Given the user declines at the terminal, Then nothing is recorded", async () => {
  const request = createApprovalRequest(FIELDS, { session: null });
  const result = await call([request.id], {}, terminal(false));
  expect(result.code).not.toBe(0);
  expect(existsSync(grantFile(request.id))).toBe(false);
});

const NO_TTY: ApproveDeps = { interactive: () => false, confirm: async () => true };

test.each<[string, NodeJS.ProcessEnv, ApproveDeps]>([
  ["an agent shell", { CLAUDECODE: "1" }, terminal(true)],
  ["a Codex shell", { CODEX_SANDBOX: "seatbelt" }, terminal(true)],
  ["no TTY", {}, NO_TTY],
])(
  "Given %s, When workit approve runs, Then it shows the request, asks nothing and records nothing",
  async (_name, env, deps) => {
    const request = createApprovalRequest(FIELDS, { session: null });
    const asked: string[] = [];
    const result = await call([request.id], env, {
      ...deps,
      confirm: async (question) => {
        asked.push(question);
        return true;
      },
    });
    // Exit 0: the host records the user's answer to its own prompt on this call.
    expect(result.code).toBe(0);
    expect(asked).toEqual([]);
    expect(result.out).toContain(request.hash.slice(0, 12));
    expect(result.out).toContain("Not recorded by this shell");
    expect(result.out).toContain(`workit approve ${request.id}`);
    expect(existsSync(grantFile(request.id))).toBe(false);
  },
);

test("Given an unknown or malformed id, Then it fails and records nothing", async () => {
  expect((await call(["ap_zzzzzzzz"], {}, terminal(true))).code).not.toBe(0);
  const bad = await call(["release-4.5.0"], {}, terminal(true));
  expect(bad.code).toBe(2);
  expect(bad.err).toContain("usage: workit approve [<id>…]");
});

// #864: the terminal fallback needs no id when one request waits.
const comment = (text: string): ApprovalFields => ({
  kind: "youtrack-write",
  action: "workit youtrack note X-1",
  target: { tracker: "ytrack:default", issue: "X-1" },
  effect: "posts this comment on X-1",
  subject: { comment: text },
});

test("Given one pending request, When the user runs workit approve with no id at a terminal, Then it shows the full text, asks y/N and records the yes", async () => {
  const text = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");
  const request = createApprovalRequest(comment(text), { session: null });
  const asked: string[] = [];
  const result = await call([], {}, terminal(true, asked));
  expect(result.code).toBe(0);
  for (const line of text.split("\n")) expect(result.out).toContain(line);
  expect(asked).toHaveLength(1);
  expect(existsSync(grantFile(request.id))).toBe(true);
  expect(consumeApproval(comment(text), { session: null, verb: "youtrack note" }).ok).toBe(true);
});

test("Given two pending requests, When workit approve runs with no id, Then it lists both with their ids and records nothing", async () => {
  const one = createApprovalRequest(comment("one"), { session: null });
  const two = createApprovalRequest(comment("two"), { session: null });
  const result = await call([], {}, terminal(true));
  expect(result.code).toBe(2);
  expect(result.err).toContain(one.id);
  expect(result.err).toContain(two.id);
  expect(existsSync(grantFile(one.id)) || existsSync(grantFile(two.id))).toBe(false);
});

test("Given nothing pending, When workit approve runs with no id, Then it says so", async () => {
  const result = await call([], {}, terminal(true));
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("no request is waiting");
});

test("Given an agent shell, When it runs workit approve with no id, Then nothing is recorded and the line names the plain terminal command", async () => {
  const request = createApprovalRequest(comment("agent"), { session: null });
  const result = await call([], { CLAUDECODE: "1" }, terminal(true));
  expect(result.code).toBe(0);
  expect(existsSync(grantFile(request.id))).toBe(false);
  expect(result.out).toContain("runs `workit approve` in a terminal");
  expect(result.out).not.toContain("own terminal");
});
