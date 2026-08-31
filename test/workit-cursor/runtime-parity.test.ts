import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HANDOFF_DESTINATION_MARKER } from "../../packages/workit-core/src/core/flow-state";

// Runtime parity for the Cursor launcher + session hook: both execute
// Node-compatible TS entries, and session start performs NO network sync
// (RL-09/CA-25) — a network-unavailable environment must not change behavior.

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CURSOR_ROOT = path.join(REPO_ROOT, "packages", "workit-cursor");

// The session-start hook injects the SHIPPED canonical contract verbatim
// (CA-08): byte-parity across the four template roots is asserted in
// contracts.test.ts, and this runtime test proves the hook serves those exact
// bytes instead of a stale copy.
const contractText = readFileSync(
  path.join(REPO_ROOT, "packages", "workit-core", "templates", "superpowers-doc-contract.md"),
  "utf8",
);

// The injected reminder block: the hook embeds reminderTextFor inside
// <workit-reminder>…</workit-reminder>.
const reminderOf = (additionalContext: string): string => {
  const start = additionalContext.indexOf("<workit-reminder>");
  const end = additionalContext.indexOf("</workit-reminder>", start);
  if (start < 0 || end < 0) return "";
  return additionalContext.slice(start, end);
};

function runEntry(args: string[], env: Record<string, string>): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, args, { cwd: REPO_ROOT, env, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

test("hooks/session-start executes a Node-compatible TS entry with the contract injected", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-hook-root-"));
  mkdirSync(path.join(root, "templates"), { recursive: true });
  writeFileSync(path.join(root, "templates", "superpowers-doc-contract.md"), contractText);
  try {
    const env = {
      ...process.env,
      WORKFLOW_TOOLKIT_ROOT: root,
      BUN: process.execPath,
    } as Record<string, string>;
    const direct = runEntry([path.join(CURSOR_ROOT, "hooks", "session-start.ts")], env);
    expect(direct.status, direct.stdout).toBe(0);
    const parsed = JSON.parse(direct.stdout);
    expect(parsed.additional_context).toContain("HARD-GATE");
    expect(parsed.additional_context).toContain("never A/B/C or 1/2/3 lists in prose");
    expect(parsed.additional_context).toContain(contractText.trim());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session start performs no network sync — network-unavailable behavior is identical", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-hook-offline-"));
  mkdirSync(path.join(root, "templates"), { recursive: true });
  writeFileSync(path.join(root, "templates", "superpowers-doc-contract.md"), contractText);
  const emptyBin = mkdtempSync(path.join(os.tmpdir(), "wf-hook-bin-"));
  try {
    const normal = runEntry([path.join(CURSOR_ROOT, "hooks", "session-start.ts")], {
      ...process.env,
      WORKFLOW_TOOLKIT_ROOT: root,
    });
    // PATH holds no git/rsync/flock/npm/curl: the hook cannot reach the network
    // even if it tried. It must produce the exact same JSON.
    const offline = runEntry([path.join(CURSOR_ROOT, "hooks", "session-start.ts")], {
      ...process.env,
      WORKFLOW_TOOLKIT_ROOT: root,
      PATH: emptyBin,
      BUN: process.execPath,
    });
    expect(offline.status, offline.stdout).toBe(0);
    expect(offline.stdout).toBe(normal.stdout);
    expect(JSON.parse(offline.stdout).additional_context).toContain("HARD-GATE");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(emptyBin, { recursive: true, force: true });
  }
});

test("session-start contract: six source choices, marked destinations five", () => {
  const plain = mkdtempSync(path.join(os.tmpdir(), "wf-hook-contract-plain-"));
  const marked = mkdtempSync(path.join(os.tmpdir(), "wf-hook-contract-dest-"));
  try {
    const run = (root: string, input: string) =>
      spawnSync(process.execPath, [path.join(CURSOR_ROOT, "hooks", "session-start.ts")], {
        cwd: REPO_ROOT,
        env: { ...process.env, WORKFLOW_TOOLKIT_ROOT: root, BUN: process.execPath },
        input,
        encoding: "utf8",
      });
    for (const root of [plain, marked]) {
      mkdirSync(path.join(root, "templates"), { recursive: true });
      writeFileSync(path.join(root, "templates", "superpowers-doc-contract.md"), contractText);
    }
    mkdirSync(path.join(marked, "docs", "dest", "sdd"), { recursive: true });
    writeFileSync(
      path.join(marked, "docs", "dest", "sdd", "flow.json"),
      JSON.stringify({ slug: "dest", activated: true, handoff_destination: true }),
    );

    const plainOut = run(plain, JSON.stringify({ workspace_roots: [plain] }));
    expect(plainOut.status, plainOut.stderr ?? "").toBe(0);
    const plainText = JSON.parse(plainOut.stdout).additional_context as string;
    // The hook serves the exact canonical contract bytes and the ordinary
    // six-choice reminder for a session with no marked destination.
    expect(plainText).toContain(contractText.trim());
    expect(plainText).toContain(
      "Subagent-driven, Inline, Handoff (new session only), Review spec first, Review plan first, Change model first",
    );
    expect(plainText).toContain("Change model first");
    expect(reminderOf(plainText)).toContain("Handoff");

    const destOut = run(marked, JSON.stringify({ workspace_roots: [marked] }));
    expect(destOut.status, destOut.stderr ?? "").toBe(0);
    const destText = JSON.parse(destOut.stdout).additional_context as string;
    expect(destText).toContain(contractText.trim());
    // The marked-session reminder carries the marker and the five-choice
    // allow-list, and never offers the originating Handoff option.
    const destReminder = reminderOf(destText);
    expect(destReminder).toContain(HANDOFF_DESTINATION_MARKER);
    expect(destReminder).not.toContain("Handoff");
    expect(destReminder).toContain(
      "Subagent-driven, Inline, Review spec first, Review plan first, Change model first",
    );
    expect(destText).toContain(
      "Subagent-driven, Inline, Review spec first, Review plan first, Change model first",
    );
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(marked, { recursive: true, force: true });
  }
});

test("session start with a missing contract reports it without pretending success", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-hook-empty-"));
  try {
    // WORKFLOW_TOOLKIT_ROOT points at a root whose templates dir exists but the
    // contract file is absent: the hook must output {} (fail-open), not error.
    mkdirSync(path.join(root, "templates"), { recursive: true });
    const r = runEntry([path.join(CURSOR_ROOT, "hooks", "session-start.ts")], {
      ...process.env,
      WORKFLOW_TOOLKIT_ROOT: root,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("{}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the TS hook and launcher sources perform no network I/O", () => {
  for (const file of [
    path.join(CURSOR_ROOT, "hooks", "session-start.ts"),
    path.join(CURSOR_ROOT, "mcp", "run-server.ts"),
  ]) {
    const src = readFileSync(file, "utf8");
    expect(src).not.toMatch(/fetch\s*\(/);
    expect(src).not.toContain("child_process");
    expect(src).not.toContain("sync-runtime");
    expect(src).not.toMatch(/git\s+(fetch|pull|clone)/);
    expect(src).not.toMatch(/\b(?:rsync|flock|npm install|curl)\b/);
  }
});
