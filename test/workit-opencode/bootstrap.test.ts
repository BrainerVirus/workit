import { describe, expect, test } from "bun:test";
import path from "node:path";
import { getWorkitBootstrap, isWorkitBootstrap } from "@/packages/workit-opencode/src/bootstrap";
import { server as plugin } from "@/packages/workit-opencode/src/index";
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

  test("bootstrap tells lead to start and assess on empty task list", () => {
    const bootstrap = getWorkitBootstrap() ?? "";
    expect(bootstrap.toLowerCase()).toContain("task.start");
    expect(bootstrap.toLowerCase()).toContain("policy.assess");
    expect(bootstrap.toLowerCase()).toMatch(/empty|no session/);
  });

  test("messages.transform injects bootstrap once on first user turn", async () => {
    const hooks = await plugin({
      directory: "/repo",
      worktree: "/repo",
      serverUrl: new URL("http://localhost"),
      client: {
        session: { get: async () => ({ data: { id: "s1", directory: "/repo" } }) },
      },
    } as never);
    const output = {
      messages: [
        {
          info: {
            role: "user" as const,
            id: "m1",
            sessionID: "s1",
            time: { created: 0, updated: 0 },
          },
          parts: [
            {
              type: "text" as const,
              text: "hello",
              id: "p1",
              messageID: "m1",
              sessionID: "s1",
              time: { created: 0, updated: 0 },
            },
          ],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
    const texts = output.messages[0].parts.map((p: any) => p.text ?? "");
    expect(texts.some((t: string) => isWorkitBootstrap(t))).toBe(true);
    expect(texts[texts.length - 1]).toBe("hello");
    const afterFirst = output.messages[0].parts.length;

    await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
    expect(output.messages[0].parts.length).toBe(afterFirst);
  });

  test("messages.transform refreshes context on later agent-loop calls", async () => {
    const hooks = await plugin({
      directory: "/repo",
      worktree: "/repo",
      serverUrl: new URL("http://localhost"),
      client: {
        session: { get: async () => ({ data: { id: "s2", directory: "/repo" } }) },
      },
    } as never);
    const loop = (text: string) => ({
      messages: [
        {
          info: {
            role: "user" as const,
            id: "m1",
            sessionID: "s2",
            time: { created: 0, updated: 0 },
          },
          parts: [
            {
              type: "text" as const,
              text,
              id: "p1",
              messageID: "m1",
              sessionID: "s2",
              time: { created: 0, updated: 0 },
            },
          ],
        },
      ],
    });
    const first = loop("hello");
    await hooks["experimental.chat.messages.transform"]?.({} as never, first as never);
    expect(first.messages[0].parts.some((p: any) => isWorkitBootstrap(p.text ?? ""))).toBe(true);

    const second = loop("continue");
    await hooks["experimental.chat.messages.transform"]?.({} as never, second as never);
    const texts = second.messages[0].parts.map((p: any) => p.text ?? "");
    expect(texts.some((t: string) => isWorkitBootstrap(t))).toBe(true);
    expect(texts[texts.length - 1]).toBe("continue");
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
