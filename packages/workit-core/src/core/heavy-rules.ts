// Host permission rules the heavy-command gate must not override (#325,
// ruling mvid5onk). A heavy command is wrapped through the lease only when no
// readable deny/ask rule names it and wrapping does not raise its permission
// (an allow that covers `workit` but not the command itself). The matcher is
// conservative: anything it cannot read for sure counts as naming the
// command, so the gate steps aside and the host decides.
//
// Sources, per host:
//   - Claude Code: managed-settings.json, the user settings
//     ($CLAUDE_CONFIG_DIR or ~/.claude), <project>/.claude/settings.json and
//     settings.local.json: permissions.deny/ask/allow `Bash(...)` and `Bash`;
//   - OpenCode: ~/.config/opencode/opencode.json(c), opencode.json(c) and
//     .opencode/opencode.json(c) up to the git top, OPENCODE_CONFIG,
//     OPENCODE_CONFIG_CONTENT: permission.bash / permission.shell and every
//     agent.*.permission;
//   - Codex: ~/.codex/rules/*.rules and <project>/.codex/rules/*.rules
//     (`prefix_rule(pattern=[…], decision=…)`);
//   - Cursor: ~/.cursor/cli-config.json and <project>/.cursor/cli.json,
//     permissions.deny/allow `Shell(x)`.
// Hook-safe: node built-ins only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** One rule: its pattern (`npx jest:*`, `*`, `` for a bare tool rule). */
export type Rules = { deny: string[]; allow: string[] };
/** Rules read from the host, or `unreadable` when any source could not be read for sure. */
export type RuleRead = Rules | "unreadable";

const EMPTY = (): Rules => ({ deny: [], allow: [] });

const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON with `//` and `/* *\/` comments and trailing commas (opencode.jsonc). */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = index;
      const match = end.exec(text);
      if (!match) throw new Error("unterminated string");
      out += match[0];
      index += match[0].length - 1;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
    } else if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      if (close < 0) throw new Error("unterminated comment");
      index = close + 1;
    } else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/gu, "$1"));
}

/** The git top of `cwd` (the nearest directory with `.git`), or null. */
export function gitTop(cwd: string): string | null {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/** `cwd` and its parents up to the git top (or just `cwd` outside git). */
const projectDirs = (cwd: string): string[] => {
  const top = gitTop(cwd);
  const dirs: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (!top || dir === top || path.dirname(dir) === dir) return dirs;
  }
};

const homeOf = (env: NodeJS.ProcessEnv) => env.HOME || os.homedir();

// --- Claude Code -----------------------------------------------------------

const CLAUDE_MANAGED: Partial<Record<NodeJS.Platform, string>> = {
  linux: "/etc/claude-code/managed-settings.json",
  darwin: "/Library/Application Support/ClaudeCode/managed-settings.json",
  win32: "C:\\Program Files\\ClaudeCode\\managed-settings.json",
};

/** The Claude Code settings files the gate reads, most authoritative first. */
export function claudeSettingsFiles(
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const project = env.CLAUDE_PROJECT_DIR || gitTop(cwd) || cwd;
  const user = env.CLAUDE_CONFIG_DIR || path.join(homeOf(env), ".claude");
  return [
    ...(CLAUDE_MANAGED[platform] ? [CLAUDE_MANAGED[platform]] : []),
    path.join(user, "settings.json"),
    path.join(project, ".claude", "settings.json"),
    path.join(project, ".claude", "settings.local.json"),
  ];
}

/** `Bash(x)` → `x`, `Bash` → ``, any other tool → null. */
const bashPattern = (entry: string): string | null => {
  const match = /^Bash(?:\((.*)\))?$/su.exec(entry.trim());
  return match ? (match[1] ?? "") : null;
};

export function claudeRules(cwd: string, env: NodeJS.ProcessEnv = process.env): RuleRead {
  const rules = EMPTY();
  try {
    for (const file of claudeSettingsFiles(cwd, env)) {
      const text = readText(file);
      if (text === null) continue;
      const value: unknown = JSON.parse(text);
      if (!isRecord(value)) return "unreadable";
      const permissions = value.permissions;
      if (permissions === undefined) continue;
      if (!isRecord(permissions)) return "unreadable";
      for (const [key, bucket] of [
        ["deny", rules.deny],
        ["ask", rules.deny],
        ["allow", rules.allow],
      ] as const) {
        const list = permissions[key];
        if (list === undefined) continue;
        if (!Array.isArray(list)) return "unreadable";
        for (const entry of list) {
          if (typeof entry !== "string") return "unreadable";
          const pattern = bashPattern(entry);
          if (pattern !== null) bucket.push(pattern);
        }
      }
    }
  } catch {
    return "unreadable";
  }
  return rules;
}

