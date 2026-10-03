// Shared helpers for the Claude Code plugin suites: run the real hook
// launcher (bin/workit-hook.mjs) as Claude does, in either runtime.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Ajv from "ajv";

export const PLUGIN_DIR = path.resolve(import.meta.dir, "../../packages/workit-claude-code");
const BUILD = path.join(PLUGIN_DIR, "scripts", "build.ts");

let installed: string | null = null;

/**
 * An installed-layout copy of the plugin (no monorepo sibling, so the
 * launcher takes dist/), built once per test process into a temp dir.
 */
export const installedPlugin = (): string => {
  if (installed) return installed;
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "workit-claude-plugin-")), "workit");
  for (const part of [".claude-plugin", "hooks", "bin", "agents", "package.json"])
    cpSync(path.join(PLUGIN_DIR, part), path.join(dir, part), { recursive: true });
  const built = spawnSync(process.execPath, [BUILD, dir], { encoding: "utf8" });
  if (built.status !== 0) throw new Error(`plugin build failed: ${built.stderr || built.stdout}`);
  installed = dir;
  // Shared by every suite in this test process; removed when it exits.
  process.once("exit", () => rmSync(path.dirname(dir), { recursive: true, force: true }));
  return dir;
};

export type HookRun = { status: number | null; stdout: string; stderr: string; json: unknown };

/** Pipe one native payload through `node <plugin>/bin/workit-hook.mjs`. */
export const runHook = (
  pluginDir: string,
  payload: unknown,
  env: Record<string, string | undefined> = {},
): HookRun => {
  const child = spawnSync("node", [path.join(pluginDir, "bin", "workit-hook.mjs")], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  let json: unknown = null;
  try {
    json = JSON.parse(child.stdout);
  } catch {
    json = null;
  }
  return { status: child.status, stdout: child.stdout, stderr: child.stderr, json };
};

const ajv = new Ajv({ strict: true, allErrors: true });
const validateOutput = ajv.compile(
  JSON.parse(
    readFileSync(
      path.resolve(import.meta.dir, "../fixtures/claude-code-schemas/hook-output.schema.json"),
      "utf8",
    ),
  ),
);

/** Null when `output` is valid hook output for `event`, else the reason. */
export const outputProblem = (event: string, output: unknown): string | null => {
  if (!validateOutput(output)) return ajv.errorsText(validateOutput.errors);
  const specific = (output as { hookSpecificOutput?: { hookEventName?: string } })
    .hookSpecificOutput;
  if (specific && specific.hookEventName !== event)
    return `hookSpecificOutput.hookEventName ${specific.hookEventName} answers ${event}`;
  return null;
};
