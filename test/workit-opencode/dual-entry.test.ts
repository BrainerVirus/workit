import { expect, test } from "bun:test";
import { SUPPORT_MATRIX } from "@/packages/workit-core/src/core/support-matrix";
import entry from "@/packages/workit-opencode/src/plugin";
import index, { server } from "@/packages/workit-opencode/src/index";
import v1 from "@/packages/workit-opencode/src/v1/server";

test("the checkout path re-exports the dual index entry", () => {
  expect(entry).toBe(index);
  expect(Object.keys(entry).sort()).toEqual(["id", "server", "setup"]);
  expect(entry.id).toBe("workit");
  expect(typeof entry.server).toBe("function");
  expect(typeof entry.setup).toBe("function");
});

test("the index server is the V1 adapter", () => {
  expect(server).toBe(v1);
  expect(index.server).toBe(v1);
});

test("the declared OpenCode floor covers the object-form entrypoint", () => {
  // The dual object entry exists only from 1.18.29; a lower floor would let a
  // host pass doctor while being unable to load the entry shape.
  expect(SUPPORT_MATRIX.opencode.minimum).toBe("1.18.30");
});

test("V1 behavior is unchanged through the dual entry", async () => {
  const hooks = await entry.server({
    directory: "/repo",
    worktree: "/repo",
    serverUrl: new URL("http://localhost"),
  } as never);
  expect(Object.keys(hooks.tool ?? {}).sort()).toEqual(
    [
      "workit_task",
      "workit_policy",
      "workit_evidence",
      "workit_finding",
      "workit_decision",
      "workit_worker",
      "workit_writer",
      "workit_state",
      "workit_external_action",
      "workit_init_apply",
    ].sort(),
  );
});
