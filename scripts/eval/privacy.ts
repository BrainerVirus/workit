// Bench privacy: evals/results is committed to a public repo, so before the
// runner writes a result it (1) rewrites the account's home, user and host
// names, (2) replaces the result of every tool call that read or listed a
// path outside the world with a marker naming only the path class and byte
// length, and (3) refuses to write a file that still holds a string from the
// real account (its Workit config values, its host's project paths, its git
// identity, its home). The private set lives in memory only: never written,
// never logged; a refusal names the file and the kind of string, never it.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { workitDir } from "../../packages/workit-core/src/core/workit-paths.mjs";

// ------------------------------------------------------------ spellings

export type Account = { homes: string[]; user: string; host: string };

/** The account's home in every absolute spelling (the OS record's, the runtime's, resolved), its user and host names. */
export const accountOf = (realHome: string): Account => {
  const homes = new Set([realHome, os.homedir(), os.userInfo().homedir]);
  for (const home of homes)
    try {
      homes.add(realpathSync(home));
    } catch {
      // A home that does not exist has no other spelling.
    }
  return {
    homes: [...homes].filter((home) => home.length > 1).toSorted((a, b) => b.length - a.length),
    user: os.userInfo().username,
    host: os.hostname(),
  };
};

const escape = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const whole = (text: string): RegExp => new RegExp(`(?<![\\w.-])${escape(text)}(?![\\w-])`, "gu");
/** A host's project slug: the path with each separator a `-`, so more of it may follow. */
const slug = (text: string): RegExp => new RegExp(`(?<!\\w)${escape(text)}(?!\\w)`, "gu");

/** The home (also as a host's project slug) becomes `~`/`<home>`, the user `<user>`, the host `<host>`. */
export const scrubAccount = (text: string, account: Account): string => {
  let out = text;
  for (const home of account.homes)
    out = out
      .replaceAll(whole(home), "~")
      .replaceAll(slug(home.replaceAll(/[^\w]/gu, "-")), "<home>");
  if (account.user.length > 1) out = out.replaceAll(account.user, "<user>");
  if (account.host.length > 2 && account.host !== "localhost")
    out = out.replaceAll(whole(account.host), "<host>");
  return out;
};

// ------------------------------------------------------------ outside-world reads

export type PathClass =
  | "real config"
  | "real state"
  | "host config"
  | "home"
  | "unresolved"
  | "system";

const CLASSES: [RegExp, PathClass][] = [
  [/^~\/\.config\/workit(?:\/|$)/u, "real config"],
  [/^~\/\.local\/state\/workit(?:\/|$)/u, "real state"],
  [
    /^~\/(?:\.claude(?:\.json)?|\.codex|\.cursor|\.config\/opencode|\.local\/share\/opencode|\.pi)(?:\/|$)/u,
    "host config",
  ],
  [/^~(?:\/|$)/u, "home"],
];
const RANK: PathClass[] = [
  "real config",
  "real state",
  "host config",
  "home",
  "unresolved",
  "system",
];

/** The world's project dir: a host call's cwd unless the call says otherwise. */
const WORLD_CWD = "<world>/repo";

/**
 * The variables the bench world sets, spelled as the scrub classes them:
 * HOME and the XDG bases count as the real home (`~`), as `~` does.
 */
const HOME_VARS: Record<string, string> = {
  HOME: "~",
  XDG_CONFIG_HOME: "~/.config",
  XDG_DATA_HOME: "~/.local/share",
  XDG_STATE_HOME: "~/.local/state",
  XDG_CACHE_HOME: "~/.cache",
};

/** `word` with its variables expanded; null when one is unknown or a substitution runs. */
const expand = (word: string, cwd: string | null): string | null => {
  if (word.includes("$(") || word.includes("`")) return null;
  let unknown = false;
  const out = word.replaceAll(/\$\{?(\w+)\}?/gu, (_, name: string) => {
    const value = name === "PWD" ? cwd : HOME_VARS[name];
    if (value === undefined || value === null) unknown = true;
    return value ?? "";
  });
  return unknown ? null : out;
};