// --- OpenCode ---------------------------------------------------------------

const OPENCODE_NAMES = ["opencode.json", "opencode.jsonc"];

/** A `permission` block's bash/shell rules into `rules`; false when it cannot be read. */
const opencodePermission = (permission: unknown, rules: Rules): boolean => {
  if (permission === undefined) return true;
  if (typeof permission === "string") {
    // A blanket permission covers every tool, the shell included.
    (permission === "allow" ? rules.allow : rules.deny).push("");
    return ["allow", "ask", "deny"].includes(permission);
  }
  if (!isRecord(permission)) return false;
  for (const key of ["bash", "shell"]) {
    const value = permission[key];
    if (value === undefined) continue;
    if (typeof value === "string") {
      if (!["allow", "ask", "deny"].includes(value)) return false;
      (value === "allow" ? rules.allow : rules.deny).push("");
      continue;
    }
    if (!isRecord(value)) return false;
    for (const [pattern, action] of Object.entries(value)) {
      if (action !== "allow" && action !== "ask" && action !== "deny") return false;
      (action === "allow" ? rules.allow : rules.deny).push(pattern);
    }
  }
  return true;
};

const opencodeConfig = (value: unknown, rules: Rules): boolean => {
  if (!isRecord(value)) return false;
  if (!opencodePermission(value.permission, rules)) return false;
  if (value.agent === undefined) return true;
  if (!isRecord(value.agent)) return false;
  return Object.values(value.agent).every(
    (agent) => isRecord(agent) && opencodePermission(agent.permission, rules),
  );
};

export function opencodeRules(cwd: string, env: NodeJS.ProcessEnv = process.env): RuleRead {
  const rules = EMPTY();
  try {
    const config = env.XDG_CONFIG_HOME || path.join(homeOf(env), ".config");
    const files = [
      ...OPENCODE_NAMES.map((name) => path.join(config, "opencode", name)),
      ...projectDirs(cwd).flatMap((dir) =>
        OPENCODE_NAMES.flatMap((name) => [path.join(dir, name), path.join(dir, ".opencode", name)]),
      ),
      ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : []),
    ];
    for (const file of files) {
      const text = readText(file);
      if (text !== null && !opencodeConfig(parseJsonc(text), rules)) return "unreadable";
    }
    if (
      env.OPENCODE_CONFIG_CONTENT &&
      !opencodeConfig(parseJsonc(env.OPENCODE_CONFIG_CONTENT), rules)
    )
      return "unreadable";
  } catch {
    return "unreadable";
  }
  return rules;
}

// --- Codex ------------------------------------------------------------------

/**
 * `prefix_rule(pattern=["npx", "jest"], decision="forbidden")` → its rule
 * (the words joined), or null when in doubt: no pattern list, a nested
 * alternatives list, a non-string word, or no known decision.
 */
const codexRule = (body: string): { pattern: string; decision: string } | null => {
  const open = /\bpattern\s*=\s*\[/u.exec(body);
  if (!open) return null;
  const words: string[] = [];
  let index = open.index + open[0].length;
  for (;;) {
    while (/[\s,]/u.test(body[index] ?? "")) index += 1;
    if (body[index] === "]") break;
    if (body[index] !== '"') return null;
    const literal = /"((?:[^"\\]|\\.)*)"/y;
    literal.lastIndex = index;
    const match = literal.exec(body);
    if (!match) return null;
    words.push(JSON.parse(`"${match[1]}"`) as string);
    index = literal.lastIndex;
  }
  const decision = /\bdecision\s*=\s*"(\w+)"/u.exec(body)?.[1];
  if (!words.length || !decision || !["allow", "prompt", "forbidden"].includes(decision))
    return null;
  return { pattern: words.join(" "), decision };
};

