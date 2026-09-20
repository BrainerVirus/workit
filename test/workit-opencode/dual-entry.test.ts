import { expect, test } from "bun:test";
import entry from "@/packages/workit-opencode/src/plugin";
import index, { server } from "@/packages/workit-opencode/src/index";
import v1 from "@/packages/workit-opencode/src/v1/server";

test("the checkout path re-exports the dual index entry", () => {
  expect(entry).toBe(index);
  expect(Object.keys(entry).sort()).toEqual(["server"]);
  expect(typeof entry.server).toBe("function");
});

test("the index server is the V1 adapter", () => {
  expect(server).toBe(v1);
  expect(index.server).toBe(v1);
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