/** Where a path that cannot be resolved with certainty may land, by what it names. */
const byTail = (name: string): PathClass => {
  const tail = name.replace(/^(?:\.{1,2}\/)+/u, "");
  for (const [pattern, kind] of CLASSES.slice(0, 3))
    if (pattern.test(`~/${tail}`) || pattern.test(`~${tail.slice(tail.search(/\/\.[\w.]/u))}`))
      return kind;
  return "unresolved";
};

const DEV = /^\/dev\/(?:null|stdin|stdout|stderr|tty|fd\/\d+)$/u;

/**
 * `raw` resolved against `cwd` (null: not certain): the path it names, or
 * a class when it is outside the world or cannot be resolved. Inside the
 * world: `<world>/…`, the Workit checkout `<workit>/…`, a relative path
 * from a cwd inside them, /dev streams. `~`, `$HOME` and the XDG bases count
 * as outside: a host's file tool may expand `~` to the real home. A `..`,
 * an unknown variable or a relative path from an unknown cwd is unresolved.
 */
const resolveName = (raw: string, cwd: string | null): { inside: string } | { kind: PathClass } => {
  const name = expand(raw.trim(), cwd);
  if (name === null) return { kind: byTail(raw) };
  if (name === "" || name.startsWith("//") || DEV.test(name)) return { inside: name };
  if (name.split("/").includes("..")) return { kind: byTail(name) };
  if (name.startsWith("<world>") || name.startsWith("<workit>")) return { inside: name };
  if (name.startsWith("/") || name.startsWith("~") || /^[A-Za-z]:[\\/]/u.test(name))
    return { kind: CLASSES.find(([pattern]) => pattern.test(name))?.[1] ?? "system" };
  if (cwd === null) return { kind: byTail(name) };
  return resolveName(`${cwd}/${name.replace(/^\.\//u, "")}`, cwd);
};

/** The class of a path a call names, from the world's project dir; null inside the world. */
export const pathClass = (raw: string, cwd: string | null = WORLD_CWD): PathClass | null => {
  const resolved = resolveName(raw, cwd);
  return "kind" in resolved ? resolved.kind : null;
};

/** A shell script's segments (split on `&&`, `||`, `;`, `|`, `&`, newlines, parentheses) as words, quotes removed. */
const segments = (script: string): string[][] => {
  const out: string[][] = [[]];
  let word = "";
  let quote = "";
  let has = false;
  const end = (): void => {
    if (has) out.at(-1)?.push(word);
    word = "";
    has = false;
  };
  for (const char of script) {
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      has = true;
    } else if (/\s/u.test(char) && char !== "\n") end();
    else if ("&|;\n()".includes(char)) {
      end();
      if (out.at(-1)?.length) out.push([]);
    } else {
      word += char;
      has = true;
    }
  }
  end();
  return out.filter((each) => each.length > 0);
};

/** The classes of every path a shell script names, following its `cd`s from `start`. */
const shellClasses = (script: string, start: string | null): PathClass[] => {
  const classes: PathClass[] = [];
  let cwd = start;
  for (const words of segments(script)) {
    const args = words.slice(words.findIndex((each) => !/^\w+=/u.test(each)));
    const [command = "", ...rest] = args;
    if (command === "cd" || command === "pushd") {
      const target = rest.find((each) => !each.startsWith("-")) ?? "~";
      const resolved = target === "-" ? null : resolveName(target, cwd);
      cwd =
        resolved && "inside" in resolved
          ? resolved.inside
          : resolved?.kind === "unresolved" || !resolved
            ? null
            : (expand(target, cwd) ?? null);
      continue;
    }
    if (command === "popd") {
      cwd = null;
      continue;
    }
    const names = [
      ...words
        .filter((each) => /^\w+=/u.test(each))
        .map((each) => each.slice(each.indexOf("=") + 1)),
      ...(command.includes("/") ? [command] : []),
      ...rest.flatMap((each) => {
        const word = each.replace(/^\d*[<>]+/u, "");
        if (word === "" || word.startsWith("&")) return [];
        if (word.startsWith("-"))
          return word.includes("=") ? [word.slice(word.indexOf("=") + 1)] : [];
        return [word];
      }),
    ];
    for (const name of names) {
      const kind = pathClass(name, cwd);
      if (kind) classes.push(kind);
    }
  }
  return classes;
};

