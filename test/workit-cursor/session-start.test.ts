import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncRuntime } from "../../packages/workit-core/src/core/sync-runtime";
import { HANDOFF_DESTINATION_MARKER } from "../../packages/workit-core/src/core/flow-state";

const runHook = (env: Record<string, string>, input?: string) =>
  spawnSync(process.execPath, [path.join(CURSOR_ROOT, "hooks", "session-start.ts")], {
    cwd: REPO_ROOT,
    env,
    input,
    encoding: "utf8",
  });

// RL-09/CA-25: session-start performs NO network synchronization. Runtime
// updates are confined to explicit install/update operations (sync-runtime),
// which report failures loudly (RR-05). Task 6 established the behavior; this
// file pins it against regression.

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CURSOR_ROOT = path.join(REPO_ROOT, "packages", "workit-cursor");
const CORE_SRC = path.join(REPO_ROOT, "packages", "workit-core", "src");

const contractText = `# Superpowers doc contract

- Deliver docs as clickable markdown links.
- [spec.md](docs/<slug>/spec.md) + 3-5 bullet summary.
`;

test("session-start source performs no network I/O and imports no runtime sync", () => {
  const src = readFileSync(path.join(CURSOR_ROOT, "hooks", "session-start.ts"), "utf8");
  expect(src).not.toMatch(/fetch\s*\(/);
  expect(src).not.toContain("child_process");
  expect(src).not.toContain("sync-runtime");
  expect(src).not.toMatch(/git\s+(fetch|pull|clone)/);
  expect(src).not.toMatch(/\b(?:rsync|flock|npm install|curl)\b/);
});

test("session-start with an empty PATH produces identical output (zero startup network calls)", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-hook-offline-"));
  mkdirSync(path.join(root, "templates"), { recursive: true });
  writeFileSync(path.join(root, "templates", "superpowers-doc-contract.md"), contractText);
  const emptyBin = mkdtempSync(path.join(os.tmpdir(), "wf-hook-bin-"));
  try {
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, [path.join(CURSOR_ROOT, "hooks", "session-start.ts")], {
        cwd: REPO_ROOT,
        env,
        encoding: "utf8",
      });
    const normal = run({ ...process.env, WORKFLOW_TOOLKIT_ROOT: root, BUN: process.execPath });
    expect(normal.status).toBe(0);
    // PATH holds no git/rsync/flock/npm/curl: the hook cannot reach the network
    // via any external binary even if it tried. Limitation: an empty PATH says
    // nothing about fetch()/http-based network I/O from within the runtime, so
    // the transitive-import source scan below proves that side separately.
    const offline = run({
      ...process.env,
      WORKFLOW_TOOLKIT_ROOT: root,
      PATH: emptyBin,
      BUN: process.execPath,
    });
    expect(offline.status, offline.stderr ?? "").toBe(0);
    expect(offline.stdout).toBe(normal.stdout);
    expect(JSON.parse(offline.stdout).additional_context).toContain("HARD-GATE");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(emptyBin, { recursive: true, force: true });
  }
});

