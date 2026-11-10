import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTaskCommand } from "@/packages/workit-cli/src/task";

// #317: the finding round-trip in one turn. The session that recorded a
// finding resolves it with its own evidence; a refused resolve names the
// evidence its disposition accepts and the ids in the task that fit.

const scope = { description: "checkout", paths: ["."], exclusions: [] };
const ref = { kind: "file", path: "src/retry.ts", digest: null };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const checkout = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-finding-resolve-"));
  roots.push(root);
  for (const args of [
    ["init", "-q", "-b", "feature/x"],
    ["config", "user.email", "t@e.invalid"],
    ["config", "user.name", "T"],
    ["commit", "-q", "--allow-empty", "-m", "base"],
  ])
    spawnSync("git", args, { cwd: root });
  return root;
};

const cli = async (root: string, argv: string[]) => {
  let stdout = "";
  const code = await runTaskCommand([...argv, "--json"], {
    cwd: root,
    out: { write: (chunk) => void (stdout += chunk) },
    err: { write: () => {} },
  });
  return { code, json: () => JSON.parse(stdout) };
};

const payload = (value: Record<string, unknown>) => ["--payload", JSON.stringify(value)];

const recordFinding = async (root: string, extra: Record<string, unknown> = {}) => {
  const recorded = await cli(root, [
    "finding",
    "record",
    ...payload({
      claim: "retry loop swallows the timeout",
      consequence: "a hung call reads as success",
      scope,
      candidateId: null,
      refs: [ref],
      ...extra,
    }),
  ]);
  expect(recorded.code, JSON.stringify(recorded.json())).toBe(0);
  return recorded.json().data.id as string;
};

const recordEvidence = async (
  root: string,
  refs: unknown[],
  extra: Record<string, unknown> = {},
) => {
  const recorded = await cli(root, [
    "evidence",
    "record",
    ...payload({
      evidence: {
        kind: "investigation",
        claim: "the timeout now propagates",
        requirementIds: [],
        candidateId: null,
        result: "passed",
        summary: "read the retry loop",
        refs,
        exitCode: null,
        reviewContext: null,
      },
      ...extra,
    }),
  ]);
  expect(recorded.code, JSON.stringify(recorded.json())).toBe(0);
  return recorded.json().data.id as string;
};

const resolve = (root: string, findingId: string, evidenceIds: string[], extra: string[] = []) =>
  cli(root, [
    "finding",
    "resolve",
    ...extra,
    ...payload({
      findingId,
      disposition: "dismissed",
      reason: "the loop already rethrows",
      evidenceIds,
      decisionIds: [],
    }),
  ]);

test("Given a finding recorded this turn, When the same session resolves it with its own evidence, Then it closes", async () => {
  const root = checkout();
  const findingId = await recordFinding(root);
  const evidenceId = await recordEvidence(root, [ref]);
  const resolved = await resolve(root, findingId, [evidenceId]);
  expect(resolved.code, JSON.stringify(resolved.json())).toBe(0);
  expect(resolved.json().data.data).toMatchObject({
    disposition: "dismissed",
    resolution: { evidenceIds: [evidenceId] },
  });
});

test("Given no evidence, When the finding is resolved, Then the error names the accepted evidence kinds and the ids that fit", async () => {
  const root = checkout();
  const findingId = await recordFinding(root);
  const none = await resolve(root, findingId, []);
  expect(none.code).toBe(1);
  expect(none.json().code).toBe("permission_denied");
  expect(none.json().error).toContain("dismissal requires supporting evidence");
  expect(none.json().error).toContain(
    "accepted for dismissed: evidence (check, review, investigation or artifact) with result passed or failed",
  );
  expect(none.json().error).toContain("none recorded in this task yet: workit evidence record");

  const fitting = await recordEvidence(root, [ref]);
  const unrelated = await recordEvidence(root, [{ kind: "file", path: "other.ts", digest: null }]);
  const wrong = await resolve(root, findingId, [unrelated]);
  expect(wrong.json().error).toContain("dismissal evidence is unrelated to the finding");
  expect(wrong.json().error).toContain(`evidence in this task that fits: ${fitting}`);
  expect(wrong.json().details.guidance).toContain(fitting);
  expect(wrong.json().error).not.toContain(unrelated);
});

test("Given a finding in another branch's task of the checkout, When resolved without --task, Then it is routed to that task", async () => {
  const root = checkout();
  spawnSync("git", ["switch", "-q", "-c", "helper"], { cwd: root });
  const findingId = await recordFinding(root);
  const evidenceId = await recordEvidence(root, [ref]);
  spawnSync("git", ["switch", "-q", "feature/x"], { cwd: root });
  // feature/x's own task, the implicit one here, holds another finding.
  await recordFinding(root, { claim: "branch task finding" });
  const resolved = await resolve(root, findingId, [evidenceId]);
  expect(resolved.code, JSON.stringify(resolved.json())).toBe(0);
  expect(resolved.json().data.data.disposition).toBe("dismissed");
});

test("Given the retro's wrong finding payloads, When the CLI refuses them, Then each error prints one valid example payload for its action", async () => {
  const root = checkout();
  const findingId = await recordFinding(root);
  for (const [action, body] of [
    ["resolve", { id: findingId, resolution: "fixed" }],
    ["resolve", { findingId, disposition: "resolved", reason: "r" }],
    ["record", { severity: "high", title: "t", file: "src/a.ts", branch: "feature/x" }],
  ] as const) {
    const refused = await cli(root, ["finding", action, ...payload(body)]);
    expect(refused.code).toBe(1);
    const error = refused.json().error as string;
    expect(error).not.toContain("operation input is invalid");
    const example = JSON.parse(error.match(/Example: (\{.*\})$/u)![1]) as Record<string, unknown>;
    expect(example.action).toBe(action);
    expect(Object.keys(example)).toContain(action === "record" ? "claim" : "findingId");
    if (action === "resolve")
      expect(example).toMatchObject({ disposition: "fixed", evidenceIds: ["<evidenceId>"] });
  }
});
