import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { parseSource } from "@/packages/workit-cli/src/test-audit/ast";
import { auditMockUse } from "@/packages/workit-core/src/test-audit-mocks";

const HEADER = [
  'import { expect, mock, spyOn, test } from "bun:test";',
  'import * as store from "../src/store";',
  'import { checkout } from "../src/checkout";',
  'import { sendEmail } from "nodemailer-lite";',
  "",
].join("\n");

const audit = (body: string, file = "test/checkout.test.ts") =>
  auditMockUse(parseSource(HEADER + body, file), file).map((finding) => [
    finding.rule,
    finding.severity,
    finding.line - 4,
  ]);

test("Given a test asserting call order on an internal mock, When audited, Then it is flagged mock-call-order", () => {
  expect(
    audit(`test("loads before saving", () => {
  const load = spyOn(store, "load");
  const save = spyOn(store, "save");
  checkout([1]);
  expect(load).toHaveBeenCalledBefore(save);
});`),
  ).toEqual([["mock-call-order", "medium", 5]]);
});

test("Given call counts and nth-call checks on a module mocked by path, When audited, Then each is flagged", () => {
  expect(
    audit(`mock.module("../src/checkout", () => ({ checkout: mock() }));
test("checks out once", () => {
  checkout([1]);
  expect(checkout).toHaveBeenCalledTimes(1);
  expect(checkout.mock.calls.length).toBe(1);
  expect(checkout).toHaveBeenNthCalledWith(1, [1]);
});`),
  ).toEqual([
    ["mock-call-order", "medium", 4],
    ["mock-call-order", "medium", 5],
    ["mock-call-order", "medium", 6],
  ]);
});

test("Given a call count on an injected boundary double, When audited, Then it is left alone; call order on it is low", () => {
  expect(
    audit(`test("retries the mail gateway three times", async () => {
  const send = mock(async () => { throw new Error("down"); });
  await checkout([1], { send });
  expect(send).toHaveBeenCalledTimes(3);
});`),
  ).toEqual([]);
  expect(
    audit(`test("notifies in order", async () => {
  const first = mock();
  const second = mock();
  await checkout([1], { first, second });
  expect(first.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0]);
});`),
  ).toEqual([["mock-call-order", "low", 5]]);
});

test("Given a test reading a private member or importing a test-only export, When audited, Then it is flagged private-access", () => {
  const file = "test/cart.test.ts";
  const source = `import { expect, test } from "bun:test";
import { Cart, __testing } from "../src/cart";
test("caches the total", () => {
  const cart = new Cart();
  cart.add(5);
  expect(cart._cachedTotal).toBe(5);
  expect(cart["_items"].length).toBe(1);
  expect(__dirname).toBeTruthy();
});`;
  expect(
    auditMockUse(parseSource(source, file), file).map((finding) => [finding.rule, finding.line]),
  ).toEqual([
    ["private-access", 2],
    ["private-access", 6],
    ["private-access", 7],
  ]);
});

test("Given a workit-test-audit-ignore comment naming the rule, When audited, Then the line is not flagged", () => {
  expect(
    audit(`test("loads before saving", () => {
  const load = spyOn(store, "load");
  const save = spyOn(store, "save");
  checkout([1]);
  // workit-test-audit-ignore mock-call-order -- the lock must be taken before the write
  expect(load).toHaveBeenCalledBefore(save);
});`),
  ).toEqual([]);
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("Given a test file asserting call order on an internal mock, When workit test-audit runs, Then the finding is reported and --rule selects it", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-audit-mocks-"));
  dirs.push(root);
  mkdirSync(path.join(root, "test"));
  writeFileSync(
    path.join(root, "test/checkout.test.ts"),
    `${HEADER}test("loads before saving", () => {
  const load = spyOn(store, "load");
  const save = spyOn(store, "save");
  expect(checkout([1])).toBe(1);
  expect(load).toHaveBeenCalledBefore(save);
});
`,
  );
  let stdout = "";
  const code = await main(["test-audit", "test", "--rule", "mock-call-order", "--json"], {
    cwd: root,
    env: { ...process.env, WORKIT_WORKSPACE_ROOT: "" },
    stdout: (text) => void (stdout += text),
    stderr: () => undefined,
  });
  expect(code).toBe(0);
  const data = JSON.parse(stdout).data;
  expect(
    data.findings.map((finding: { rule: string; file: string; line: number }) => [
      finding.rule,
      finding.file,
      finding.line,
    ]),
  ).toEqual([["mock-call-order", "test/checkout.test.ts", 9]]);
  expect(data.summary.byRule).toEqual({ "mock-call-order": 1 });
});
