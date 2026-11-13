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
import { createHash } from "node:crypto";
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
/**
 * Right after a one-letter option glued to its value at the start of a
 * token (`-C<dir>`, `"-I<dir>"`): the value starts a path there although a
 * letter comes before it. `a-C<dir>` is one word, not an option.
 */
const OPTION_GLUED = String.raw`(?<=(?:^|[\s"'=(])-[A-Za-z])`;
const whole = (text: string): RegExp =>
  new RegExp(`(?:(?<![\\w.-])|${OPTION_GLUED})${escape(text)}(?![\\w-])`, "gu");
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

/**
 * A dir a transcript may name that is neither the world nor this checkout,
 * and the placeholder that stands for it: a checkout the bench links to (the
 * main checkout behind a linked worktree's `node_modules`), a toolchain's
 * install dir under the home. The bench put the host there, so its path is
 * the bench's own, not what the account keeps private.
 */
export type Root = { dir: string; as: string };

/**
 * `roots` with every spelling a transcript may give one under a home: its
 * path, and that path under `~`, `$HOME` and `${HOME}` (a model that saw the
 * path in an error names it in its own command as it likes).
 */
export const rootSpellings = (roots: Root[], homes: string[]): Root[] =>
  roots.flatMap((root) => [
    root,
    ...homes
      .filter((home) => root.dir.startsWith(`${home}/`))
      .flatMap((home) =>
        ["~", "$HOME", "${HOME}"].map((as) => ({
          dir: `${as}${root.dir.slice(home.length)}`,
          as: root.as,
        })),
      ),
  ]);

/**
 * `roots` without any that is a guarded path, holds one or lies above one
 * (`guarded`: the home, the real Workit dirs, the host config dirs): such a
 * dir is the account's, never a placeholder, whatever linked into it.
 */
export const safeRoots = (roots: Root[], guarded: string[]): Root[] =>
  roots.filter(
    (root) =>
      !guarded.some((each) => {
        const rel = path.relative(root.dir, each);
        return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
      }),
  );

/** A character a path segment goes on with: a root next to one is part of a longer name, not the root. */
const SEGMENT = String.raw`[\w.@+~-]`;

type Span = { start: number; end: number; as: string };

/**
 * Every place `text` names a root as a whole path: not after and not before
 * a character a path segment goes on with, so `<root>/x` and `"<root>"` are
 * the root and `<root>-client`, `<root>x` and `/mnt<root>` are other paths.
 * A root glued to a one-letter option (`-C<root>`) is the root too
 * (`OPTION_GLUED`). The longest root wins where two start at one place.
 */
const rootSpans = (text: string, roots: Root[]): Span[] => {
  if (roots.length === 0) return [];
  const sorted = roots.toSorted((a, b) => b.dir.length - a.dir.length);
  const as = new Map(sorted.map((root) => [root.dir, root.as]));
  const pattern = new RegExp(
    `(?:(?<!${SEGMENT})|${OPTION_GLUED})(?:${sorted.map((root) => escape(root.dir)).join("|")})(?!${SEGMENT})`,
    "gu",
  );
  return [...text.matchAll(pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    as: as.get(match[0]) ?? "",
  }));
};

