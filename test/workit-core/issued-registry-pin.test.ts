// #980: the issued-session registry was found through the CLI's own env
// (WORKIT_STATE_DIR, the XDG state dir), so an agent could build a fake
// registry under another dir with mkdir and sha256sum, point one `workit
// ledger verdict` at it and record a bound verdict the real gate accepted.
// The host's hooks now pin each checkout to their state dir (in its guarded
// ledger dir), and every trust decision reads the registry there.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_CODE_DESCRIPTOR,
  handleHook,
  type HookInput,
} from "@/packages/workit-core/src/hooks/index";
import { ISSUED_SESSIONS_MARKER } from "@/packages/workit-core/src/host-session";
import { insideTempDir } from "@/packages/workit-core/src/store/folder-store";
import { recordVerdict } from "@/packages/workit-core/src/ledger";

setDefaultTimeout(60_000);

const MAIN = path.resolve(import.meta.dir, "../../packages/workit-cli/src/main.ts");
const dirs: string[] = [];
const temp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

// The host's state dir (the hooks' env) and the one an agent redirects a call to.
const runState = process.env.WORKIT_STATE_DIR;
const hostState = temp("wk-pin-host-state-");
beforeAll(() => {
  process.env.WORKIT_STATE_DIR = hostState;
});
afterAll(() => {
  if (runState === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = runState;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

const featureRepo = (): string => {
  const root = temp("wk-pin-repo-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "README.md"), "# app\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-qb", "feature/x");
  writeFileSync(path.join(root, "app.ts"), "export const x = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "feature");
  return root;
};

const hookInput = (cwd: string, lead: string, event: HookInput["event"]): HookInput => ({
  host: "claude_code",
  cwd,
  session: { id: lead, agentId: null, agentType: null, parentId: null },
  permissionMode: "default",
  transcriptPath: null,
  event,
});

/** Claude Code's SubagentStart for a reviewer: its issued id and token, from the hook's text. */
const spawnReviewer = (cwd: string, lead: string, agentId: string) => {
  const decision = handleHook(
    hookInput(cwd, lead, {
      kind: "subagent.start",
      agentId,
      agentType: "workit:reviewer",
      task: null,
    }),
    { descriptor: CLAUDE_CODE_DESCRIPTOR, addendum: null },
  );
  const text = decision.kind === "context" ? decision.text : "";
  const token = /--token=([0-9a-f]+)/u.exec(text)?.[1];
  if (!token) throw new Error(`no token in the SubagentStart text: ${text}`);
  return { id: `${lead}:${agentId}`, token };
};

/** The real CLI in its own process, so WORKIT_STATE_DIR is its env as an agent's shell sets it. */
const cli = (cwd: string, argv: string[], env: Record<string, string>) => {
  const base = { ...process.env };
  for (const key of ["WORKIT_SESSION_ID", "WORKIT_SESSION_TOKEN", "WORKIT_HOST", "WORKIT_AGENT_ID"])
    delete base[key];
  const run = spawnSync(process.execPath, [MAIN, ...argv, "--json"], {
    cwd,
    encoding: "utf8",
    env: { ...base, WORKIT_STATE_DIR: hostState, ...env },
    timeout: 60_000,
  });
  let body: { ok?: boolean; error?: string; data?: Record<string, unknown> } = {};
  try {
    body = JSON.parse(run.stdout);
  } catch {
    // Not JSON: the assertions below print stderr.
  }
  return { code: run.status, body, stderr: run.stderr };
};

const lead = (session: string) => ({ WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: session });

const review = (result: string, session: string, token: string | null) => [
  "ledger",
  "verdict",
  result,
  "--kind",
  "review",
  "--branch",
  "feature/x",
  "--session",
  session,
  ...(token ? [`--token=${token}`] : []),
  "--how",
  `${result} by ${session}`,
];

const accepted = (cwd: string, env: Record<string, string> = {}) => {
  const check = cli(cwd, ["ledger", "check", "--branch", "feature/x"], env);
  expect(check.code, check.stderr).toBe(0);
  return check.body.data?.accepted as { accepted: boolean; reasons?: string[] };
};

const sha = (value: string, length = 64) =>
  createHash("sha256").update(value).digest("hex").slice(0, length);

/** What the agent builds with mkdir and sha256sum: a registry under `alt` that binds `id` to `token`. */
const forgeRegistry = (alt: string, session: string, id: string, token: string | null) => {
  const issued = path.join(alt, "issued", sha(session, 32));
  mkdirSync(issued, { recursive: true });
  writeFileSync(path.join(issued, sha(id, 32)), `${ISSUED_SESSIONS_MARKER}\n`);
  if (token === null) return;
  const tokens = path.join(alt, "issued-tokens", sha(session, 32));
  mkdirSync(tokens, { recursive: true });
  writeFileSync(path.join(tokens, sha(id, 32)), `${sha(token)}\n`);
};

test("Given a session start, Then the checkout's guarded ledger dir pins the host's state dir", () => {
  const root = featureRepo();
  handleHook(hookInput(root, "s-pin", { kind: "session.start", source: "startup" }), {
    descriptor: CLAUDE_CODE_DESCRIPTOR,
    addendum: null,
  });
  const pin = path.join(root, ".git", "workit", "ledger", "issued-registry");
  expect(readFileSync(pin, "utf8").trim()).toBe(hostState);
});

test("Given a reviewer's bound failed verdict, When an agent forges a registry under a redirected WORKIT_STATE_DIR and records a bound verified verdict, Then the record is refused and the gate under either dir keeps the failure", () => {
  const root = featureRepo();
  const session = `s-${crypto.randomUUID()}`;
  const reviewer = spawnReviewer(root, session, "rev-1");
  const failed = cli(root, review("failed", reviewer.id, reviewer.token), lead(session));
  expect(failed.code, failed.stderr).toBe(0);

  const alt = temp("wk-pin-alt-state-");
  const forged = `${session}:evil`;
  forgeRegistry(alt, session, forged, "attacker-token");
  const attack = cli(root, review("verified", forged, "attacker-token"), {
    ...lead(session),
    WORKIT_STATE_DIR: alt,
  });
  expect(attack.code).not.toBe(0);
  expect(attack.body.error).toMatch(/forged_session|unissued_session|unbound_session/u);

  for (const env of [{}, { WORKIT_STATE_DIR: alt }] as Record<string, string>[]) {
    expect(accepted(root, env).accepted, JSON.stringify(env)).toBe(false);
    const listed = cli(root, ["ledger", "list"], env);
    expect(JSON.stringify(listed.body)).not.toContain(forged);
  }
});

test("Given a row an issued id never bound, When the gate runs under a state dir holding a token-less record of that id, Then the row is still refused", () => {
  const root = featureRepo();
  const session = `s-${crypto.randomUUID()}`;
  const reviewer = spawnReviewer(root, session, "rev-2");
  // A row recorded without the token (an older CLI, or another session that read the id).
  const row = recordVerdict(
    {
      cwd: root,
      actor: { host: "claude_code", session: reviewer.id, agentId: null },
      sessionSource: "flag",
      branch: "feature/x",
    },
    { result: "verified", how: "no token" },
  );
  expect(row.ok).toBe(true);
  const alt = temp("wk-pin-alt-legacy-");
  forgeRegistry(alt, session, reviewer.id, null);
  for (const env of [{}, { WORKIT_STATE_DIR: alt }] as Record<string, string>[]) {
    const verdict = accepted(root, env);
    expect(verdict.accepted, JSON.stringify(env)).toBe(false);
    expect(verdict.reasons, JSON.stringify(env)).toContain("unbound_session");
  }
});

test("Given the legitimate flows, When recorded from the host's or a redirected state dir, Then a tokened reviewer, --self, CI and a Cursor declared session still record, and the tokened one passes the gate", () => {
  const root = featureRepo();
  const session = `s-${crypto.randomUUID()}`;
  const reviewer = spawnReviewer(root, session, "rev-3");
  const alt = temp("wk-pin-alt-legit-");
  // The token is checked against the pinned registry, whatever dir the call's env names.
  const tokened = cli(root, review("verified", reviewer.id, reviewer.token), {
    ...lead(session),
    WORKIT_STATE_DIR: alt,
  });
  expect(tokened.code, JSON.stringify(tokened.body)).toBe(0);
  expect(tokened.body.data?.sessionBound).toBe(true);
  expect(accepted(root).accepted).toBe(true);
  expect(accepted(root, { WORKIT_STATE_DIR: alt }).accepted).toBe(true);

  const self = cli(
    root,
    [
      "ledger",
      "verdict",
      "verified",
      "--kind",
      "unit",
      "--branch",
      "feature/x",
      "--self",
      "--how",
      "own run",
    ],
    { ...lead(session), WORKIT_STATE_DIR: alt },
  );
  expect(self.code, JSON.stringify(self.body)).toBe(0);
  // CI (no host) and a Cursor shell (no host: its context names the id to prefix), unissued ids.
  for (const declared of ["ci-run-42", "cursor-conv-7"]) {
    const other = featureRepo();
    for (const env of [{}, { WORKIT_STATE_DIR: alt }] as Record<string, string>[]) {
      const run = cli(
        other,
        [
          "ledger",
          "verdict",
          "verified",
          "--kind",
          "unit",
          "--branch",
          "feature/x",
          "--how",
          "ran",
        ],
        { WORKIT_SESSION_ID: declared, ...env },
      );
      expect(run.code, `${declared} ${JSON.stringify(run.body)}`).toBe(0);
    }
    expect(accepted(other).accepted, declared).toBe(true);
  }
});

test.skipIf(process.platform === "win32")(
  "Given the temp dir under another spelling (a link, as Windows' 8.3 RUNNER~1 is), Then a checkout in it is inside it, and its parent is not",
  () => {
    const real = temp("wk-pin-tmp-real-");
    const link = `${real}-link`;
    symlinkSync(real, link);
    dirs.push(link);
    const repo = path.join(real, "repo", ".git");
    mkdirSync(repo, { recursive: true });
    expect(insideTempDir(repo, link)).toBe(true);
    expect(insideTempDir(path.join(link, "repo", ".git"), real)).toBe(true);
    expect(insideTempDir(real, link)).toBe(false);
    expect(insideTempDir(path.dirname(real), link)).toBe(false);
  },
);
