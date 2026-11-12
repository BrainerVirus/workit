// Bench privacy: evals/results is committed to a public repo, so before the
// runner writes a result it (1) rewrites the account's home, user and host
// names, (2) removes tool results, leaving a marker with the path class and
// byte length, and (3) refuses to write a file that still holds a string from
// the real account (its Workit config values, its host's project paths, its
// git identity, its home), a credential the bench host could reach (its
// login files, a key in its environment) or an id of the account it signs in
// as. The private set lives in memory
// only: never written, never logged; a refusal names the file and the kind
// of string, never it.
//
// (2) does not decide what a call read: no reader of a command's text can (a
// glob, a quote, a script the model wrote, an interpreter). The kernel does.
// When Landlock confined the host's reads, a call could only read the world
// and the read rules, so a result stays unless the call names a path outside
// the world. When nothing confined them, no result of a call that ran stays.
// A removed result keeps the grader's own answers about its text (grade.ts
// `callFacts`), so removing it never changes a grade. A refused call's result
// keeps only what the grader's own evidence says are the host's words
// (grade.ts `Refusal`): never a result's wording alone. A line of the host's
// output that is not an event is not stored.
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { workitDir } from "../../packages/workit-core/src/core/workit-paths.mjs";
import type { EvalCase } from "./cases";
import { callFacts, type Facts } from "./grade";
import { claudeSignIn, type Host } from "./isolation";

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
  | "system"
  /** Nothing bounded what the call could read, and it names no outside path. */
  | "unbounded";

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

/**
 * The world's own copy of the host's login (isolation.ts `linkLogin`): the
 * host must read it to sign in, so the kernel allows it; a call that names
 * it never keeps its result.
 */
const WORLD_LOGIN = /^<world>\/home\/(?:\.claude(?:\.json)?|\.local\/share\/opencode)(?:\/|$)/u;

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
  if (WORLD_LOGIN.test(name)) return { kind: "host config" };
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

const PLACEHOLDER = /^<(?:world|workit)>/u;

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
        // A redirection's target; a `<world>` or `<workit>` placeholder is a path, not one.
        const word = PLACEHOLDER.test(each)
          ? each
          : each.replace(/^\d*(?:[<>]+(?=<(?:world|workit)>)|[<>]+)/u, "");
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

/** What the grader says of each call, by id (grade.ts `callFacts`), and whether the kernel bounded the host's reads. */
type Known = { calls: ReturnType<typeof callFacts>; bounded: boolean };

/** Claude Code stream-json: a tool_result whose tool_use ran and may hold what it read. */
const scrubClaude = (lines: (Json | null)[], known: Known): void => {
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
      const call = known.calls.get(block.tool_use_id);
      const kind = calls.get(block.tool_use_id) ?? resolved ?? (known.bounded ? null : "unbounded");
      // A result already removed keeps its marker and facts.
      if (!kind || "facts" in block) continue;
      const refusal = call?.refusal ?? null;
      const text = textOf(block.content);
      // The host's own words and nothing else: the call never ran.
      if (refusal?.whole && refusal.kept === text) continue;
      // Words only the result itself vouches for: they stay, what follows them goes.
      const words = refusal && refusal.kept !== "" && text.startsWith(refusal.kept);
      block.content = `${words ? `${refusal.kept}\n` : ""}${marker(kind, block.content)}`;
      block.facts = call?.facts ?? ({} satisfies Facts);
      if ("tool_use_result" in event) event.tool_use_result = marker(kind, event.tool_use_result);
    }
  }
};