test("session-start transitive imports perform no fetch/http-based network I/O", () => {
  // B9: the empty-PATH test proves no binary-based network; this proves no
  // in-process fetch/http/net either. Walk the import graph from the entry and
  // assert no transitively imported source calls fetch(), http.request, or
  // net.connect (all network-free by source inspection, no PATH dependency).
  const seen = new Set<string>();
  const queue = [path.join(CURSOR_ROOT, "hooks", "session-start.ts")];
  const sources: string[] = [];
  while (queue.length) {
    const file = path.resolve(queue.pop()!);
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    sources.push(src);
    const dir = path.dirname(file);
    for (const match of src.matchAll(/import[^;]*?\bfrom\s+["']([^"']+)["']/g)) {
      const spec = match[1];
      if (
        spec.startsWith("node:") ||
        (!spec.startsWith(".") && !spec.startsWith("@brainervirus/workit-core/"))
      ) {
        continue; // builtins / external packages are not scanned
      }
      let target = spec.startsWith("@brainervirus/workit-core/")
        ? path.join(CORE_SRC, spec.replace("@brainervirus/workit-core/src/", ""))
        : path.join(dir, spec);
      for (const ext of ["", ".ts", ".tsx", "/index.ts"]) {
        if (existsSync(target + ext)) {
          target = target + ext;
          break;
        }
      }
      if (existsSync(target)) queue.push(target);
    }
  }
  expect(seen.size).toBeGreaterThan(1); // the entry pulls in at least the core modules
  for (const src of sources) {
    expect(src).not.toMatch(/fetch\s*\(/);
    expect(src).not.toMatch(/http\.request/);
    expect(src).not.toMatch(/net\.connect/);
    expect(src).not.toMatch(/node:http|node:net/);
  }
});

test("explicit runtime update reports failure when its toolchain is missing (RR-05)", async () => {
  const emptyBin = mkdtempSync(path.join(os.tmpdir(), "wf-sync-bin-"));
  try {
    const env = {
      ...process.env,
      PATH: emptyBin,
      HOME: mkdtempSync(path.join(os.tmpdir(), "wf-sync-home-")),
    };
    const result = await syncRuntime({ env });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("flock");
  } finally {
    rmSync(emptyBin, { recursive: true, force: true });
  }
});

test("session-start never falls back to an implicit runtime update", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-hook-empty-"));
  try {
    // A missing contract is reported fail-open ({}), never patched over the
    // network: no install/update runs at startup.
    mkdirSync(path.join(root, "templates"), { recursive: true });
    const r = spawnSync(process.execPath, [path.join(CURSOR_ROOT, "hooks", "session-start.ts")], {
      cwd: REPO_ROOT,
      env: { ...process.env, WORKFLOW_TOOLKIT_ROOT: root, BUN: process.execPath },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect((r.stdout ?? "").trim()).toBe("{}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session-start selects the four-choice destination reminder for a marked workspace and five for ordinary sessions", () => {
  const markedRoot = mkdtempSync(path.join(os.tmpdir(), "wf-hook-dest-"));
  const plainRoot = mkdtempSync(path.join(os.tmpdir(), "wf-hook-plain-"));
  try {
    for (const root of [markedRoot, plainRoot]) {
      mkdirSync(path.join(root, "templates"), { recursive: true });
      writeFileSync(path.join(root, "templates", "superpowers-doc-contract.md"), contractText);
    }
    // A marked handoff destination (handoff_destination: true in flow.json).
    mkdirSync(path.join(markedRoot, "docs", "dest", "sdd"), { recursive: true });
    writeFileSync(
      path.join(markedRoot, "docs", "dest", "sdd", "flow.json"),
      JSON.stringify({ slug: "dest", activated: true, handoff_destination: true }),
    );
    // An ordinary flow — not a destination.
    mkdirSync(path.join(plainRoot, "docs", "plain", "sdd"), { recursive: true });
    writeFileSync(
      path.join(plainRoot, "docs", "plain", "sdd", "flow.json"),
      JSON.stringify({ slug: "plain", activated: true, handoff_destination: false }),
    );

    const destination = runHook(
      { ...process.env, WORKFLOW_TOOLKIT_ROOT: markedRoot, BUN: process.execPath },
      JSON.stringify({ workspace_roots: [markedRoot] }),
    );
    expect(destination.status, destination.stderr ?? "").toBe(0);
    const destText = JSON.parse(destination.stdout).additional_context as string;
    expect(destText).toContain("Subagent-driven, Inline, Review spec first, Review plan first");
    expect(destText).not.toContain("Handoff");
    expect(destText).toContain(HANDOFF_DESTINATION_MARKER);

    const ordinary = runHook(
      { ...process.env, WORKFLOW_TOOLKIT_ROOT: plainRoot, BUN: process.execPath },
      JSON.stringify({ workspace_roots: [plainRoot] }),
    );
    expect(ordinary.status, ordinary.stderr ?? "").toBe(0);
    const plainText = JSON.parse(ordinary.stdout).additional_context as string;
    expect(plainText).toContain(
      "Subagent-driven, Inline, Handoff, Review spec first, Review plan first",
    );
    expect(plainText).not.toContain(HANDOFF_DESTINATION_MARKER);
  } finally {
    rmSync(markedRoot, { recursive: true, force: true });
    rmSync(plainRoot, { recursive: true, force: true });
  }
});
