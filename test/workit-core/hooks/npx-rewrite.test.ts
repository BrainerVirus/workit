// A weak model runs `npx -y @workit-dev/cli <verb> …` though `workit` is on
// PATH; no allow rule matches it. Hosts that rewrite run the `workit …` call,
// hosts that only deny name it.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { npxWorkit } from "@/packages/workit-core/src/hooks/cwd-normalize";
import {
  CLAUDE_CODE_DESCRIPTOR,
  CODEX_DESCRIPTOR,
  CURSOR_DESCRIPTOR,
  handleHook,
  OPENCODE_DESCRIPTOR,
  PI_DESCRIPTOR,
  type HookInput,
} from "@/packages/workit-core/src/hooks/index";
import type { HostDescriptor } from "@/packages/workit-core/src/hooks/descriptor";

const dirs: string[] = [];
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const withWorkit = temp("workit-npx-bin-");
writeFileSync(path.join(withWorkit, "workit"), "#!/bin/sh\n");
chmodSync(path.join(withWorkit, "workit"), 0o755);
const withoutWorkit = temp("workit-npx-empty-");
const savedPath = process.env.PATH;
beforeEach(() => {
  process.env.PATH = withWorkit;
});
afterEach(() => {
  process.env.PATH = savedPath;
});

const COMMIT = "workit git commit -m x -- a.ts";
test.each([
  ["npx -y @workit-dev/cli git commit -m x -- a.ts", COMMIT],
  ["npx @workit-dev/cli git commit -m x -- a.ts", COMMIT],
  ["npx --yes @workit-dev/cli git commit -m x -- a.ts", COMMIT],
  ["npx -y @workit-dev/cli@1.7.0 git commit -m x -- a.ts", COMMIT],
  [
    "cd /tmp/wt && npx -y @workit-dev/cli git commit -m x -- a.ts",
    "workit git --cwd /tmp/wt commit -m x -- a.ts",
  ],
  ["npx -y @workit-dev/cli --cwd /tmp/wt git status", "workit git --cwd /tmp/wt status"],
  [
    `npx -y @workit-dev/cli git commit -m "a && b" -- a.ts`,
    `workit git commit -m "a && b" -- a.ts`,
  ],
])("`%s` is the call `%s`", (command, call) => {
  expect(npxWorkit(command)).toBe(call);
});

test.each([
  ["npx -y prettier --check ."],
  ["npx -y @workit-dev/cli-other git status"],
  [`workit git commit -m "npx -y @workit-dev/cli git status" -- a.ts`],
  [`git commit -m "run npx -y @workit-dev/cli check lint"`],
  ["npx -y @workit-dev/cli git status && npx -y @workit-dev/cli git log"],
  ["echo hi; npx -y @workit-dev/cli git status"],
])("`%s` is left alone", (command) => {
  expect(npxWorkit(command)).toBeNull();
});

const shellPre = (descriptor: HostDescriptor, host: HookInput["host"], command: string) => {
  const root = temp("workit-npx-repo-");
  spawnSync("git", ["init", "-q", "-b", "feature/x"], { cwd: root });
  return handleHook(
    {
      host,
      cwd: root,
      session: { id: `s-${crypto.randomUUID()}`, agentId: null, agentType: null, parentId: null },
      permissionMode: null,
      transcriptPath: null,
      event: { kind: "shell.pre", command, toolUseId: null },
    },
    { descriptor, addendum: null },
  );
};

const NPX = "npx -y @workit-dev/cli git commit -m x -- a.ts";
const REWRITERS: Array<[HostDescriptor, HookInput["host"]]> = [
  [CLAUDE_CODE_DESCRIPTOR, "claude_code"],
  [OPENCODE_DESCRIPTOR, "opencode"],
  [PI_DESCRIPTOR, "pi"],
];
const DENIERS: Array<[HostDescriptor, HookInput["host"]]> = [
  [CODEX_DESCRIPTOR, "codex_cli"],
  [CURSOR_DESCRIPTOR, "cursor"],
];

test.each(REWRITERS)("%#: a rewriting host runs the workit call", (descriptor, host) => {
  const decision = shellPre(descriptor, host, NPX);
  expect(decision.kind).toBe("rewrite");
  expect(decision.kind === "rewrite" && decision.command).toBe(COMMIT);
});

test.each(DENIERS)("%#: a deny-only host names the workit call", (descriptor, host) => {
  const decision = shellPre(descriptor, host, NPX);
  expect(decision.kind).toBe("deny");
  expect(decision.kind === "deny" && decision.reason).toContain(`\`${COMMIT}\``);
});

test.each([...REWRITERS, ...DENIERS])(
  "%#: without workit on PATH npx is left alone",
  (descriptor, host) => {
    process.env.PATH = withoutWorkit;
    const decision = shellPre(descriptor, host, NPX);
    expect(decision.kind === "rewrite" || decision.kind === "deny").toBe(false);
  },
);

test("npx of another package is not touched on any host", () => {
  for (const [descriptor, host] of [...REWRITERS, ...DENIERS]) {
    const decision = shellPre(descriptor, host, "npx -y cowsay hi");
    expect(decision.kind === "rewrite" || decision.kind === "deny", host).toBe(false);
  }
});

// The npx spelling gets the plain call's decision from every gate: an ask or
// deny verbatim; a pass becomes the plain call (rewrite, or a deny naming it).
const GATED = [
  "workit pr merge --unverified",
  "workit git push --overwrite-unintegrated",
  "workit grant set foo",
  "workit grant raise foo",
  "workit ledger void abc",
  "workit release notes approve",
  "workit approve ap_abcdefgh",
];
const HOSTS = [...REWRITERS, ...DENIERS];
const APPROVE_STEP = new Set(["claude_code", "pi"]);

test.each(GATED.flatMap((plain) => HOSTS.map(([d, host]) => [plain, host, d] as const)))(
  "`%s` on %s: the npx spelling gets the plain call's decision",
  (plain, host, descriptor) => {
    const want = shellPre(descriptor, host, plain);
    const got = shellPre(
      descriptor,
      host,
      `npx -y @workit-dev/cli ${plain.slice("workit ".length)}`,
    );
    if (plain.startsWith("workit approve ") && APPROVE_STEP.has(host)) {
      // The host's approve step asks and records only on the plain call: name it.
      expect(got.kind).toBe("deny");
      expect(got.kind === "deny" && got.unblock).toBe(plain);
      return;
    }
    if (want.kind !== "none" && want.kind !== "context") return expect(got).toEqual(want);
    if (REWRITERS.some(([, h]) => h === host))
      expect(got).toMatchObject({ kind: "rewrite", command: plain });
    else expect(got).toMatchObject({ kind: "deny", unblock: plain });
  },
);
