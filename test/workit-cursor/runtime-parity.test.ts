import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const CURSOR = path.join(ROOT, "packages/workit-cursor");

test("Cursor ships one shared native hook entry and no legacy flow evidence", () => {
  expect(existsSync(path.join(CURSOR, "hooks/workit-hook.ts"))).toBe(true);
  expect(existsSync(path.join(CURSOR, "mcp/flow-evidence.ts"))).toBe(false);
  expect(readFileSync(path.join(CURSOR, "mcp/server.ts"), "utf8")).not.toContain("zod");
});
