import { expect, test } from "bun:test";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyPluginDir } from "@/packages/workit-cli/src/admin/setup";

const tempDir = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix));
const clean = (dir: string) => rmSync(dir, { recursive: true, force: true });

test("copyPluginDir materializes a real directory when the adapter root is a symlink", () => {
  const root = tempDir("wk-cursor-copy-");
  try {
    const realPkg = path.join(root, "real-pkg");
    mkdirSync(path.join(realPkg, "dist"), { recursive: true });
    writeFileSync(
      path.join(realPkg, "package.json"),
      JSON.stringify({ name: "@brainervirus/workit-cursor", version: "1.0.3" }),
    );
    writeFileSync(path.join(realPkg, "dist", "mcp-server.js"), "export {};\n");
    writeFileSync(path.join(realPkg, "mcp.json"), '{"mcpServers":{}}\n');

    const linkPkg = path.join(root, "link-pkg");
    symlinkSync(realPkg, linkPkg);

    const dest = path.join(root, "plugins", "local", "workit");
    mkdirSync(path.dirname(dest), { recursive: true });
    expect(copyPluginDir(linkPkg, dest)).toBe("Installed");
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(lstatSync(dest).isDirectory()).toBe(true);
    expect(readFileSync(path.join(dest, "package.json"), "utf8")).toContain("workit-cursor");
    // realpathSync: macOS tmpdir may be /var vs /private/var
    expect(readFileSync(path.join(dest, ".workit-root"), "utf8").trim()).toBe(
      realpathSync(realPkg),
    );

    // Replacing a prior fragile symlink install must also materialize.
    rmSync(dest, { recursive: true, force: true });
    symlinkSync(realPkg, dest);
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(copyPluginDir(linkPkg, dest)).toBe("Configured");
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(() => readlinkSync(dest)).toThrow();
  } finally {
    clean(root);
  }
});

test("copyPluginDir writes absolute launcher paths into the hooks and stays idempotent", () => {
  const root = tempDir("wk-cursor-copy-hooks-");
  try {
    const pkg = path.join(root, "pkg");
    mkdirSync(path.join(pkg, "hooks"), { recursive: true });
    copyFileSync(
      path.resolve(import.meta.dir, "../../packages/workit-cursor/hooks/hooks-cursor.json"),
      path.join(pkg, "hooks", "hooks-cursor.json"),
    );
    const dest = path.join(root, "plugins", "local", "workit");
    expect(copyPluginDir(pkg, dest)).toBe("Installed");
    const text = readFileSync(path.join(dest, "hooks", "hooks-cursor.json"), "utf8");
    expect(text).not.toContain("${CURSOR_PLUGIN_ROOT}");
    const hooks = JSON.parse(text).hooks as Record<string, { command: string }[]>;
    const launcher = `node "${path.join(dest, "hooks", "launch.mjs")}"`;
    expect(hooks.sessionStart[0].command).toBe(`${launcher} workit-cursor-session-start`);
    expect(hooks.beforeShellExecution[0].command).toBe(`${launcher} workit-cursor-hook`);
    // The localized file is the expected installed content, not drift.
    expect(copyPluginDir(pkg, dest)).toBe("Skipped");
  } finally {
    clean(root);
  }
});
