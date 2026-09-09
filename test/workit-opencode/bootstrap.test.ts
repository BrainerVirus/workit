import { describe, expect, test } from "bun:test";
import {
  getWorkitBootstrap,
  isWorkitBootstrap,
} from "../../packages/workit-opencode/src/bootstrap";
import plugin from "../../packages/workit-opencode/src/plugin";

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
});