const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "workdir", "cwd"];
const SHELLS = new Set(["Bash", "shell", "bash"]);
const GLOBS = new Set(["Glob", "glob"]);

/** The most private class among the paths a call reads or lists, or null when all are inside. */
const callClass = (tool: string, input: Record<string, unknown>): PathClass | null => {
  const dir = input.workdir ?? input.cwd;
  const start = typeof dir === "string" ? resolveName(dir, WORLD_CWD) : { inside: WORLD_CWD };
  const cwd = "inside" in start ? start.inside : null;
  const names = PATH_KEYS.map((key) => input[key]);
  if (GLOBS.has(tool)) names.push(input.pattern);
  const classes = names
    .filter((name): name is string => typeof name === "string")
    .map((name) => pathClass(name, cwd))
    .filter((each): each is PathClass => each !== null);
  if (SHELLS.has(tool)) classes.push(...shellClasses(String(input.command ?? ""), cwd));
  return classes.length === 0 ? null : (RANK.find((each) => classes.includes(each)) ?? "system");
};

/** A host's or a hook's refusal: Workit's or the host's words, no file content, and the grader reads it. */
const DENIAL =
  /^(?:PreToolUse:\S+ hook (?:blocking )?error|Permission denied: \w+$|Claude requested permissions)/u;

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("\n");
  return content === undefined || content === null ? "" : JSON.stringify(content);
};

const marker = (kind: PathClass, content: unknown): string =>
  `<outside-world file: ${kind}, ${Buffer.byteLength(textOf(content))} bytes>`;

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;

/** Claude Code stream-json: a tool_result whose tool_use read outside the world. */
const scrubClaude = (lines: (Json | null)[]): void => {
  const calls = new Map<string, PathClass | null>();
  for (const event of lines) {
    const content = record(event?.message)?.content;
    if (event?.type !== "assistant" || !Array.isArray(content)) continue;
    for (const block of content.map(record))
      if (block?.type === "tool_use" && typeof block.id === "string")
        calls.set(block.id, callClass(String(block.name ?? ""), record(block.input) ?? {}));
  }
  for (const event of lines) {
    const content = record(event?.message)?.content;
    if (!event || event.type !== "user" || !Array.isArray(content)) continue;
    const file = record(record(event.tool_use_result)?.file);
    const resolved = typeof file?.filePath === "string" ? pathClass(file.filePath) : null;
    for (const block of content.map(record)) {
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const kind = calls.get(block.tool_use_id) ?? resolved;
      if (!kind || DENIAL.test(textOf(block.content))) continue;
      block.content = marker(kind, block.content);
      if ("tool_use_result" in event) event.tool_use_result = marker(kind, event.tool_use_result);
    }
  }
};

/** OpenCode `run --format json`: a tool part whose input reads outside the world. */
const scrubOpencode = (lines: (Json | null)[]): void => {
  for (const event of lines) {
    const part = record(event?.part);
    const state = record(part?.state);
    if (event?.type !== "tool_use" || !part || !state) continue;
    const kind = callClass(String(part.tool ?? ""), record(state.input) ?? {});
    if (!kind) continue;
    if (state.output !== undefined) state.output = marker(kind, state.output);
    if (state.error !== undefined && !DENIAL.test(textOf(state.error)))
      state.error = marker(kind, state.error);
    for (const key of Object.keys(state))
      if (!["status", "input", "output", "error", "title", "time"].includes(key)) delete state[key];
  }
};

