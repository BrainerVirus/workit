import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin from "../src/plugin";
import { REMINDER_TEXT } from "../src/core/reminder";
import { detectProseChoices } from "../src/core/detector";

const userMessage = (text: string) => ({
  info: { role: "user" as const, id: "u", sessionID: "s", time: { created: 0, updated: 0 } },
  parts: [{ type: "text" as const, text, id: "p", messageID: "u", sessionID: "s", time: { created: 0, updated: 0 } }],
});

const assistantMessage = (text: string) => ({
  info: { role: "assistant" as const, id: "a", sessionID: "s", time: { created: 0, updated: 0 } },
  parts: [{ type: "text" as const, text, id: "p", messageID: "a", sessionID: "s", time: { created: 0, updated: 0 } }],
});

test("reminder is injected on every user turn (not duplicated)", async () => {
  const hooks = await plugin({ directory: "/repo", worktree: "/repo", serverUrl: new URL("http://localhost") } as never);
  const output = { messages: [userMessage("hello")] };
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  const firstText = output.messages[0].parts.find((p: any) => p.type === "text")!.text;
  expect(firstText).toContain(REMINDER_TEXT);
  const afterFirst = output.messages[0].parts.length;

  // second turn: no new injections (bootstrap + reminder already present)
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  expect(output.messages[0].parts.length).toBe(afterFirst);
});

test("detection injects correction into the CURRENT turn, repeatably", async () => {
  const hooks = await plugin({ directory: "/repo", worktree: "/repo", serverUrl: new URL("http://localhost") } as never);
  const output = {
    messages: [
      userMessage("start"),
      assistantMessage("1. install\n2. configure\n3. both\nWhich one?"),
      userMessage("continue"),
    ],
  };
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  const currentText = output.messages[2].parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
  expect(currentText).toContain("workflow-detection");

  // second violation, later turn: detection fires again (anchored to current turn)
  output.messages.push(assistantMessage("A) x\nB) y\nWhich?"));
  output.messages.push(userMessage("continue 2"));
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  const laterText = output.messages[4].parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
  expect(laterText).toContain("workflow-detection");
});

test("no correction when assistant did not use prose choices", async () => {
  const hooks = await plugin({ directory: "/repo", worktree: "/repo", serverUrl: new URL("http://localhost") } as never);
  const output = {
    messages: [
      assistantMessage("I updated the config."),
      userMessage("continue"),
    ],
  };
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  const userText = output.messages[1].parts.find((p: any) => p.type === "text")!.text;
  expect(userText).not.toContain("workflow-detection");
});


test("reminder includes the doc delivery rule", () => {
  expect(REMINDER_TEXT).toContain("clickable markdown link");
  expect(REMINDER_TEXT).toContain("3-5 bullet summary");
});