/** OpenCode `run --format json`: a tool part that ran and may hold what it read. */
const scrubOpencode = (lines: (Json | null)[], known: Known): void => {
  for (const event of lines) {
    const part = record(event?.part);
    const state = record(part?.state);
    if (event?.type !== "tool_use" || !part || !state) continue;
    const call = typeof part.id === "string" ? known.calls.get(part.id) : undefined;
    const kind =
      callClass(String(part.tool ?? ""), record(state.input) ?? {}) ??
      (known.bounded ? null : "unbounded");
    // A result already removed keeps its marker and facts.
    if (!kind || "facts" in state) continue;
    const before = JSON.stringify([state.output, state.error]);
    if (state.output !== undefined) state.output = marker(kind, state.output);
    // The host's bare permission sentence and nothing else: the call never ran.
    if (state.error !== undefined && !(call?.refusal?.whole && call.refusal.kept === state.error))
      state.error = marker(kind, state.error);
    if (JSON.stringify([state.output, state.error]) !== before)
      state.facts = call?.facts ?? ({} satisfies Facts);
    for (const key of Object.keys(state))
      if (!["status", "input", "output", "error", "title", "time", "facts"].includes(key))
        delete state[key];
  }
};

export type Scrub = {
  /**
   * The kernel confined the host's reads to the world and the read rules
   * (Landlock): a result stays unless its call names a path outside the
   * world. False: nothing says what a call read, so no result of a call that
   * ran stays.
   */
  bounded: boolean;
  /** The case being run: a removed result keeps the answers to its rules' `result` patterns. */
  spec: Pick<EvalCase, "expect"> | null;
};

/**
 * Both hosts' transcripts: a removed result keeps only its path class, its
 * byte length and the grader's answers about its text. Every input stays,
 * and of a refused call's result what the host's own evidence says are the
 * host's words. A line that is not an event (a JSON object) is dropped, and
 * a closing `scrub` event says how many lines and bytes went.
 */
export const scrubOutsideReads = (transcript: string, { bounded, spec }: Scrub): string => {
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
  const known = { calls: callFacts(transcript, spec), bounded };
  if (lines.some((line) => typeof line?.sessionID === "string")) scrubOpencode(lines, known);
  else scrubClaude(lines, known);
  const removed = { lines: 0, bytes: 0 };
  const out = raw.flatMap((line, at) => {
    const event = lines[at];
    if (event) {
      const after = JSON.stringify(event);
      return [after === before[at] ? line : after];
    }
    if (line.trim() === "") return [line];
    removed.lines += 1;
    removed.bytes += Buffer.byteLength(line);
    return [];
  });
  if (removed.lines > 0)
    out.splice(
      out.findLastIndex((line) => line.trim() !== "") + 1,
      0,
      JSON.stringify({ type: "scrub", removed }),
    );
  return out.join("\n");
};

// ------------------------------------------------------------ the private set

export type PrivateKind =
  | "real Workit config value"
  | "host project path"
  | "git user name"
  | "git user email"
  | "home path"
  | "host credential"
  | "account id";
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

// ------------------------------------------------------------ host credentials

/**
 * The shortest string that counts as a credential. Every token and API key
 * in use is longer (an OAuth token runs to about a hundred characters, a
 * provider key to 32 or more); what else a login file holds is mostly
 * shorter (a plan name, a scope, a provider id, `api`, `oauth`), and the few
 * longer non-secrets reach a transcript only when the file itself was
 * printed, which is the leak. A shorter floor would refuse runs over
 * ordinary words.
 */
const CREDENTIAL_FLOOR = 20;

/**
 * Where a host keeps its login under a home: what a bench world links or
 * seeds from the real one (isolation.ts `HOST_LOGIN`, `seedOpencodeDb`) and
 * what the host may write there itself (OpenCode's auth file).
 */
const LOGIN: Record<Host, { files: string[]; dbs: string[] }> = {
  "claude-code": { files: [".claude/.credentials.json"], dbs: [] },
  opencode: {
    files: [".local/share/opencode/auth.json"],
    dbs: [".local/share/opencode/opencode.db"],
  },
};