/** Both hosts' transcripts: every outside-world read keeps only its path class and byte length. */
export const scrubOutsideReads = (transcript: string): string => {
  const raw = transcript.split("\n");
  const lines = raw.map((line) => {
    if (!line.trim().startsWith("{")) return null;
    try {
      return record(JSON.parse(line));
    } catch {
      return null;
    }
  });
  const before = lines.map((line) => (line ? JSON.stringify(line) : null));
  if (lines.some((line) => typeof line?.sessionID === "string")) scrubOpencode(lines);
  else scrubClaude(lines);
  return raw
    .map((line, at) => {
      const event = lines[at];
      if (!event) return line;
      const after = JSON.stringify(event);
      return after === before[at] ? line : after;
    })
    .join("\n");
};

// ------------------------------------------------------------ the private set

export type PrivateKind =
  | "real Workit config value"
  | "host project path"
  | "git user name"
  | "git user email"
  | "home path";
export type PrivateSet = Map<string, PrivateKind>;

/** Workit's own vocabulary (enums, presets, model names, default branches): public, never a leak. */
export const workitVocabulary = (repo: string): ((text: string) => boolean) => {
  const dir = path.join(repo, "packages", "workit-core", "schemas");
  const schemas = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => readFileSync(path.join(dir, name), "utf8"))
        .join("\n")
    : "";
  // Model names and efforts, default branch names and branch-prefix patterns.
  const words = new Set([
    "opus",
    "sonnet",
    "haiku",
    "fable",
    "medium",
    "xhigh",
    "main",
    "master",
    "develop",
    "development",
    "production",
    "staging",
    "feature/*",
    "bugfix/*",
    "release/*",
    "hotfix/*",
    "support/*",
  ]);
  return (text) => words.has(text) || schemas.includes(text);
};

/**
 * An account file the private set is built from exists but cannot be read
 * or parsed: the set would miss what it holds, so no run starts. The
 * message names the file and the reason, never its content.
 */
export class PrivateSetUnreadable extends Error {}

/** The file's text; null when it does not exist; throws when it exists and cannot be read. */
const readAccountFile = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
    if (code === "ENOENT") return null;
    throw new PrivateSetUnreadable(`${file}: ${code}`);
  }
};

/** The file's JSON; null when it does not exist; throws on a file that is not valid JSON. */
const readJson = (file: string): unknown => {
  const text = readAccountFile(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    // The parser's message quotes the content: only the reason goes out.
    throw new PrivateSetUnreadable(`${file}: not valid JSON`);
  }
};

const collect = (value: unknown, into: string[]): void => {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const each of value) collect(each, into);
  else if (record(value))
    for (const [key, each] of Object.entries(value as Json)) {
      // `$schema` names the published package: public.
      if (key.startsWith("$")) continue;
      into.push(key);
      collect(each, into);
    }
};

