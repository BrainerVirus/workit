import { expect, test } from "bun:test";
import {
  MAX_BYTES,
  MAX_LINES,
  MAX_MERMAID,
  shouldRenderDoc,
} from "../packages/workit/src/core/doc-render";
import { DOC_RENDER_TEXT, shouldInjectDocRender } from "../packages/workit/src/core/reminder";

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

test("CA-02: DOC_RENDER_TEXT instructs render-by-default", () => {
  expect(DOC_RENDER_TEXT).toContain("workflow-doc-render");
  expect(DOC_RENDER_TEXT).toContain("full markdown");
  expect(DOC_RENDER_TEXT).toContain("mermaid fences preserved");
});

test("CA-02: DOC_RENDER_TEXT instructs link + summary above threshold", () => {
  expect(DOC_RENDER_TEXT).toContain("more than 150 lines");
  expect(DOC_RENDER_TEXT).toContain("over 8KB");
  expect(DOC_RENDER_TEXT).toContain("more than 3 mermaid");
  expect(DOC_RENDER_TEXT).toContain("[spec.md](docs/<slug>/spec.md)");
  expect(DOC_RENDER_TEXT).toContain("3-5 bullet summary");
});

test("CA-02: DOC_RENDER_TEXT keeps raw escape hatch", () => {
  expect(DOC_RENDER_TEXT).toContain("raw");
  expect(DOC_RENDER_TEXT).toContain("para copiar");
  expect(DOC_RENDER_TEXT).toContain("sin render");
  expect(DOC_RENDER_TEXT).toContain("full fenced block");
});

test("CA-03: shouldInjectDocRender is true without the marker, false with it", () => {
  expect(shouldInjectDocRender("plain user message")).toBe(true);
  expect(shouldInjectDocRender(DOC_RENDER_TEXT)).toBe(false);
  expect(shouldInjectDocRender(`message with ${DOC_RENDER_TEXT} marker`)).toBe(false);
  expect(shouldInjectDocRender("partial <workflow-doc-render> tag alone")).toBe(true);
});
