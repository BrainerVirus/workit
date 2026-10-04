import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDoctor } from "@/packages/workit-core/src/core/doctor";
import { binDirWithRuntimes } from "@/test/shared/helpers/doctor-fixture";
import { NativeReceiptStore } from "@/packages/workit-opencode/src/tools/workit";

test("unrelated approval-sounding questions do not create receipts", () => {
  const receipts = new NativeReceiptStore();
  receipts.record(
    {
      sessionID: "s",
      callID: "arbitrary",
      args: { questions: [{ question: "Should I approve access?", options: ["yes"] }] },
    },
    { metadata: { answers: [["yes"]] } },
  );
  expect(receipts.consume("s", "decision").ok).toBe(false);
});

test("native receipts only accept a selected Workit option label", () => {
  const receipts = new NativeReceiptStore();
  receipts.record(
    {
      sessionID: "s",
      callID: "decision",
      args: {
        questions: [
          {
            header: "Workit decision: design",
            question: "Approve this change?",
            options: ["approved", "rejected"],
          },
        ],
      },
    },
    { metadata: { answers: [["yes"]] } },
  );
  expect(receipts.consume("s", "decision").ok).toBe(false);
});

test("native receipts bind OpenCode option objects by their exact labels", () => {
  const receipts = new NativeReceiptStore();
  receipts.record(
    {
      sessionID: "s",
      callID: "decision",
      args: {
        questions: [
          {
            header: "Workit decision: design",
            question: "Approve this change?",
            options: [
              { label: "approved", description: "Allow it" },
              { label: "rejected", description: "Reject this decision" },
            ],
          },
        ],
      },
    },
    { metadata: { answers: [["approved"]] } },
  );
  expect(receipts.consume("s", "decision").ok).toBe(true);
});

test("native receipts reject multi-answer question output", () => {
  const receipts = new NativeReceiptStore();
  receipts.record(
    {
      sessionID: "multi-answer",
      callID: "decision",
      args: {
        questions: [
          {
            header: "Workit decision: design",
            question: "Approve this change?",
            options: [
              { label: "approved", description: "Design" },
              { label: "rejected", description: "Reject this decision" },
            ],
          },
        ],
      },
    },
    { metadata: { answers: [["approved", "rejected"]] } },
  );
  expect(receipts.consume("multi-answer", "decision").ok).toBe(false);
});

test("decision receipts cannot cross core decision purposes", () => {
  const receipts = new NativeReceiptStore();
  receipts.record(
    {
      sessionID: "s",
      callID: "decision",
      args: {
        questions: [
          {
            header: "Workit decision: design",
            question: "Approve this change?",
            options: [
              { label: "approved", description: "Design v1" },
              { label: "rejected", description: "Reject this decision" },
            ],
          },
        ],
      },
    },
    { metadata: { answers: [["approved"]] } },
  );
  expect(
    receipts.consume("s", "decision", {
      decisionPurpose: "action",
      selectedLabel: "approved",
      selectedDescription: "Design v1",
      question: "Approve this change?",
    }).ok,
  ).toBe(false);
});

test("receipt-shaped questions accept presentation-only rejected descriptions", () => {
  const receipts = new NativeReceiptStore();
  receipts.record(
    {
      sessionID: "s",
      callID: "decision",
      args: {
        questions: [
          {
            header: "Workit decision: design",
            question: "Approve this change?",
            options: [
              { label: "approved", description: "Allow it" },
              { label: "rejected", description: "No thanks" },
            ],
          },
        ],
      },
    },
    { metadata: { answers: [["approved"]] } },
  );
  expect(receipts.consume("s", "decision").ok).toBe(true);
});

