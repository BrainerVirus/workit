import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin from "../../packages/workit-opencode/src/plugin";
import { REMINDER_TEXT } from "../../packages/workit-core/src/core/reminder";
import {
  HostReceiptStore,
  prepareFlowState,
  recordMenuChoice,
  transitionPlan,
  transitionSpec,
} from "../../packages/workit-core/src/core/flow-state";
import { openEvidence } from "../workit-core/flow-fixtures";

const userMessage = (text: string) => ({
  info: { role: "user" as const, id: "u", sessionID: "s", time: { created: 0, updated: 0 } },
  parts: [
    {
      type: "text" as const,
      text,
      id: "p",
      messageID: "u",
      sessionID: "s",
      time: { created: 0, updated: 0 },
    },
  ],
});

const assistantMessage = (text: string) => ({
  info: { role: "assistant" as const, id: "a", sessionID: "s", time: { created: 0, updated: 0 } },
  parts: [
    {
      type: "text" as const,
      text,
      id: "p",
      messageID: "a",
      sessionID: "s",
      time: { created: 0, updated: 0 },
    },
  ],
});

test("reminder is injected on every user turn (not duplicated)", async () => {
  const hooks = await plugin({
    directory: "/repo",
    worktree: "/repo",
    serverUrl: new URL("http://localhost"),
  } as never);
  const output = { messages: [userMessage("hello")] };
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  const firstText = output.messages[0].parts
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("\n");
  expect(firstText).toContain(REMINDER_TEXT);
  const afterFirst = output.messages[0].parts.length;

  // second turn: no new injections (bootstrap + reminder already present)
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  expect(output.messages[0].parts.length).toBe(afterFirst);
});

test("detection injects correction into the CURRENT turn, repeatably", async () => {
  const hooks = await plugin({
    directory: "/repo",
    worktree: "/repo",
    serverUrl: new URL("http://localhost"),
  } as never);
  const output = {
    messages: [
      userMessage("start"),
      assistantMessage("1. install\n2. configure\n3. both\nWhich one?"),
      userMessage("continue"),
    ],
  };
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  const currentText = output.messages[2].parts
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("\n");
  expect(currentText).toContain("workflow-detection");

  // second violation, later turn: detection fires again (anchored to current turn)
  output.messages.push(assistantMessage("A) x\nB) y\nWhich?"));
  output.messages.push(userMessage("continue 2"));
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  const laterText = output.messages[4].parts
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("\n");
  expect(laterText).toContain("workflow-detection");
});

test("no correction when assistant did not use prose choices", async () => {
  const hooks = await plugin({
    directory: "/repo",
    worktree: "/repo",
    serverUrl: new URL("http://localhost"),
  } as never);
  const output = {
    messages: [assistantMessage("I updated the config."), userMessage("continue")],
  };
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  const userText = output.messages[1].parts.find((p: any) => p.type === "text")!.text;
  expect(userText).not.toContain("workflow-detection");
});

test("CA-21: subagent-driven discovery scans the host workspace, not process.cwd()", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-host-root-"));
  const slug = "host-root";
  // A REAL active subagent-driven flow: discovery is execution-state based, so
  // the fixture must carry valid approval digests and an active execution.
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  const specText = `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`;
  const planText = `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n### Task 1: Do the thing\n\n- [ ] **Step 1:** do it\n`;
  writeFileSync(path.join(root, "docs", slug, "spec.md"), specText);
  writeFileSync(path.join(root, "docs", slug, "plan.md"), planText);
  const store = new HostReceiptStore();
  const sessionId = "hook-session";
  const spec = `docs/${slug}/spec.md`;
  const plan = `docs/${slug}/plan.md`;
  const prep = prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
  if (!prep.ok) throw new Error(prep.error);
  for (const step of [
    transitionSpec(root, slug, spec, openEvidence(store, sessionId, "Approve spec")),
    transitionPlan(root, slug, plan, openEvidence(store, sessionId, "Approve plan")),
  ])
    if (!step.ok) throw new Error(step.error);
  const menu = recordMenuChoice(
    root,
    slug,
    plan,
    "subagent-driven",
    openEvidence(store, sessionId, "subagent-driven"),
  );
  if (!menu.ok) throw new Error(menu.error);
  try {
    const hooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
    } as never);
    const output = { messages: [userMessage("hello")] };
    await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
    const text = output.messages[0].parts
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n");
    expect(text).toContain("workflow-sdd-reminder");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reminder includes the doc delivery rule", () => {
  expect(REMINDER_TEXT).toContain("clickable markdown link");
  expect(REMINDER_TEXT).toContain("3-5 bullet summary");
});

test("hook injects doc-delivery correction on backtick-only refs", async () => {
  const hooks = await plugin({
    directory: "/repo",
    worktree: "/repo",
    serverUrl: new URL("http://localhost"),
  } as never);
  const output = {
    messages: [
      userMessage("start"),
      assistantMessage("Spec is at `docs/x/spec.md`. Please review."),
      userMessage("ok"),
    ],
  };
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  const currentText = output.messages[2].parts
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("\n");
  expect(currentText).toContain("workflow-doc-delivery");
});

test("hook does not correct when markdown link used", async () => {
  const hooks = await plugin({
    directory: "/repo",
    worktree: "/repo",
    serverUrl: new URL("http://localhost"),
  } as never);
  const output = {
    messages: [
      userMessage("start"),
      assistantMessage("See [spec.md](docs/x/spec.md) for details."),
      userMessage("ok"),
    ],
  };
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  const currentText = output.messages[2].parts
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("\n");
  expect(currentText).not.toContain("workflow-doc-delivery");
});
