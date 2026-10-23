import { expect, test } from "bun:test";
import { cursorAdapter } from "@/packages/workit-core/src/hooks/index";
import type { HookInput } from "@/packages/workit-core/src/hooks/protocol";

const withSession = (id: string): HookInput => ({ session: { id } }) as unknown as HookInput;

test("G a Cursor session id, W the session addendum is built, T agents are told `workit --session <id> …` with no leading env assignment", () => {
  const text = cursorAdapter.addendum?.(withSession("conv-42")) ?? "";
  expect(text).toContain("workit --session conv-42 git commit");
  expect(text).not.toContain("WORKIT_SESSION_ID=");
});

test("G no session id, W the addendum is built, T there is none", () => {
  expect(cursorAdapter.addendum?.(withSession(""))).toBeNull();
});
