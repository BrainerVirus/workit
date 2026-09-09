import { expect, test } from "bun:test";
import {
  MAX_BYTES,
  MAX_LINES,
  MAX_MERMAID,
  shouldRenderDoc,
} from "../../packages/workit-core/src/core/doc-render";

const mermaid = "```mermaid\nflowchart TD\n  a --> b\n```\n";

test("CA-01: short doc under all bounds renders", () => {
  const doc = `# Spec\n\n## Context\n\nSome context.\n\n${mermaid}`;
  expect(shouldRenderDoc(doc)).toBe(true);
});

test("CA-01: 151 lines exceeds MAX_LINES", () => {
  const doc = Array.from({ length: MAX_LINES + 1 }, (_, i) => `line ${i}`).join("\n");
  expect(shouldRenderDoc(doc)).toBe(false);
});

test("CA-01: 9KB doc exceeds MAX_BYTES", () => {
  const doc = "x".repeat(MAX_BYTES + 1024);
  expect(Buffer.byteLength(doc, "utf8")).toBeGreaterThan(MAX_BYTES);
  expect(shouldRenderDoc(doc)).toBe(false);
});

test("CA-01: 4 mermaid fences exceed MAX_MERMAID", () => {
  const doc = mermaid.repeat(MAX_MERMAID + 1);
  expect(shouldRenderDoc(doc)).toBe(false);
});

test("CA-01: empty string renders", () => {
  expect(shouldRenderDoc("")).toBe(true);
});

test("CA-01: exactly MAX_MERMAID fences is still within bounds", () => {
  const doc = mermaid.repeat(MAX_MERMAID);
  expect(shouldRenderDoc(doc)).toBe(true);
});

test("CA-01: exactly MAX_LINES lines is still within bounds", () => {
  const doc = Array.from({ length: MAX_LINES }, (_, i) => `line ${i}`).join("\n");
  expect(shouldRenderDoc(doc)).toBe(true);
});

test("CA-01: CRLF endings and trailing newline do not inflate the line count", () => {
  const doc = Array.from({ length: MAX_LINES }, (_, i) => `line ${i}`).join("\r\n") + "\r\n";
  expect(shouldRenderDoc(doc)).toBe(true);
});

test("CA-01: exactly MAX_BYTES is still within bounds", () => {
  const doc = "x".repeat(MAX_BYTES);
  expect(shouldRenderDoc(doc)).toBe(true);
});
