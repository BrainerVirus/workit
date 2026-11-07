// Retro R5: verifiers recorded `verified` with the configured checks missing
// ("recorded as missing") after ad-hoc runs, so the lead re-ran the suite
// before merge. The judge's SubagentStart names each configured check, and the
// verdict is refused until each has a fresh passing run on the head.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { appendObserved } from "@/packages/workit-core/src/ledger";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { fixture, tempRoot } from "./hooks/hook-fixtures";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

let state: string | undefined;
beforeEach(() => {
  state = process.env.WORKIT_STATE_DIR;
  const dir = tempRoot("workit-verdict-checks-state-");
  roots.push(dir);
  process.env.WORKIT_STATE_DIR = dir;
});
afterEach(() => {
  if (state === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = state;
});

const git = (cwd: string, ...args: string[]): string =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  }).stdout.trim();

/** feature/x off main with a change large enough to need a verdict, configured checks test and lint. */
const repo = (): string => {
  const root = tempRoot("workit-verdict-checks-");
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { test: "x", lint: "y" } }),
  );
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "feature/x");
  writeFileSync(
    path.join(root, "big.ts"),
    Array.from({ length: 150 }, (_, index) => `export const v${index} = ${index};`).join("\n"),
  );
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "behavior change");
  return root;
};

const passed = (root: string, name: string) =>
  appendObserved(root, {
    type: "check",
    actor: { host: "cli", session: "claude-session-1", agentId: null },
    branch: "feature/x",
    head: git(root, "rev-parse", "HEAD"),
    name,
    result: "passed",
  });

const startText = (root: string): string =>
  (
    dispatchHook(
      claudeCodeAdapter,
      fixture("claude-code", "subagent-start", root, {
        agent_type: "workit:verifier",
        agent_id: "agent-1",
      }),
      {},
    ).json as { hookSpecificOutput?: { additionalContext?: string } }
  ).hookSpecificOutput?.additionalContext ?? "";

/** Records `verified` with the exact line the verifier's SubagentStart handed it. */
const verify = async (text: string, root: string) => {
  const line = /`(workit ledger verdict <verified\|failed\|blocked> [^`]*)`/u.exec(text)?.[1] ?? "";
  const argv = line
    .replace("<verified|failed|blocked>", "verified")
    .replace("<live|unit>", "live")
    .replace('--how "<what you ran and saw>"', "")
    .split(" ")
    .filter(Boolean)
    .slice(1);
  let stdout = "";
  let stderr = "";
  const code = await main([...argv, "--how", "ran it", "--json"], {
    cwd: root,
    env: {
      ...process.env,
      WORKIT_HOST: "claude_code",
      WORKIT_SESSION_ID: "claude-session-1",
    },
    stdout: (out) => void (stdout += out),
    stderr: (out) => void (stderr += out),
  });
  return { code, stderr, json: JSON.parse(stdout) };
};

test("Given configured checks test and lint, When a verifier starts, Then its SubagentStart text names `workit check test` and `workit check lint`", () => {
  const text = startText(repo());
  expect(text).toContain("`workit check test`");
  expect(text).toContain("`workit check lint`");
});

test("Given configured checks test and lint and no fresh lint run at the head, When the verifier records verified, Then it exits non-zero naming `workit check lint` and records nothing", async () => {
  const root = repo();
  passed(root, "test");
  const result = await verify(startText(root), root);
  expect(result.code).not.toBe(0);
  expect(result.json.error).toContain("lint");
  expect(result.json.error).not.toContain("recorded as missing");
  expect(result.json.unblock).toStartWith("workit check lint on this head");
  expect(result.json.unblock).not.toContain("workit check test");
});

test("Given fresh passing runs of test and lint at the head, When the verifier records verified, Then it records with no missing note", async () => {
  const root = repo();
  passed(root, "test");
  passed(root, "lint");
  const result = await verify(startText(root), root);
  expect(result.code).toBe(0);
  expect(result.stderr).not.toContain("missing");
  expect(result.json.data.checkEvidence).toEqual([
    { name: "test", status: "fresh", via: "local" },
    { name: "lint", status: "fresh", via: "local" },
  ]);
});
