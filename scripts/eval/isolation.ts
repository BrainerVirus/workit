// Eval world isolation (#822): every process a bench run starts gets a world
// HOME, so `~`, $HOME and every Workit path derived from them (config, grants,
// state, approvals/, the issued registry) resolve inside the world. Only the
// host's own login is linked in from the real home, so `claude` and `opencode`
// still sign in. The grants dir follows the account home, which Workit reads
// from the OS record (autonomy.ts grantsHome): under bun, which runs the CLI
// and hooks from this checkout and the OpenCode binary, that record follows
// $HOME too. The self-check proves it per world before a case that permits a
// shell wrapper starts; the tripwire (tripwire.ts) catches the rest.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { approvalsDir } from "../../packages/workit-core/src/approvals/store";
import { grantsDir } from "../../packages/workit-core/src/autonomy";
import { resolveConfigDir } from "../../packages/workit-core/src/core/config";
import { resolveStateDir } from "../../packages/workit-core/src/core/logger";
import type { EvalCase } from "./cases";

export type Host = "claude-code" | "opencode";

/**
 * What each host needs from the real home to sign in, and nothing else: no
 * settings, CLAUDE.md, skills, hooks, plugins or caches (they carry
 * instructions, permissions or code). `link` is the credential the host
 * refreshes in place, symlinked file by file into a real world dir, so
 * `cd -P ~/.claude/..` stays in the world; `copy` is state it needs to start.
 */
const HOST_LOGIN: Record<Host, { link: string[]; copy: string[] }> = {
  "claude-code": { link: [".claude/.credentials.json"], copy: [".claude.json"] },
  // OpenCode keeps its provider keys in opencode.db (seedOpencodeDb), not auth.json.
  opencode: { link: [], copy: [] },
};

/** The OpenCode db tables a fresh world copies: schema state and the provider credentials. */
const OPENCODE_ROWS = ["__drizzle_migrations", "migration", "kv", "credential"];

/**
 * A world opencode.db with the real one's schema and only its credential,
 * kv and migration rows: no session, message or project from the real home,
 * and no write ever reaches the real db. Static API keys, so a copy holds.
 */
const seedOpencodeDb = (home: string, realHome: string): boolean => {
  const real = path.join(realHome, ".local", "share", "opencode", "opencode.db");
  if (!existsSync(real)) return false;
  const into = path.join(home, ".local", "share", "opencode", "opencode.db");
  mkdirSync(path.dirname(into), { recursive: true, mode: 0o700 });
  const from = new Database(real, { readonly: true });
  const to = new Database(into, { create: true });
  try {
    const schema = from
      .query<{ type: string; name: string; sql: string }, []>(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type = 'table' DESC",
      )
      .all();
    for (const { sql } of schema) to.run(sql);
    for (const table of OPENCODE_ROWS) {
      if (!schema.some((each) => each.type === "table" && each.name === table)) continue;
      const rows = from
        .query<Record<string, SQLQueryBindings>, []>(`SELECT * FROM "${table}"`)
        .all();
      const [first] = rows;
      if (!first) continue;
      const columns = Object.keys(first);
      const insert = to.prepare(
        `INSERT INTO "${table}" (${columns.map((name) => `"${name}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      );
      to.transaction(() => {
        for (const row of rows) insert.run(...columns.map((name) => row[name] ?? null));
      })();
    }
  } finally {
    from.close();
    to.close();
  }
  chmodSync(into, 0o600);
  return true;
};

/** The real files the host's login links point at, as Landlock file rules: write and truncate only. */
export const loginFiles = (host: Host, realHome: string): string[] =>
  HOST_LOGIN[host].link
    .map((rel) => path.join(realHome, rel))
    .filter((file) => lstatSync(file, { throwIfNoEntry: false })?.isFile() === true);

/** Link (and copy) the host's login files that exist in `realHome` into the world's `home`. */
export const linkLogin = (home: string, host: Host, realHome: string): string[] => {
  const done: string[] = [];
  const { link, copy } = HOST_LOGIN[host];
  for (const rel of [...link, ...copy]) {
    const real = path.join(realHome, rel);
    if (!lstatSync(real, { throwIfNoEntry: false })?.isFile()) continue;
    const into = path.join(home, rel);
    mkdirSync(path.dirname(into), { recursive: true, mode: 0o700 });
    if (link.includes(rel)) symlinkSync(real, into);
    else copyFileSync(real, into);
    done.push(rel);
  }
  if (host === "opencode" && seedOpencodeDb(home, realHome))
    done.push(".local/share/opencode/opencode.db (credentials only)");
  return done;
};

/**
 * After a run: a host that refreshed its credential by rename replaced the
 * world's link with a file, and the real file still holds the token it
 * rotated away. Write the new bytes into the real file in place. Returns the
 * real files written.
 */
export const carryBack = (home: string, host: Host, realHome: string): string[] => {
  const written: string[] = [];
  for (const rel of HOST_LOGIN[host].link) {
    const into = path.join(home, rel);
    const real = path.join(realHome, rel);
    const stat = lstatSync(into, { throwIfNoEntry: false });
    if (!stat?.isFile() || !existsSync(real)) continue;
    const bytes = readFileSync(into);
    if (bytes.equals(readFileSync(real))) continue;
    writeFileSync(real, bytes);
    written.push(real);
  }
  return written;
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
    const found = text.match(/(?<![\w.~-])\/[\w.@+~-]+(?:\/[\w.@+~*-]+)*/gu) ?? [];
    // Each verb prints the dir or file it resolved: no path is no proof.
    if (found.length === 0) paths[label] = `no path in its output: ${text.trim().slice(0, 200)}`;
    for (const [index, each] of found.entries()) paths[`${label} #${index + 1}`] = each;
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
