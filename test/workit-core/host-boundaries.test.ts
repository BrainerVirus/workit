import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "../../packages/workit-core/src/core/scripts";
import {
  readEffectiveFlowState,
  slugFromPath,
} from "../../packages/workit-core/src/core/flow-state";
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CORE_SRC = path.join(REPO_ROOT, "packages", "workit-core", "src");
const CURSOR_SERVER = path.join(REPO_ROOT, "packages", "workit-cursor", "mcp", "server.ts");

const FORBIDDEN = ["@opencode-ai", "@modelcontextprotocol", "ink", "react"];

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? tsFilesUnder(full) : full.endsWith(".ts") ? [full] : [];
  });
}

function specifiers(source: string): string[] {
  // Catches `from "x"`, `import("x")`, and bare side-effect `import "x"`
  // (D7) so a host-SDK side-effect import cannot evade the scan.
  return [...source.matchAll(/(?:from\s*|import\s*\(|import\s+)["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
}

test("workit-core imports no host SDK, MCP SDK, Ink, or React", () => {
  const offenders: string[] = [];
  for (const file of tsFilesUnder(CORE_SRC)) {
    const source = readFileSync(file, "utf8");
    for (const spec of specifiers(source)) {
      if (FORBIDDEN.some((prefix) => spec === prefix || spec.startsWith(prefix))) {
        offenders.push(`${path.relative(REPO_ROOT, file)} -> ${spec}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("specifier scan catches bare side-effect imports, not only from/import() (D7)", () => {
  const source = [
    'import "@opencode-ai/plugin";',
    'import { x } from "ink";',
    'const m = import("react");',
    'import("@opencode-ai/tools");',
  ].join("\n");
  const specs = specifiers(source);
  expect(specs).toContain("@opencode-ai/plugin");
  expect(specs).toContain("ink");
  expect(specs).toContain("react");
  expect(specs).toContain("@opencode-ai/tools");
  expect(specs.filter((s) => s === "@opencode-ai/plugin")).toHaveLength(1);
});

test("root tsconfig typechecks every maintained TS surface", () => {
  const tsconfig = JSON.parse(readFileSync(path.join(REPO_ROOT, "tsconfig.json"), "utf8"));
  expect(tsconfig.compilerOptions.strict).toBe(true);
  for (const entry of [
    "test/**/*.ts",
    "packages/workit-core/src/**/*.ts",
    "packages/workit-opencode/src/**/*.ts",
    "packages/workit-cli/src/**/*.tsx",
    "packages/workit-cursor/mcp/**/*.ts",
  ]) {
    expect(tsconfig.include).toContain(entry);
  }
});

test("cursor delegates workspace root context to the shared transport", () => {
  const server = readFileSync(CURSOR_SERVER, "utf8");
  expect(server).toContain("@brainervirus/workit-mcp");
  expect(server).toContain("cursorContextProvider");
  expect(resolveWorkspaceRoot(undefined)).toBe(process.cwd());
  expect(resolveWorkspaceRoot("/workspace")).toBe("/workspace");
});

test("cursor does not duplicate host flow or schema registrations", async () => {
  const server = readFileSync(CURSOR_SERVER, "utf8");
  expect(server).not.toContain("resolveCanonicalLayout");
  expect(server).not.toContain("readFlowState");
  expect(server).not.toContain("registerTool");

  const { createFlowTools } = await import("../../packages/workit-opencode/src/tools/flow");
  const { HostReceiptStore } = await import("../../packages/workit-core/src/core/flow-state");
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-boundary-"));
  try {
    mkdirSync(path.join(root, "docs", "x", "sdd"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# X\n\n**Branch:** `feature/x`\n");
    writeFileSync(
      path.join(root, "docs/x/plan.md"),
      "# X\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
    );
    writeFileSync(
      path.join(root, "docs/x/sdd/flow.json"),
      JSON.stringify({
        slug: "x",
        spec: { path: "docs/x/spec.md", status: "approved" },
        plan: { path: "docs/x/plan.md", status: "approved" },
        menu: { presented: true, chosen: "handoff" },
        updated_at: 1,
      }),
    );

    const raw = await createFlowTools(new HostReceiptStore(), {
      session: { get: async () => ({ data: {} }) },
    }).workit_flow_status.execute({ plan_path: "docs/x/plan.md" }, { directory: root } as never);
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(true);
    const slug = slugFromPath("docs/x/plan.md");
    // The status tool reads the EFFECTIVE (reconciled) state: the fixture's
    // undigested approvals surface as digest_missing drift, the drift reset is
    // persisted, and the execution lifecycle is reported alongside spec/plan/menu.
    // Drift is reported on the reconciling read only — after the reset is
    // persisted, a fresh read is clean.
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    if (effective.ok) {
      expect(result.data).toEqual({
        slug,
        spec: effective.state.spec,
        plan: effective.state.plan,
        menu: effective.state.menu,
        execution: effective.state.execution,
        drift: [{ document: "spec", code: "digest_missing", path: "docs/x/spec.md" }],
        flow_path: `docs/${slug}/sdd/flow.json`,
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor publishes only the shared eight operation families", async () => {
  const server = readFileSync(CURSOR_SERVER, "utf8");
  expect(server).toContain("createMcpServer");
  const { OPERATION_FAMILIES } = await import("../../packages/workit-core/src/core");
  expect(OPERATION_FAMILIES).toHaveLength(8);
});
