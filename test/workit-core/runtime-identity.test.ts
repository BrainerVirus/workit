import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundleHashOfFile,
  isEphemeralCachePath,
  sha256Hex,
} from "@/packages/workit-core/src/core/runtime-identity";

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