/** The values of `pattern` keys in a git config file; exit 1 is no match, anything else a file git cannot parse. */
const gitValues = (file: string, pattern: string): string[] => {
  readAccountFile(file);
  const run = spawnSync("git", ["config", "--file", file, "--get-regexp", pattern], {
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (run.status !== 0 && run.status !== 1)
    throw new PrivateSetUnreadable(`${file}: git cannot parse it (exit ${run.status ?? "none"})`);
  return (run.stdout ?? "")
    .split("\n")
    .map((line) => line.slice(line.indexOf(" ") + 1).trim())
    .filter((value, at, all) => value.length > 0 && all.indexOf(value) === at);
};

/**
 * Every git identity of the account: its global files and each file they
 * include, conditional ones too (an identity per directory is common).
 */
const gitIdentities = (
  home: string,
  env: NodeJS.ProcessEnv,
): { names: string[]; emails: string[] } => {
  const xdg = env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  const files = [path.join(home, ".gitconfig"), path.join(xdg, "git", "config")].filter(existsSync);
  // An include may include more: the loop reaches files pushed while it runs.
  for (const file of files)
    for (const include of gitValues(file, String.raw`^include(if\..*)?\.path$`)) {
      const full = include.startsWith("~/")
        ? path.join(home, include.slice(2))
        : path.resolve(path.dirname(file), include);
      if (existsSync(full) && !files.includes(full)) files.push(full);
    }
  return {
    names: files.flatMap((file) => gitValues(file, String.raw`^user\.name$`)),
    emails: files.flatMap((file) => gitValues(file, String.raw`^user\.email$`)),
  };
};

/**
 * The real account's private strings, in memory only: every string of 6+
 * characters in its Workit workspaces.json and config.json (Workit's own
 * vocabulary aside), its host's project paths (absolute and `~`), its git
 * user.name and user.email and its home. `env` adds the config dir the
 * runner's environment points at.
 */
export const privateStrings = (
  realHome: string,
  isPublic: (text: string) => boolean,
  env?: NodeJS.ProcessEnv,
): PrivateSet => {
  const set: PrivateSet = new Map();
  const add = (text: string, kind: PrivateKind, min = 6): void => {
    if (text.length >= min && !set.has(text)) set.set(text, kind);
  };
  const dirs = new Set([
    workitDir("config", { HOME: realHome }),
    ...(env ? [workitDir("config", env)] : []),
  ]);
  for (const dir of dirs)
    for (const name of ["workspaces.json", "config.json"]) {
      const strings: string[] = [];
      collect(readJson(path.join(dir, name)), strings);
      for (const text of strings) if (!isPublic(text)) add(text, "real Workit config value");
    }
  const projects = record(record(readJson(path.join(realHome, ".claude.json")))?.projects);
  for (const project of Object.keys(projects ?? {})) {
    add(project, "host project path");
    if (project.startsWith(`${realHome}/`))
      add(`~${project.slice(realHome.length)}`, "host project path");
  }
  const git = gitIdentities(realHome, env ?? {});
  for (const name of git.names) add(name, "git user name", 3);
  for (const email of git.emails) add(email, "git user email", 3);
  add(realHome, "home path", 2);
  return set;
};

/** The kinds of private string `text` still holds (as is or JSON-escaped); never the strings. */
export const privateKinds = (text: string, set: PrivateSet): PrivateKind[] => {
  const kinds = new Set<PrivateKind>();
  for (const [secret, kind] of set)
    if (text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1)))
      kinds.add(kind);
  return [...kinds];
};

// ------------------------------------------------------------ committed results

/** Home-dir names a committed result may show: the runner's `<user>` and invented examples. */
const NEUTRAL_USERS = new Set(["<user>", "me", "user", "example"]);

/** An absolute path under a home dir; a placeholder root (`<world>/home/…`) is not one. */
const HOME_PATH = /(?<![\w>.~-])\/(?:home|Users)\/([^/\s"'\\]+)\//gu;
/** A host config's `projects` map: absolute (or `~`) paths as keys. */
const PROJECTS_MAP = /\\*"projects\\*"\s*:\s*\{\s*\\*"(?:\/|~|[A-Za-z]:)/u;
/** A workspace glob under the real home: a world's config globs `<world>/**`. */
const REAL_HOME_GLOB = /\\*"glob\\*"\s*:\s*\\*"~\/(?!projects\/placeholder-)/u;

export type Leak = "home path" | "projects map" | "real config";

/** The kinds of private content `text` (a committed result file) carries; never the content. */
export const committedLeaks = (text: string): Leak[] => {
  const leaks = new Set<Leak>();
  for (const match of text.matchAll(HOME_PATH))
    if (!NEUTRAL_USERS.has(match[1] ?? "")) leaks.add("home path");
  if (PROJECTS_MAP.test(text)) leaks.add("projects map");
  if (REAL_HOME_GLOB.test(text)) leaks.add("real config");
  return [...leaks];
};
