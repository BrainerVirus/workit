// #780 fix round (verdict mwdbd0km): nesting past the analysis depth never lets
// a ytrack write through. Three levels of `bash -c` are judged like the plain
// write; deeper nesting whose text names ytrack is denied as unanalysable.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { ytrackGate } from "@/packages/workit-core/src/hooks/ytrack-guard";
import { tempRoot } from "./hook-fixtures";

const base = realpathSync(tempRoot("workit-ytrack-nesting-"));
const root = path.join(base, "repo");
mkdirSync(root, { recursive: true });
beforeEach(() => {
  process.env.WORKIT_CONFIG_DIR = path.join(base, "config");
  process.env.WORKIT_STATE_DIR = path.join(base, "state");
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
/** `levels` nested `bash -c` around `inner`. */
const nested = (inner: string, levels: number): string =>
  levels === 0 ? inner : nested(`bash -c ${quote(inner)}`, levels - 1);
const write = "ytrack issue comment X-1 --body hi";

test("G a ytrack write in three levels of bash -c, W the hook judges it, T it names the workit call", () => {
  const out = ytrackGate(root, nested(write, 3), "posix", false);
  expect(out?.kind).toBe("deny");
  expect(out?.kind === "deny" ? out.reason : "").toContain(
    "`workit youtrack note X-1 --markdown hi`",
  );
});

test("G a ytrack write nested six levels deep, W the hook judges it, T it is denied, never passed", () => {
  for (const command of [nested(write, 6), `${"eval ".repeat(8)}${write}`])
    for (const ask of [true, false])
      expect(ytrackGate(root, command, "posix", ask)?.kind, command).toBe("deny");
  // Deep nesting that only mentions ytrack in an echo is still read as a mention.
  expect(ytrackGate(root, nested("echo ytrack", 3), "posix", false)).toBeNull();
});