/** Every string value under `value` (never a key); a string that is itself JSON is opened too. */
const stringsIn = (value: unknown, into: Set<string>): void => {
  if (typeof value === "string") {
    into.add(value);
    if (!/^\s*[[{]/u.test(value)) return;
    try {
      stringsIn(JSON.parse(value), into);
    } catch {
      // Not JSON after all: the string itself is the value.
    }
  } else if (value instanceof Uint8Array) into.add(Buffer.from(value).toString("utf8"));
  else if (Array.isArray(value)) for (const each of value) stringsIn(each, into);
  else if (record(value)) for (const each of Object.values(value as Json)) stringsIn(each, into);
};

/** An OpenCode db's `credential` rows; none when the file or the table is missing. */
const credentialRows = (file: string): Json[] => {
  if (!existsSync(file)) return [];
  try {
    const db = new Database(file, { readonly: true });
    try {
      const table = db
        .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'credential'")
        .get();
      return table ? db.query<Json, []>('SELECT * FROM "credential"').all() : [];
    } finally {
      db.close();
    }
  } catch {
    // SQLite's message may quote the file: only the reason goes out.
    throw new PrivateSetUnreadable(`${file}: not a readable SQLite database`);
  }
};

/**
 * The credentials a host's login under `home` holds now, in memory only:
 * every string value of CREDENTIAL_FLOOR+ characters in its login files (each
 * word of one that is not JSON) and in the `value` column of its db's
 * `credential` rows (the provider key; every column of a table without one).
 * A login file that exists but cannot be read throws PrivateSetUnreadable.
 */
export const hostCredentials = (home: string, host: Host): string[] => {
  const found = new Set<string>();
  for (const rel of LOGIN[host].files) {
    const text = readAccountFile(path.join(home, rel));
    if (text === null) continue;
    try {
      stringsIn(JSON.parse(text), found);
    } catch {
      for (const word of text.split(/\s+/u)) found.add(word);
    }
  }
  for (const rel of LOGIN[host].dbs)
    for (const row of credentialRows(path.join(home, rel)))
      stringsIn("value" in row ? row.value : Object.values(row), found);
  return [...found].filter((value) => value.length >= CREDENTIAL_FLOOR);
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * Whether a value seeded into a world identifies the account: an e-mail
 * address; a string of 32+ characters (a UUID is 36, a hashed user id 64,
 * while the plan, tier, role, install and version words beside them stop at
 * about 22, so no ordinary word is refused); or one of 20+ under a key that
 * says id (a database row id).
 */
const isAccountId = (key: string, value: unknown): value is string =>
  typeof value === "string" &&
  (EMAIL.test(value) || value.length >= 32 || (value.length >= 20 && /(?:id|uuid)$/iu.test(key)));

/**
 * The account ids a host's sign-in state under `home` holds now, in memory
 * only: for Claude Code the keys a world's copy of `.claude.json` keeps
 * (isolation.ts `claudeSignIn`) and everything under `oauthAccount`, which
 * the host may fetch back into its world (the e-mail address); for OpenCode
 * the other columns of its db's `credential` rows.
 */
export const accountIds = (home: string, host: Host): string[] => {
  const found = new Set<string>();
  const note = (entries: [string, unknown][]): void => {
    for (const [key, value] of entries) if (isAccountId(key, value)) found.add(value);
  };
  if (host === "claude-code") {
    const state = record(readJson(path.join(home, ".claude.json")));
    if (state) {
      note(Object.entries(claudeSignIn(state)));
      note(Object.entries(record(state.oauthAccount) ?? {}));
    }
  }
  for (const rel of LOGIN[host].dbs)
    for (const row of credentialRows(path.join(home, rel)))
      note(Object.entries(row).filter(([column]) => column !== "value"));
  return [...found];
};

/** A variable whose name says it holds a secret: a key, a token, a secret, a password. */
const SECRET_NAME =
  /(?:^|[^a-z])(?:api_?key|key|token|secret|password|passwd|credentials?)(?:$|[^a-z])|authtoken/iu;

/** The credentials in an environment a host is given: the values of secret-named variables, of CREDENTIAL_FLOOR+ characters. */
export const envCredentials = (env: Record<string, string>): string[] =>
  Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && value.length >= CREDENTIAL_FLOOR)
    .map(([, value]) => value);

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
