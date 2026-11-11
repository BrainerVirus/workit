import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { invariantBootstrap } from "@/packages/workit-core/src/core";
import {
  OPENCODE_DESCRIPTOR,
  claudeCodeAdapter,
  dispatchHook,
  sessionContextText,
} from "@/packages/workit-core/src/hooks/index";
import { OPENCODE_ADDENDUM, getWorkitBootstrap } from "@/packages/workit-opencode/src/bootstrap";
import { fixture, tempRoot } from "@/test/workit-core/hooks/hook-fixtures";

// #793: OpenCode's model reads the contract in the same closed tag as Claude Code's.
let root = "";
let savedState: string | undefined;
beforeEach(() => {
  root = tempRoot("workit-contract-parity-");
  savedState = process.env.WORKIT_STATE_DIR;
  process.env.WORKIT_STATE_DIR = tempRoot("workit-contract-parity-state-");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedState === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = savedState;
});

const block = /^<workit-contract>\n([\s\S]*)\n<\/workit-contract>$/u;

test("OpenCode renders the contract exactly as Claude Code's renderer does for its host", () => {
  const rendered = sessionContextText(
    {
      host: "opencode",
      cwd: root,
      session: { id: "ses_parity", agentId: null, agentType: null, parentId: null },
      permissionMode: null,
      transcriptPath: null,
      event: { kind: "session.start", source: "compact" },
    },
    OPENCODE_DESCRIPTOR,
    { offer: false, addendum: OPENCODE_ADDENDUM },
  );
  expect(getWorkitBootstrap()).toBe(rendered);
});

test("both hosts wrap the same contract body in one closed <workit-contract> block", () => {
  const claude = (
    dispatchHook(claudeCodeAdapter, fixture("claude-code", "session-start-compact", root), {})
      .json as { hookSpecificOutput: { additionalContext: string } }
  ).hookSpecificOutput.additionalContext;
  const opencode = getWorkitBootstrap() ?? "";
  for (const text of [claude, opencode]) {
    expect(text).toMatch(block);
    expect(block.exec(text)?.[1]).toStartWith(`${invariantBootstrap()}\n`);
  }
});
