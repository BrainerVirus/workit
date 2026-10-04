import { describe, expect, test } from "bun:test";
import path from "node:path";
import { getWorkitBootstrap } from "@/packages/workit-opencode/src/bootstrap";
import { pluginSourceFiles } from "@/packages/workit-opencode/src/stale-sources";

describe("session bootstrap", () => {
  test("bootstrap contract names the native operation families", () => {
    const bootstrap = getWorkitBootstrap();
    expect(bootstrap).toContain("<workit-contract>");
    for (const operation of [
      "task",
      "policy",
      "evidence",
      "finding",
      "decision",
      "worker",
      "writer",
      "state",
    ])
      expect(bootstrap).toContain(operation);
    expect(bootstrap).not.toContain("workflow-sdd-reminder");
  });

  test("bootstrap keeps task tracking optional for explicit objectives", () => {
    const bootstrap = getWorkitBootstrap() ?? "";
    expect(bootstrap.toLowerCase()).toContain("ordinary investigation");
    expect(bootstrap.toLowerCase()).toContain("explicit tracked objective");
    expect(bootstrap.toLowerCase()).not.toContain("task.start");
    expect(bootstrap.toLowerCase()).not.toContain("policy.assess");
  });

  test("bootstrap directs OpenCode mutations to native host tools", () => {
    const bootstrap = getWorkitBootstrap() ?? "";
    expect(bootstrap).toContain("workit_context");
    expect(bootstrap).toContain("no managed external-action executor");
  });
});

describe("stale-source markers", () => {
  test("resolve the real core sources in the plugin layout", () => {
    expect(pluginSourceFiles.length).toBeGreaterThanOrEqual(8);
    expect(
      pluginSourceFiles.some((file) =>
        file.endsWith(path.join("workit-core", "src", "core", "task-contract.ts")),
      ),
    ).toBe(true);
    expect(
      pluginSourceFiles.some((file) => file.endsWith(path.join("workit-core", "src", "core.ts"))),
    ).toBe(true);
    expect(pluginSourceFiles.some((file) => file.endsWith("plugin.ts"))).toBe(true);
    expect(pluginSourceFiles.some((file) => file.endsWith("external-action-effects.ts"))).toBe(
      true,
    );
    expect(pluginSourceFiles.some((file) => file.endsWith(path.join("v2", "lifecycle.ts")))).toBe(
      true,
    );
    expect(pluginSourceFiles.some((file) => file.endsWith(path.join("v2", "receipts.ts")))).toBe(
      true,
    );
  });
});