/** `text` with each root that stands as a whole path replaced by its placeholder. */
export const scrubRoots = (text: string, roots: Root[]): string => {
  let out = "";
  let at = 0;
  for (const span of rootSpans(text, roots)) {
    out += text.slice(at, span.start) + span.as;
    at = span.end;
  }
  return out + text.slice(at);
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
  if (OUTSIDE_ROOT.test(name)) return { kind: "system" };
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

/** The roots a transcript shows as placeholders (run.ts `sanitize`, `Root`). */
const ROOT = String.raw`<(?:world|workit|linked(?:-\d+)?|toolchain:[\w.-]+)>`;
const PLACEHOLDER = new RegExp(`^${ROOT}`, "u");
/** A root the bench links to or runs a toolchain from: outside the world. */
const OUTSIDE_ROOT = /^<(?:linked(?:-\d+)?|toolchain:[\w.-]+)>/u;
const REDIRECTION = new RegExp(String.raw`^\d*(?:[<>]+(?=${ROOT})|[<>]+)`, "u");

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
        const word = PLACEHOLDER.test(each) ? each : each.replace(REDIRECTION, "");
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

/**
 * Where each private string came from, for a refusal's diagnosis: the file
 * (the home as `~`) and the key path or position in it. Never a value, and
 * a key the user chose shows as its position.
 */
export type Origins = Map<string, string>;

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

/**
 * Every string under `value` (keys too) with its key path. A key `shown`
 * does not vouch for is the user's own, so the path names its position.
 */
const collect = (
  value: unknown,
  where: string,
  shown: (key: string) => boolean,
  into: [string, string][],
): void => {
  if (typeof value === "string") into.push([value, where === "" ? "the whole file" : where]);
  else if (Array.isArray(value))
    for (const [at, each] of value.entries()) collect(each, `${where}[${at}]`, shown, into);
  else if (record(value))
    for (const [at, [key, each]] of Object.entries(value as Json).entries()) {
      // `$schema` names the published package: public.
      if (key.startsWith("$")) continue;
      const name = shown(key) ? key : `{key ${at + 1}}`;
      const next = where === "" ? name : `${where}.${name}`;
      into.push([key, `${next} (the key itself)`]);
      collect(each, next, shown, into);
    }
};

/**
 * A Workit config file as a diagnosis names it: by its well-known path in
 * the default dir, else as the config dir's file of that fixed name. A dir
 * the environment names is the user's choice and is never shown.
 */
const shownConfig = (dir: string, name: string, home: string): string =>
  dir === workitDir("config", { HOME: home })
    ? `~${dir.slice(home.length)}/${name}`
    : `the Workit config dir's ${name}`;

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
): { names: [string, string][]; emails: [string, string][] } => {
  // Each file with the name a diagnosis gives it: the two well-known ones by
  // path, an included one by where it was included from, never by its own
  // path (the user chose the dir it sits in).
  const base: [string, string][] = [
    [path.join(home, ".gitconfig"), "~/.gitconfig"],
    env.XDG_CONFIG_HOME
      ? [path.join(env.XDG_CONFIG_HOME, "git", "config"), "the git config under XDG_CONFIG_HOME"]
      : [path.join(home, ".config", "git", "config"), "~/.config/git/config"],
  ];
  const files = base.filter(([file]) => existsSync(file));
  // An include may include more: the loop reaches files pushed while it runs.
  for (const [file, label] of files)
    for (const [at, include] of gitValues(file, String.raw`^include(if\..*)?\.path$`).entries()) {
      const full = include.startsWith("~/")
        ? path.join(home, include.slice(2))
        : path.resolve(path.dirname(file), include);
      if (existsSync(full) && !files.some(([seen]) => seen === full))
        files.push([full, `a git config file included from ${label}, include ${at + 1}`]);
    }
  const valuesOf = (pattern: string): [string, string][] =>
    files.flatMap(([file, label]) =>
      gitValues(file, pattern).map((value): [string, string] => [value, label]),
    );
  return {
    names: valuesOf(String.raw`^user\.name$`),
    emails: valuesOf(String.raw`^user\.email$`),
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
  origins?: Origins,
): PrivateSet => {
  const set: PrivateSet = new Map();
  const add = (text: string, kind: PrivateKind, from: string, min = 6): void => {
    if (text.length < min || set.has(text)) return;
    set.set(text, kind);
    origins?.set(text, from);
  };
  const dirs = new Set([
    workitDir("config", { HOME: realHome }),
    ...(env ? [workitDir("config", env)] : []),
  ]);
  for (const dir of dirs)
    for (const name of ["workspaces.json", "config.json"]) {
      const strings: [string, string][] = [];
      const file = path.join(dir, name);
      collect(readJson(file), "", isPublic, strings);
      for (const [text, where] of strings)
        if (!isPublic(text))
          add(text, "real Workit config value", `${shownConfig(dir, name, realHome)}: ${where}`);
    }
  const projects = Object.keys(
    record(record(readJson(path.join(realHome, ".claude.json")))?.projects) ?? {},
  );
  for (const [at, project] of projects.entries()) {
    const from = `~/.claude.json: projects, key ${at + 1} of ${projects.length}`;
    add(project, "host project path", from);
    if (project.startsWith(`${realHome}/`))
      add(`~${project.slice(realHome.length)}`, "host project path", `${from} (as a ~ path)`);
  }
  const git = gitIdentities(realHome, env ?? {});
  for (const [name, file] of git.names) add(name, "git user name", `${file}: user.name`, 3);
  for (const [email, file] of git.emails) add(email, "git user email", `${file}: user.email`, 3);
  add(realHome, "home path", "the account's home dir", 2);
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

/** The keys of a host's login files a diagnosis may name: the hosts' own schema, never a name the user chose. */
const HOST_KEYS = new Set([
  "claudeAiOauth",
  "accessToken",
  "refreshToken",
  "oauthAccount",
  "userID",
  "accountUuid",
  "organizationUuid",
  "emailAddress",
  "key",
  "access",
  "refresh",
  "token",
]);

/** The columns of OpenCode's `credential` table a diagnosis may name. */
const CREDENTIAL_COLUMNS = new Set(["id", "integration_id", "label", "connector_id", "method_id"]);

/** Every string value under `value` (never a key) to where it sits; a string that is itself JSON is opened too. */
const stringsIn = (value: unknown, where: string, into: Map<string, string>): void => {
  const note = (text: string): void => {
    if (!into.has(text))
      into.set(text, where.endsWith(": ") ? `${where}the whole file` : where.trimEnd());
  };
  if (typeof value === "string") {
    note(value);
    if (!/^\s*[[{]/u.test(value)) return;
    try {
      stringsIn(JSON.parse(value), where, into);
    } catch {
      // Not JSON after all: the string itself is the value.
    }
  } else if (value instanceof Uint8Array) note(Buffer.from(value).toString("utf8"));
  else if (Array.isArray(value))
    for (const [at, each] of value.entries()) stringsIn(each, `${where}[${at}]`, into);
  else if (record(value))
    for (const [at, [key, each]] of Object.entries(value as Json).entries()) {
      const name = HOST_KEYS.has(key) ? key : `{key ${at + 1}}`;
      stringsIn(each, /[: ]$/u.test(where) ? `${where}${name}` : `${where}.${name}`, into);
    }
};

/** Where a caller wants the origins of what it reads: the map, and how the home read is shown (`~`, `<world>/home`). */
export type OriginsOf = { to: Origins; home: string };

const noteOrigins = (found: Map<string, string>, origins: OriginsOf | undefined): void => {
  if (origins)
    for (const [value, where] of found) origins.to.set(value, `${origins.home}/${where}`);
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
export const hostCredentials = (home: string, host: Host, origins?: OriginsOf): string[] => {
  const found = new Map<string, string>();
  for (const rel of LOGIN[host].files) {
    const text = readAccountFile(path.join(home, rel));
    if (text === null) continue;
    try {
      stringsIn(JSON.parse(text), `${rel}: `, found);
    } catch {
      for (const [at, word] of text.split(/\s+/u).entries())
        if (!found.has(word)) found.set(word, `${rel}: word ${at + 1}`);
    }
  }
  for (const rel of LOGIN[host].dbs)
    for (const [at, row] of credentialRows(path.join(home, rel)).entries())
      stringsIn(
        "value" in row ? row.value : Object.values(row),
        `${rel}: credential row ${at + 1}, column value `,
        found,
      );
  // Deleting during a Map's iteration is defined: the entry is skipped.
  for (const value of found.keys()) if (value.length < CREDENTIAL_FLOOR) found.delete(value);
  noteOrigins(found, origins);
  return [...found.keys()];
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
export const accountIds = (home: string, host: Host, origins?: OriginsOf): string[] => {
  const found = new Map<string, string>();
  const note = (entries: [string, unknown][], where: string): void => {
    for (const [key, value] of entries)
      if (isAccountId(key, value) && !found.has(value))
        found.set(
          value,
          `${where}${HOST_KEYS.has(key) || (where.includes("column") && CREDENTIAL_COLUMNS.has(key)) ? key : where.includes("column") ? "(not shown)" : "a key"}`,
        );
  };
  if (host === "claude-code") {
    const state = record(readJson(path.join(home, ".claude.json")));
    if (state) {
      note(Object.entries(claudeSignIn(state)), ".claude.json: ");
      note(Object.entries(record(state.oauthAccount) ?? {}), ".claude.json: oauthAccount.");
    }
  }
  for (const rel of LOGIN[host].dbs)
    for (const [at, row] of credentialRows(path.join(home, rel)).entries())
      note(
        Object.entries(row).filter(([column]) => column !== "value"),
        `${rel}: credential row ${at + 1}, column `,
      );
  noteOrigins(found, origins);
  return [...found.keys()];
};

/** A variable whose name says it holds a secret: a key, a token, a secret, a password. */
const SECRET_NAME =
  /(?:^|[^a-z])(?:api_?key|key|token|secret|password|passwd|credentials?)(?:$|[^a-z])|authtoken/iu;

/** The credentials in an environment a host is given: the values of secret-named variables, of CREDENTIAL_FLOOR+ characters. */
export const envCredentials = (env: Record<string, string>, origins?: Origins): string[] =>
  Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && value.length >= CREDENTIAL_FLOOR)
    .map(([, value]) => {
      // A variable's name can itself name an employer or a service: it is not shown.
      origins?.set(value, "the host's environment: a variable named as a secret");
      return value;
    });

/**
 * `text` with each root's placeholder put back as the path it stands for:
 * what the refusal looks at when a placeholder went in before it could look
 * (the checkout's `<workit>`, which the outside-read scrub needs in place).
 */
export const unscrubRoots = (text: string, roots: Root[]): string => {
  let out = text;
  for (const root of roots) out = out.replaceAll(root.as, root.dir);
  return out;
};

/** Whether `text` holds `needle` somewhere that is not wholly inside one of `spans`. */
const outsideSpans = (text: string, needle: string, spans: Span[]): boolean => {
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1))
    if (!spans.some((span) => span.start <= at && at + needle.length <= span.end)) return true;
  return false;
};

/** Whether `text` holds `secret`, as is or JSON-escaped, outside the roots it names. */
const holds = (text: string, secret: string, spans: Span[]): boolean =>
  outsideSpans(text, secret, spans) ||
  outsideSpans(text, JSON.stringify(secret).slice(1, -1), spans);

/**
 * The kinds of private string `text` holds (as is or JSON-escaped), never
 * the strings. `text` is the transcript BEFORE its roots become placeholders
 * (`scrubRoots`), and only a string wholly inside a root named as a whole
 * path is let through: the root itself, a part of it. A private value that
 * starts with a root, contains one or sits beside one still counts, so a
 * placeholder never hides one.
 */
export const refusalKinds = (text: string, set: PrivateSet, roots: Root[] = []): PrivateKind[] => {
  const spans = rootSpans(text, roots);
  const kinds = new Set<PrivateKind>();
  for (const [secret, kind] of set) if (holds(text, secret, spans)) kinds.add(kind);
  return [...kinds];
};

/** The kinds of private string `text` holds (as is or JSON-escaped); never the strings. */
export const privateKinds = (text: string, set: PrivateSet): PrivateKind[] =>
  refusalKinds(text, set);

// ------------------------------------------------------------ a refusal's diagnosis

/**
 * One place a result file holds a private string: where it sits and what it
 * is, never the string. `id` is a salted fingerprint, so two hits of one
 * value show the same id and two values different ones; `from` is where the
 * value came from (a file and key path), when the runner read it from one.
 *
 * `where` is built from structure only: counts, lengths and names taken
 * from the fixed lists below (the formats' own keys, event types, tools, a
 * shell call's first word). No text a model or a user wrote is ever in it:
 * no excerpt of a command, no key or tool name outside the lists.
 */
export type Hit = {
  file: string;
  where: string;
  kind: PrivateKind | Leak;
  /** The value's length; null for a shape the committed scan knows (a home path, a projects map). */
  length: number | null;
  id: string | null;
  from: string | null;
};

/** The keys of the two transcript formats and of a result file: the only key names a diagnosis shows. */
const FORMAT_KEYS = new Set([
  // Claude Code stream-json.
  "type",
  "subtype",
  "message",
  "content",
  "text",
  "input",
  "result",
  "tool_use_result",
  "tool_use_id",
  "is_error",
  "permission_denials",
  "tool_input",
  "tool_name",
  "command",
  "description",
  "cwd",
  "model",
  "stdout",
  "stderr",
  "file",
  "decision_reason",
  "errors",
  // OpenCode run --format json.
  "part",
  "state",
  "output",
  "error",
  "metadata",
  "title",
  "tool",
  "reason",
  // A result file.
  "case",
  "run",
  "host",
  "provider",
  "limits",
  "workitVersion",
  "key",
  "date",
  "usage",
  "grade",
  "failures",
  "rule",
  "detail",
  "outsideWrite",
  "outsideChanges",
  "findings",
  "reported",
  "path",
  "was",
  "now",
  "blob",
  "commands",
  "added",
  "changed",
  "missing",
  "change",
]);

/** The event types and subtypes of the two transcript formats. */
const EVENT_TYPES = new Set([
  "assistant",
  "user",
  "system",
  "result",
  "rate_limit_event",
  "tool_use",
  "text",
  "step_start",
  "step_finish",
  "error",
  "scrub",
]);
const EVENT_SUBTYPES = new Set([
  "init",
  "success",
  "permission_denied",
  "hook_started",
  "hook_response",
  "notification",
  "task_started",
  "task_progress",
  "task_updated",
  "task_notification",
  "thinking_tokens",
  "error_max_turns",
  "error_during_execution",
]);

/** The hosts' own tools; Workit's OpenCode tools share one prefix. */
const TOOLS = new Set([
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Skill",
  "Agent",
  "Task",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "shell",
  "read",
  "edit",
  "write",
  "patch",
  "glob",
  "grep",
  "list",
  "skill",
  "subagent",
]);
const shownTool = (name: unknown): string =>
  typeof name === "string" && (TOOLS.has(name) || /^workit_[a-z_]{1,40}$/u.test(name))
    ? name
    : "a tool";

/** The commands a diagnosis may name as a shell call's first word. */
const KNOWN_COMMANDS = new Set([
  "workit",
  "git",
  "ytrack",
  "bun",
  "node",
  "npm",
  "npx",
  "python",
  "python3",
  "sh",
  "bash",
  "cd",
  "ls",
  "cat",
  "echo",
  "printf",
  "grep",
  "rg",
  "find",
  "head",
  "tail",
  "sed",
  "awk",
  "wc",
  "sort",
  "xargs",
  "tee",
  "diff",
  "jq",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "touch",
  "chmod",
  "curl",
  "which",
  "env",
  "pwd",
  "test",
]);

type Step = number | { key: string; index: number };
type Leaf = { at: Step[]; text: string; isKey: boolean };

/** Every string under `value` with its path; an object's key is a leaf of its own. */
const leaves = (value: unknown, at: Step[], into: Leaf[]): void => {
  if (typeof value === "string") into.push({ at, text: value, isKey: false });
  else if (Array.isArray(value))
    for (const [index, each] of value.entries()) leaves(each, [...at, index], into);
  else if (record(value))
    for (const [index, [key, each]] of Object.entries(value as Json).entries()) {
      const here = [...at, { key, index }];
      into.push({ at: here, text: key, isKey: true });
      leaves(each, here, into);
    }
};

const keyAt = (at: Step[], depth: number): string | null => {
  const step = at[depth];
  return typeof step === "object" ? step.key : null;
};

/** A path as a diagnosis shows it: a key of the formats by name, any other key by its position. */
const shownPath = (leaf: Leaf): string =>
  `${leaf.at
    .map((step) =>
      typeof step === "number"
        ? `[${step}]`
        : FORMAT_KEYS.has(step.key)
          ? `.${step.key}`
          : `.{key ${step.index + 1}}`,
    )
    .join("")
    .replace(/^\./u, "")}${leaf.isKey ? " (the key's own name)" : ""}`;

/**
 * A call as a diagnosis names it, by structure only: the tool, and for a
 * shell call the command's length and its first word when that is a known
 * command. Never an excerpt: a cut can split a private value, and a value
 * has more than one written form.
 */
const shownCall = (tool: unknown, input: unknown): string => {
  const command = record(input)?.command;
  if (typeof command !== "string") return `${shownTool(tool)} call`;
  const first = /^\s*([\w.-]+)/u.exec(command)?.[1] ?? "";
  return `${shownTool(tool)} call (${command.length} chars; ${
    KNOWN_COMMANDS.has(first) ? `starts with ${first}` : "a command not on the list"
  })`;
};

/** The field of a transcript event a leaf sits in: the event's type, the tool and input, result or text. */
const fieldOf = (event: Json, leaf: Leaf, calls: Map<string, string>): string => {
  const known = typeof event.type === "string" && EVENT_TYPES.has(event.type);
  const sub = typeof event.subtype === "string" && EVENT_SUBTYPES.has(event.subtype);
  const type = known
    ? `${String(event.type)}${sub ? `/${String(event.subtype)}` : ""}`
    : "an event,";
  const input = (tool: unknown): string => {
    const name = shownTool(tool);
    return `${type} ${name === "a tool" ? "a tool's" : name} input`;
  };
  const part = record(event.part);
  if (part && keyAt(leaf.at, 0) === "part") {
    if (keyAt(leaf.at, 1) === "state" && keyAt(leaf.at, 2) === "input") return input(part.tool);
    if (keyAt(leaf.at, 1) === "state")
      return `${type} result of ${shownCall(part.tool, record(part.state)?.input)}`;
    if (keyAt(leaf.at, 1) === "text") return `${type} (the model's text)`;
  }
  const content = record(event.message)?.content;
  if (
    keyAt(leaf.at, 0) === "message" &&
    keyAt(leaf.at, 1) === "content" &&
    Array.isArray(content)
  ) {
    const block = record(content[Number(leaf.at[2])]);
    if (block?.type === "tool_use") return input(block.name);
    if (block?.type === "tool_result")
      return `${type} result of ${calls.get(String(block.tool_use_id)) ?? "a call"}`;
    if (keyAt(leaf.at, 3) === "text") return `${type} (the model's text)`;
  }
  if (keyAt(leaf.at, 0) === "tool_use_result") return `${type} result (the host's copy)`;
  if (
    event.type === "result" &&
    keyAt(leaf.at, 0) === "result" &&
    leaf.at.length === 1 &&
    !leaf.isKey
  )
    return `${type} (the answer text)`;
  return `${type} ${shownPath(leaf)}`;
};

/** Each Claude Code call id to the call, as a diagnosis names it. */
const callsById = (events: (Json | null)[]): Map<string, string> => {
  const calls = new Map<string, string>();
  for (const event of events) {
    const content = record(event?.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content.map(record))
      if (block?.type === "tool_use" && typeof block.id === "string")
        calls.set(block.id, shownCall(block.name, block.input));
  }
  return calls;
};

const parsed = (line: string): Json | null => {
  try {
    return record(JSON.parse(line));
  } catch {
    return null;
  }
};

/**
 * Where `files` (name to text) hold a private string or a shape the
 * committed scan refuses: per transcript event and field, per key path of a
 * result file. `salt` makes the ids: pass one per bench start. `roots` are
 * let through as in `refusalKinds`: pass the transcript before its roots
 * become placeholders.
 */
export const privateHits = (
  files: Record<string, string>,
  set: PrivateSet,
  origins: Origins,
  salt: string,
  roots: Root[] = [],
): Hit[] => {
  const hits: Hit[] = [];
  const id = (secret: string): string =>
    createHash("sha256").update(salt).update("\0").update(secret).digest("hex").slice(0, 8);
  const seen = new Set<string>();
  const add = (hit: Hit): void => {
    const key = JSON.stringify(hit);
    if (!seen.has(key)) hits.push(hit);
    seen.add(key);
  };
  const scan = (file: string, text: string, where: string): boolean => {
    let found = false;
    const spans = rootSpans(text, roots);
    for (const [secret, kind] of set)
      if (holds(text, secret, spans)) {
        found = true;
        add({
          file,
          where,
          kind,
          length: secret.length,
          id: id(secret),
          from: origins.get(secret) ?? null,
        });
      }
    for (const kind of committedLeaks(text)) {
      found = true;
      add({ file, where, kind, length: null, id: null, from: null });
    }
    return found;
  };
  for (const [file, text] of Object.entries(files)) {
    const transcript = file.endsWith(".jsonl");
    const lines = transcript ? text.split("\n") : [text];
    const events = lines.map(parsed);
    const calls = callsById(events);
    for (const [index, line] of lines.entries()) {
      // A line with no hit as a whole has none in a field.
      if (refusalKinds(line, set, roots).length === 0 && committedLeaks(line).length === 0)
        continue;
      const event = events[index];
      const here = transcript ? `event ${index + 1}` : "result file";
      const found: Leaf[] = [];
      if (event) leaves(event, [], found);
      let located = false;
      for (const leaf of found) {
        const field = transcript && event ? fieldOf(event, leaf, calls) : shownPath(leaf);
        located = scan(file, leaf.text, `${here}, ${field}`) || located;
      }
      // Seen only across fields (a shape of the event itself, a line that is not JSON).
      if (!located) scan(file, line, `${here}, across its fields`);
    }
  }
  return hits;
};

/** A hit as the terminal shows it. */
export const shownHit = (hit: Hit): string =>
  `${hit.file}: ${hit.where}: ${hit.kind}${hit.length === null ? "" : `, ${hit.length} chars, id ${hit.id}`}${hit.from === null ? "" : `, from ${hit.from}`}`;

// ------------------------------------------------------------ committed results

/** Home-dir names a committed result may show: the runner's `<user>` and invented examples. */
const NEUTRAL_USERS = new Set(["<user>", "me", "user", "example"]);

/**
 * An absolute path under a home dir, also glued to a one-letter option
 * (`-C/home/…`, as the scrub reads it); a placeholder root (`<world>/home/…`)
 * is not one.
 */
const HOME_PATH = new RegExp(
  String.raw`(?:(?<![\w>.~-])|${OPTION_GLUED})\/(?:home|Users)\/([^/\s"'\\]+)\/`,
  "gu",
);
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
