import { expect, test } from "bun:test";
import { SUPPORT_MATRIX } from "@/packages/workit-core/src/core/support-matrix";
import entry from "@/packages/workit-opencode/src/plugin";
import index from "@/packages/workit-opencode/src/index";
import v2 from "@/packages/workit-opencode/src/v2/plugin";

test("the checkout path and the package index export only the V2 setup() entry", async () => {
  expect(entry).toBe(index);
  expect(index).toBe(v2);
  expect(Object.keys(entry).toSorted()).toEqual(["id", "setup"]);
  expect(entry.id).toBe("workit");
  expect(typeof entry.setup).toBe("function");
  expect(entry).not.toHaveProperty("server");
  expect(Object.keys(await import("@/packages/workit-opencode/src/plugin"))).toEqual(["default"]);
  expect(Object.keys(await import("@/packages/workit-opencode/src/index"))).toEqual(["default"]);
});

test("the declared OpenCode floor is the V2 plugin API", () => {
  // V1 hosts (1.x) cannot load a setup()-only entry, so the floor is 2.x.
  expect(SUPPORT_MATRIX.opencode.minimum.startsWith("2.")).toBe(true);
});