export function codexRules(cwd: string, env: NodeJS.ProcessEnv = process.env): RuleRead {
  const rules = EMPTY();
  try {
    const home = env.CODEX_HOME || path.join(homeOf(env), ".codex");
    const top = gitTop(cwd) ?? cwd;
    for (const dir of [path.join(home, "rules"), path.join(top, ".codex", "rules")]) {
      let files: string[];
      try {
        files = fs.readdirSync(dir).filter((name) => name.endsWith(".rules"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return "unreadable";
      }
      for (const name of files) {
        const text = readText(path.join(dir, name)) ?? "";
        for (const part of text.split(/\bprefix_rule\s*\(/u).slice(1)) {
          const rule = codexRule(part);
          if (!rule) return "unreadable";
          (rule.decision === "allow" ? rules.allow : rules.deny).push(rule.pattern);
        }
      }
    }
  } catch {
    return "unreadable";
  }
  return rules;
}

// --- Cursor -----------------------------------------------------------------

export function cursorRules(cwd: string, env: NodeJS.ProcessEnv = process.env): RuleRead {
  const rules = EMPTY();
  try {
    const top = gitTop(cwd) ?? cwd;
    for (const file of [
      path.join(homeOf(env), ".cursor", "cli-config.json"),
      path.join(top, ".cursor", "cli.json"),
    ]) {
      const text = readText(file);
      if (text === null) continue;
      const value: unknown = JSON.parse(text);
      if (!isRecord(value)) return "unreadable";
      if (value.permissions === undefined) continue;
      if (!isRecord(value.permissions)) return "unreadable";
      for (const [key, bucket] of [
        ["deny", rules.deny],
        ["allow", rules.allow],
      ] as const) {
        const list = value.permissions[key];
        if (list === undefined) continue;
        if (!Array.isArray(list)) return "unreadable";
        for (const entry of list) {
          if (typeof entry !== "string") return "unreadable";
          const match = /^Shell(?:\((.*)\))?$/su.exec(entry.trim());
          if (match) bucket.push(match[1] ?? "");
        }
      }
    }
  } catch {
    return "unreadable";
  }
  return rules;
}

// --- the matcher --------------------------------------------------------------

const baseName = (word: string): string =>
  (word.split(/[\\/]/u).at(-1) ?? "").toLowerCase().replace(/\.(?:exe|cmd|bat)$/u, "");

/** A pattern's first token: cut at `:` or a space. */
const firstToken = (pattern: string): string => pattern.trim().split(/[:\s]/u)[0] ?? "";

/** Does a deny/ask `pattern` name a command with these words? */
export function names(pattern: string, words: readonly string[]): boolean {
  const token = firstToken(pattern);
  if (!token || token === "*" || token.includes("*")) return true;
  const wanted = baseName(token);
  return words.some((word) => baseName(word) === wanted);
}

/** A pattern's literal prefix, without a trailing `:*`, ` *` or `*`. */
const literalPrefix = (pattern: string): string => pattern.trim().replace(/(?::\*| \*|\*)$/u, "");

/**
 * Could an allow `pattern` cover the wrapper (`workit check --heavy -- …`)?
 * A bare rule, a first word with a glob, or a literal prefix of the wrapper
 * (`workit`, `workit check`). `workit git push:*` cannot match it.
 */
const coversWrapper = (pattern: string): boolean => {
  const token = firstToken(pattern);
  if (!token || token.includes("*")) return true;
  const words = literalPrefix(pattern).split(/\s+/u);
  if (baseName(words[0]) !== "workit") return false;
  return ["check", "--heavy"].slice(0, words.length - 1).every((word, at) => {
    const given = words[at + 1];
    return given === word || word.startsWith(given);
  });
};

/** Does an allow `pattern` cover `command` by a literal prefix? */
const coversCommand = (pattern: string, command: string): boolean => {
  const prefix = literalPrefix(pattern);
  if (!prefix) return true;
  return !prefix.includes("*") && command.trim().startsWith(prefix);
};

export type RuleVerdict = { ok: true } | { ok: false; why: "named" | "allowlisted" };

/**
 * May the gate wrap a heavy command? Not when a deny/ask rule names a word
 * of it (`words`), and not when an allow covers `workit` but not `command`
 * (wrapping would raise its permission; skipped with `bypass`).
 */
export function wrapAllowed(
  read: RuleRead,
  words: readonly string[],
  command: string,
  options: { bypass?: boolean } = {},
): RuleVerdict {
  if (read === "unreadable") return { ok: false, why: "named" };
  if (read.deny.some((pattern) => names(pattern, words))) return { ok: false, why: "named" };
  if (
    !options.bypass &&
    read.allow.some(coversWrapper) &&
    !read.allow.some((pattern) => coversCommand(pattern, command))
  )
    return { ok: false, why: "allowlisted" };
  return { ok: true };
}
