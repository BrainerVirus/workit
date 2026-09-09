import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_PACKAGES } from "../../packages/workit-core/scripts/analyze-release-scope";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADAPTERS = RELEASE_PACKAGES.filter((pkg) => pkg !== "workit-core");

const core = (dir: string) =>
  JSON.parse(readFileSync(path.join(dir, "packages/workit-core/package.json"), "utf8"));

test("rewrite-workspace-deps.ts: workspace:* → ^<core version> in all platform packages", () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "wf-rewrite-"));
  for (const pkg of RELEASE_PACKAGES) {
    mkdirSync(path.join(sandbox, "packages", pkg), { recursive: true });
    cpSync(
      path.join(repoRoot, `packages/${pkg}/package.json`),
      path.join(sandbox, `packages/${pkg}/package.json`),
    );
  }
  mkdirSync(path.join(sandbox, "packages/workit-cursor/.cursor-plugin"), { recursive: true });
  cpSync(
    path.join(repoRoot, "packages/workit-cursor/.cursor-plugin/plugin.json"),
    path.join(sandbox, "packages/workit-cursor/.cursor-plugin/plugin.json"),
  );
  mkdirSync(path.join(sandbox, "packages/workit-codex/.codex-plugin"), { recursive: true });
  cpSync(
    path.join(repoRoot, "packages/workit-codex/.codex-plugin/plugin.json"),
    path.join(sandbox, "packages/workit-codex/.codex-plugin/plugin.json"),
  );
  const script = path.join(repoRoot, "packages/workit-core/scripts/rewrite-workspace-deps.ts");
  const run = spawnSync("bun", [script, sandbox], { encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);

  const version = core(sandbox).version;
  for (const pkg of ADAPTERS) {
    const data = JSON.parse(
      readFileSync(path.join(sandbox, `packages/${pkg}/package.json`), "utf8"),
    );
    for (const name of Object.keys(data.dependencies ?? {})) {
      if (name.startsWith("@brainervirus/")) {
        expect(data.dependencies[name]).toBe(`^${version}`);
      }
    }
    expect(JSON.stringify(data)).not.toContain("workspace:*");
  }
  expect(JSON.stringify(core(sandbox))).not.toContain("workspace:*");
  for (const f of [".cursor-plugin/plugin.json"]) {
    const data = JSON.parse(
      readFileSync(path.join(sandbox, `packages/workit-cursor/${f}`), "utf8"),
    );
    expect(data.version).toBe(version);
  }
  const plugin = JSON.parse(
    readFileSync(path.join(sandbox, "packages/workit-cursor/.cursor-plugin/plugin.json"), "utf8"),
  );
  expect(plugin.homepage).toBe("https://github.com/BrainerVirus/workit");
  expect(plugin.repository).toBe("https://github.com/BrainerVirus/workit");
});

test("rewrite-workspace-deps.ts: every prepared adapter dependency equals the prepared core version even when pinned", () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "wf-rewrite-pinned-"));
  try {
    const coreData = JSON.parse(
      readFileSync(path.join(repoRoot, "packages/workit-core/package.json"), "utf8"),
    );
    coreData.version = "0.4.0";
    for (const pkg of RELEASE_PACKAGES) {
      const file = path.join(sandbox, `packages/${pkg}/package.json`);
      const data = JSON.parse(
        readFileSync(path.join(repoRoot, `packages/${pkg}/package.json`), "utf8"),
      );
      if (pkg === "workit-core") {
        data.version = coreData.version;
      } else {
        for (const name of Object.keys(data.dependencies ?? {})) {
          if (name.startsWith("@brainervirus/")) data.dependencies[name] = "^0.3.0";
        }
      }
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    }
    for (const f of [".cursor-plugin/plugin.json"]) {
      const src = path.join(repoRoot, `packages/workit-cursor/${f}`);
      const dst = path.join(sandbox, `packages/workit-cursor/${f}`);
      mkdirSync(path.dirname(dst), { recursive: true });
      const data = JSON.parse(readFileSync(src, "utf8"));
      data.version = "0.4.0";
      writeFileSync(dst, `${JSON.stringify(data, null, 2)}\n`);
    }
    mkdirSync(path.join(sandbox, "packages/workit-codex/.codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(sandbox, "packages/workit-codex/.codex-plugin/plugin.json"),
      `${JSON.stringify({ version: "0.4.0" }, null, 2)}\n`,
    );
    const script = path.join(repoRoot, "packages/workit-core/scripts/rewrite-workspace-deps.ts");
    const run = spawnSync("bun", [script, sandbox], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    for (const pkg of ADAPTERS) {
      const data = JSON.parse(
        readFileSync(path.join(sandbox, `packages/${pkg}/package.json`), "utf8"),
      );
      for (const name of Object.keys(data.dependencies ?? {})) {
        if (name.startsWith("@brainervirus/")) {
          expect(data.dependencies[name]).toBe(`^${coreData.version}`);
        }
      }
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("rewrite-workspace-deps.ts: repo package.jsons keep workspace:* for dev (script runs on sandbox only)", () => {
  for (const pkg of ADAPTERS) {
    const data = JSON.parse(
      readFileSync(path.join(repoRoot, `packages/${pkg}/package.json`), "utf8"),
    );
    for (const name of Object.keys(data.dependencies ?? {})) {
      if (name === "@brainervirus/workit-core") {
        expect(data.dependencies[name]).toBe("workspace:*");
      }
    }
  }
});

test("rewrite-workspace-deps.ts: pins every internal @brainervirus dependency including CLI adapter deps", () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "wf-rewrite-closure-"));
  try {
    for (const pkg of RELEASE_PACKAGES) {
      const file = path.join(sandbox, `packages/${pkg}/package.json`);
      const data = JSON.parse(
        readFileSync(path.join(repoRoot, `packages/${pkg}/package.json`), "utf8"),
      );
      if (pkg === "workit-cli") {
        data.dependencies["@brainervirus/workit-opencode"] = "workspace:*";
        data.dependencies["@brainervirus/workit-cursor"] = "workspace:*";
      }
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    }
    for (const f of [".cursor-plugin/plugin.json"]) {
      const dst = path.join(sandbox, `packages/workit-cursor/${f}`);
      mkdirSync(path.dirname(dst), { recursive: true });
      cpSync(path.join(repoRoot, `packages/workit-cursor/${f}`), dst);
    }
    mkdirSync(path.join(sandbox, "packages/workit-codex/.codex-plugin"), { recursive: true });
    cpSync(
      path.join(repoRoot, "packages/workit-codex/.codex-plugin/plugin.json"),
      path.join(sandbox, "packages/workit-codex/.codex-plugin/plugin.json"),
    );
    const script = path.join(repoRoot, "packages/workit-core/scripts/rewrite-workspace-deps.ts");
    const run = spawnSync("bun", [script, sandbox], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);

    const cli = JSON.parse(
      readFileSync(path.join(sandbox, "packages/workit-cli/package.json"), "utf8"),
    );
    const version = core(sandbox).version;
    for (const name of Object.keys(cli.dependencies ?? {})) {
      if (name.startsWith("@brainervirus/")) {
        expect(cli.dependencies[name], name).toBe(`^${version}`);
      }
    }
    expect(JSON.stringify(cli)).not.toContain("workspace:*");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
