import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  previewConversion,
  redactConversionPreview,
} from "../../packages/workit-core/src/core/config-conversion";
import { makeCutoverFixture, managedBytes } from "../shared/helpers/cutover-fixture";

const fixture = makeCutoverFixture({ secret: "secret-value" });
afterAll(() => fixture.cleanup());

test("conversion preview is read only and redacts secrets", () => {
  const before = managedBytes(fixture);
  const preview = previewConversion({ configDir: fixture.configDir });
  expect(preview.unresolved.map((item) => item.key)).toContain("legacyWorkflowMode");
  expect(JSON.stringify(redactConversionPreview(preview))).not.toContain("secret-value");
  expect(managedBytes(fixture)).toEqual(before);
});

test("supported preference mappings carry locale timezone and branchPolicy forward", () => {
  const preview = previewConversion({ configDir: fixture.configDir });
  expect(preview.mappings.find((m) => m.key === "locale")?.to).toBe("es-CL");
  expect(preview.mappings.find((m) => m.key === "timezone")?.to).toBe("America/Santiago");
  expect(preview.mappings.find((m) => m.key === "branchPolicy")?.to).toMatchObject({
    preset: "custom",
  });
});

test("unsupported permissive branchPolicy values stay unresolved", () => {
  const preview = previewConversion({ configDir: fixture.configDir });
  expect(preview.unresolved.map((u) => u.key)).toContain("branchPolicy.allowed");
});

test("credentials are preserved and left out of conversion mappings", () => {
  const preview = previewConversion({ configDir: fixture.configDir });
  expect(preview.preserved).toContain(path.join(fixture.configDir, "youtrack.token"));
  expect(preview.preserved).toContain(path.join(fixture.configDir, "gitlab.token"));
  expect(JSON.stringify(preview)).not.toContain("secret-value");
  expect(JSON.stringify(preview)).not.toContain("glpat-legacy");
});

test("integration json files are mapped unchanged", () => {
  const preview = previewConversion({ configDir: fixture.configDir });
  for (const key of ["youtrack.json", "vcs.json", "workspaces.json"]) {
    const mapping = preview.mappings.find((m) => m.key === key);
    expect(mapping?.note).toContain("unchanged");
    expect(mapping?.from).toEqual(mapping?.to);
  }
});

test("changed meanings require an explicit choice", () => {
  const preview = previewConversion({ configDir: fixture.configDir });
  const item = preview.unresolved.find((u) => u.key === "legacyWorkflowMode");
  expect(item?.reason).toMatch(/no automatic v1 equivalent/i);
});

test("unrelated user settings are not listed as conversion mutations", () => {
  const preview = previewConversion({ configDir: fixture.configDir });
  expect(preview.mappings.some((m) => m.key.includes("theme"))).toBe(false);
  expect(JSON.stringify(preview)).not.toContain("unrelated-plugin");
});
