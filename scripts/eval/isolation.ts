// Eval world isolation (#822): every process a bench run starts gets a world
// HOME, so `~`, $HOME and every Workit path derived from them (config, grants,
// state, approvals/, the issued registry) resolve inside the world. Only the
// host's own login is linked in from the real home, so `claude` and `opencode`
// still sign in. The grants dir follows the account home, which Workit reads
// from the OS record (autonomy.ts grantsHome): under bun, which runs the CLI
// and hooks from this checkout and the OpenCode binary, that record follows
// $HOME too. The self-check proves it per world before a case that permits a
// shell wrapper starts; the tripwire (tripwire.ts) catches the rest.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { approvalsDir } from "../../packages/workit-core/src/approvals/store";
import { grantsDir } from "../../packages/workit-core/src/autonomy";
import { resolveConfigDir } from "../../packages/workit-core/src/core/config";
import { resolveStateDir } from "../../packages/workit-core/src/core/logger";
import type { EvalCase } from "./cases";

export type Host = "claude-code" | "opencode";

/** What each host needs from the real home to sign in and run; nothing of Workit's. */
const HOST_LOGIN: Record<Host, string[]> = {
  "claude-code": [
    ".claude",
    ".claude.json",
    ".local/share/claude",
    ".local/state/claude",
    ".cache/claude",
  ],
  opencode: [".opencode", ".local/share/opencode", ".local/state/opencode", ".cache/opencode"],
};

/** Link the host's login paths that exist in `realHome` into the world's `home`. */
export const linkLogin = (home: string, host: Host, realHome: string): string[] => {
  const linked: string[] = [];
  for (const rel of HOST_LOGIN[host]) {
    const real = path.join(realHome, rel);
    if (!existsSync(real)) continue;
    const link = path.join(home, rel);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(real, link);
    linked.push(rel);
  }
  return linked;
};

/** The world HOME and XDG bases for a child env: no Workit path falls back to the real home. */
export const isolateHome = (env: Record<string, string>, home: string): void => {
  env.HOME = home;
  env.XDG_CONFIG_HOME = path.join(home, ".config");
  env.XDG_STATE_HOME = path.join(home, ".local", "state");
  env.XDG_DATA_HOME = path.join(home, ".local", "share");
  env.XDG_CACHE_HOME = path.join(home, ".cache");
  delete env.USERPROFILE;
};

const WRAPPERS = String.raw`(?:ba|z|da)?sh|python[\d.]*|node|bun|deno|perl|ruby|eval|env|xargs`;
const WRAPPER_WORD = new RegExp(String.raw`\b(?:${WRAPPERS})\b`, "iu");
const WRAPPER_RULE = new RegExp(String.raw`^Bash(?:$|\(\s*(?:\*|(?:${WRAPPERS})\b))`, "u");

/** The case's prompt names a shell wrapper, or its permissions let one run. */
export const permitsShellWrappers = (spec: EvalCase, tools: string[]): boolean =>
  spec.permissionMode === "bypassPermissions" ||
  WRAPPER_WORD.test(spec.prompt) ||
  tools.some((tool) => WRAPPER_RULE.test(tool.trim()));

const inside = (dir: string, file: string): boolean => {
  const rel = path.relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Whatever `workit` the agent's PATH finds. */
const AGENT_CLI = "workit";

/** The `--isolation-probe` side: the real resolvers in this process, and what the `workit` on PATH says. */
export const probe = (): Record<string, string> => {
  const paths: Record<string, string> = {
    home: os.homedir(),
    accountHome: os.userInfo().homedir,
    config: resolveConfigDir(),
    grants: grantsDir(),
    state: resolveStateDir(),
    approvals: approvalsDir(),
    issued: path.join(resolveStateDir(), "issued"),
  };
  for (const args of [
    ["dir", "config"],
    ["dir", "state"],
    ["grant", "show", "--json"],
    ["workspace", "list", "--json"],
  ]) {
    const run = spawnSync(AGENT_CLI, args, { encoding: "utf8", timeout: 30_000 });
    const text = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const label = `workit ${args.join(" ")}`;
    if (run.status !== 0) {
      paths[label] = `failed: ${run.error?.message ?? text.trim().slice(0, 200)}`;
      continue;
    }
    for (const [index, found] of (
      text.match(/(?<![\w.~-])\/[\w.@+~-]+(?:\/[\w.@+~*-]+)*/gu) ?? []
    ).entries())
      paths[`${label} #${index + 1}`] = found;
  }
  return paths;
};

export type SelfCheck = { ok: boolean; outside: string[]; paths: Record<string, string> };

/**
 * Run the probe as the agent's processes would run (the child env, the world
 * repo as cwd) and check that every path it resolves is inside the world.
 */
export const selfCheck = (
  worldDir: string,
  cwd: string,
  env: Record<string, string>,
  runner: string[],
): SelfCheck => {
  const [bin = "bun", ...args] = runner;
  const run = spawnSync(bin, args, { cwd, env, encoding: "utf8", timeout: 120_000 });
  let paths: Record<string, string>;
  try {
    paths = JSON.parse(run.stdout) as Record<string, string>;
  } catch {
    return { ok: false, outside: [`probe failed: ${run.stderr.trim().slice(0, 300)}`], paths: {} };
  }
  const outside = Object.entries(paths)
    .filter(([, value]) => !path.isAbsolute(value) || !inside(worldDir, value))
    .map(([key, value]) => `${key}: ${value}`);
  return { ok: outside.length === 0, outside, paths };
};