test("host-qualified option labels normalize while original bytes stay in the receipt", () => {
  const receipts = new NativeReceiptStore();
  receipts.record(
    {
      sessionID: "s",
      callID: "decision",
      args: {
        questions: [
          {
            header: "Workit decision: design",
            question: "Approve this change?",
            options: [
              { label: "approved (Recommended)", description: "Allow it" },
              { label: "rejected (Recommended)", description: "No thanks" },
            ],
          },
        ],
      },
    },
    { metadata: { answers: [["approved (Recommended)"]] } },
  );
  const consumed = receipts.consume("s", "decision", {
    selectedLabel: "approved",
    selectedDescription: "Allow it",
  });
  expect(consumed.ok).toBe(true);
  if (!consumed.ok) throw new Error("expected a receipt");
  expect(consumed.receipt.selectedLabel).toBe("approved (Recommended)");
});

test("an unrelated newer same-purpose receipt does not shadow a valid match", () => {
  const receipts = new NativeReceiptStore();
  for (const [question, content] of [
    ["Approve the first design?", "Design v1"],
    ["Approve the second design?", "Design v2"],
  ] as const) {
    receipts.record(
      {
        sessionID: "s",
        callID: `call-${content}`,
        args: {
          questions: [
            {
              header: "Workit decision: design",
              question,
              options: [
                { label: "approved", description: content },
                { label: "rejected", description: "No thanks" },
              ],
            },
          ],
        },
      },
      { metadata: { answers: [["approved"]] } },
    );
  }
  expect(
    receipts.consume("s", "decision", {
      question: "Approve the first design?",
      selectedDescription: "Design v1",
    }).ok,
  ).toBe(true);
});

test("receipt validity ignores wall-clock age; only content binds", () => {
  let now = 1_000_000;
  const receipts = new NativeReceiptStore({ now: () => now });
  receipts.record(
    {
      sessionID: "s",
      callID: "decision",
      args: {
        questions: [
          {
            header: "Workit decision: design",
            question: "Approve this change?",
            options: [
              { label: "approved", description: "Allow it" },
              { label: "rejected", description: "No thanks" },
            ],
          },
        ],
      },
    },
    { metadata: { answers: [["approved"]] } },
  );
  now += 60 * 60 * 1000;
  const aged = receipts.consume("s", "decision");
  expect(aged.ok).toBe(true);
  if (!aged.ok) throw new Error("aged receipt must stay valid");
  expect(receipts.consume("s", "decision").ok).toBe(false);
});

test("missing receipt guidance says not to ask again", () => {
  const missing = new NativeReceiptStore().consume("lead", "decision");
  expect(missing.ok).toBe(false);
  if (missing.ok) throw new Error("expected failure");
  expect(missing.error).toContain("do not ask again");
  expect(missing.error).toContain("task progress");
});

test("doctor checks the OpenCode SDK pin in devDependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-doctor-"));
  try {
    for (const name of ["workit-core", "workit-opencode", "workit-cursor", "workit-cli"])
      mkdirSync(join(root, "packages", name), { recursive: true });
    writeFileSync(
      join(root, "packages", "workit-core", "package.json"),
      JSON.stringify({ name: "core" }),
    );
    for (const name of ["workit-cursor", "workit-cli"])
      writeFileSync(
        join(root, "packages", name, "package.json"),
        JSON.stringify({ dependencies: { "@brainervirus/workit-core": "workspace:*" } }),
      );
    writeFileSync(
      join(root, "packages", "workit-opencode", "package.json"),
      JSON.stringify({
        dependencies: { "@brainervirus/workit-core": "workspace:*" },
        devDependencies: { "@opencode/plugin": "1.0.0" },
      }),
    );
    // Offline and hermetic: only node and bun on PATH, so the doctor's
    // registry (npm view) and provider identity (gh/glab) probes cannot reach
    // the network and stall the test on a slow runner.
    const report = runDoctor({
      host: "opencode",
      dev: root,
      home: root,
      configDir: join(root, "config"),
      env: { ...process.env, HOME: root, PATH: binDirWithRuntimes(root) },
    });
    const versions = report.checks.find((check) => check.id === "versions");
    expect(versions?.status).toBe("fail");
    expect(versions?.detail).toContain("@opencode/plugin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
