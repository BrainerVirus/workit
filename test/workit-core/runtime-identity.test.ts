import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundleHashOfFile,
  isEphemeralCachePath,
  sha256Hex,
} from "@/packages/workit-core/src/core/runtime-identity";
import {
  resolveExternalActionRequest,
  upgradeBranchSetupForStash,
} from "@/packages/workit-core/src/core/external-action-effects";
import { success } from "@/packages/workit-core/src/core/task-contract";
import type { ExternalActionRequest } from "@/packages/workit-core/src/core/external-action";

test("ephemeral cache paths are recognized by content, not by caller", () => {
  for (const p of [
    "file:///home/u/.cache/pnpm/dlx/abc/package.json",
    "file:///tmp/_npx/123/package.json",
    "file:///home/u/.pacquet/x/package.json",
    "file:///Users/u/Library/Caches/pnpm/abc/package.json",
    "file://C:\\Users\\u\\_npx\\abc\\package.json",
  ])
    expect(isEphemeralCachePath(p), p).toBe(true);
  for (const p of [
    "@brainervirus/workit-opencode",
    "@brainervirus/workit-opencode@latest",
    "file:///home/u/checkout/packages/workit-opencode",
    "/home/u/.cursor/plugins/local/workit",
    "",
  ])
    expect(isEphemeralCachePath(p), p).toBe(false);
});

test("bundle hashes are stable hex digests of the exact bytes", () => {
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const dir = mkdtempSync(join(tmpdir(), "workit-hash-"));
  try {
    const file = join(dir, "bundle.js");
    writeFileSync(file, "#!/usr/bin/env node\n// bundle\n");
    expect(bundleHashOfFile(file)).toBe(sha256Hex("#!/usr/bin/env node\n// bundle\n"));
    writeFileSync(file, "#!/usr/bin/env node\n// bundle!\n");
    expect(bundleHashOfFile(file)).not.toBe(sha256Hex("#!/usr/bin/env node\n// bundle\n"));
    expect(bundleHashOfFile(join(dir, "missing.js"))).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd });

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "workit-stash-"));
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "t@t"],
    ["config", "user.name", "T"],
  ])
    git(root, args);
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, ["add", "base.txt"]);
  git(root, ["commit", "-qm", "base"]);
  return root;
};

const branchSetup = (target: string, stash?: "yes"): ExternalActionRequest => ({
  operation: "git.branch_setup",
  payload: {
    action: "setup",
    ...(target ? { target_branch: target } : {}),
    ...(stash ? { stash } : {}),
  },
});

test("stash upgrade binds stash up front only for stash-required dirt", () => {
  const root = repo();
  try {
    // Clean tree: untouched.
    const clean = resolveExternalActionRequest(root, branchSetup("feature/x"));
    if (!clean.ok) throw new Error(clean.error);
    expect(upgradeBranchSetupForStash(root, branchSetup("feature/x"), clean)).toBe(clean);
    // Carry-class dirt (untracked file) rides along silently.
    writeFileSync(join(root, "notes.txt"), "notes\n");
    const carry = resolveExternalActionRequest(root, branchSetup("feature/x"));
    if (!carry.ok) throw new Error(carry.error);
    expect(upgradeBranchSetupForStash(root, branchSetup("feature/x"), carry)).toBe(carry);
    // Stash-required dirt (tracked modification): one approval carries stash.
    writeFileSync(join(root, "base.txt"), "changed\n");
    const dirty = resolveExternalActionRequest(root, branchSetup("feature/x"));
    if (!dirty.ok) throw new Error(dirty.error);
    const upgraded = upgradeBranchSetupForStash(root, branchSetup("feature/x"), dirty);
    expect(upgraded).not.toBe(dirty);
    if (!upgraded.ok) throw new Error(upgraded.error);
    expect(upgraded.data.request.operation).toBe("git.branch_setup");
    if (upgraded.data.request.operation !== "git.branch_setup") throw new Error("op changed");
    expect(upgraded.data.request.payload.stash).toBe("yes");
    // Already bound: untouched. Other operations: untouched.
    const bound = resolveExternalActionRequest(root, branchSetup("feature/x", "yes"));
    if (!bound.ok) throw new Error(bound.error);
    expect(upgradeBranchSetupForStash(root, branchSetup("feature/x", "yes"), bound)).toBe(bound);
    // Other operations pass through untouched.
    const other = success(null, null, {
      request: { operation: "git.push" as const, payload: { branch: "main" } },
      descriptorPayload: {},
    });
    expect(
      upgradeBranchSetupForStash(
        root,
        { operation: "git.push", payload: { branch: "main" } },
        other,
      ),
    ).toBe(other);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
