// The CI workflow risk-path sub-rule (#891). A GitHub Actions workflow is a
// risk path, but an edit that only appends `&& <command>` or
// `&& (<command> || echo "<text>")` to a step's `run:` string, or to a
// command-named input (`lint_command`, `test-cmd`, `script`) of a job-level
// reusable workflow call, leaves it (lane.ts decides how far the lane then
// drops). An action's inputs never grow: they are not known to be shell.
// Additive is decided on the parsed YAML of both sides, never on lines: both
// sides parse, every key and sequence item is still there, and every changed
// value is one of those strings grown at its end by text in that allow-list
// grammar (see masking). Anything else stays full: `permissions`, `secrets`,
// `on:`, a `uses:` ref, `environment:`, `if:`, a removed or added step, job
// or input, an appended `${{ }}` expression, a change to comments or layout
// alone (read as code, as before), or a file this reader cannot parse.
// GitLab CI is never softened: its scripts are lists and its secrets are
// environment variables every appended command can read.
//
// The reader takes the block YAML workflows are written in (mappings,
// sequences, plain, quoted and block scalars, one-line flow collections) and
// refuses the rest (anchors, aliases, tags, several documents, a scalar or
// flow collection spanning lines), so a refusal fails closed.

export type YamlNode =
  | {
      kind: "scalar";
      text: string;
      /** False for null, booleans and numbers: they never grow by appending. */
      string: boolean;
      /** A folded block keeps its raw lines, so it only compares with another folded block. */
      folded: boolean;
    }
  | { kind: "map"; entries: Map<string, YamlNode> }
  | { kind: "seq"; items: YamlNode[] };

class Unparsed extends Error {}
const refuse = (why: string): never => {
  throw new Unparsed(why);
};

type Line = { indent: number; text: string };

const NON_STRING =
  /^(?:~|null|true|false|yes|no|on|off|y|n|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[\da-f]+|0o[0-7]+|[-+]?\.inf|\.nan)$/iu;
const HEX_DIGITS: Record<string, number> = { x: 2, u: 4, U: 8 };
const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "0": "\0",
  '"': '"',
  "\\": "\\",
  "/": "/",
  " ": " ",
};

const scalar = (text: string, string: boolean, folded = false): YamlNode => ({
  kind: "scalar",
  text,
  string,
  folded,
});

/** A quoted scalar starting at `start`, on this line only. */
function quoted(text: string, start: number): { value: string; end: number } {
  const quote = text[start];
  let out = "";
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quote === "'" && char === "'") {
      if (text[index + 1] !== "'") return { value: out, end: index + 1 };
      out += "'";
      index += 1;
    } else if (quote === '"' && char === '"') return { value: out, end: index + 1 };
    else if (quote === '"' && char === "\\") {
      const next = text[index + 1] ?? "";
      const hex = HEX_DIGITS[next];
      if (hex) {
        const digits = text.slice(index + 2, index + 2 + hex);
        if (!/^[\da-f]+$/iu.test(digits) || digits.length !== hex) refuse("a bad escape");
        out += String.fromCodePoint(Number.parseInt(digits, 16));
        index += 1 + hex;
      } else {
        out += ESCAPES[next] ?? refuse("an unknown escape");
        index += 1;
      }
    } else out += char;
  }
  return refuse("a quoted scalar spans lines");
}

/** Only a comment (or nothing) may follow a value. */
function trailing(text: string, end: number): void {
  const rest = text.slice(end);
  if (rest.trim() && !/^\s+#/u.test(rest)) refuse("text after a value");
}

const INDICATOR = /^[&*!%@`|>,[\]{}?:#-]/u;

/** A plain scalar: no indicator first, no `: ` or ` #` inside. */
function plain(text: string): YamlNode {
  const value = text.replace(/\s+#.*$/u, "").trimEnd();
  if (INDICATOR.test(value) && !/^-[^\s]/u.test(value)) refuse("an indicator starts a scalar");
  if (/:\s|:$/u.test(value)) refuse("a mapping inside a scalar");
  return scalar(value, !NON_STRING.test(value));
}

/** A one-line flow collection (`[a, b]`, `{a: 1}`) starting at `start`. */
function flow(text: string, start: number): { node: YamlNode; end: number } {
  const close = text[start] === "[" ? "]" : "}";
  const items: YamlNode[] = [];
  const entries = new Map<string, YamlNode>();
  let index = start + 1;
  const skip = () => {
    while (text[index] === " ") index += 1;
  };
  const element = (stops: RegExp): YamlNode => {
    skip();
    const char = text[index];
    if (char === '"' || char === "'") {
      const read = quoted(text, index);
      index = read.end;
      return scalar(read.value, true);
    }
    if (char === "[" || char === "{") {
      const read = flow(text, index);
      index = read.end;
      return read.node;
    }
    let end = index;
    while (end < text.length && !stops.test(text[end] ?? "")) end += 1;
    const value = text.slice(index, end).trim();
    index = end;
    if (!value || value.includes("#")) refuse("an empty or commented flow element");
    return plain(value);
  };
  for (;;) {
    skip();
    if (index >= text.length) refuse("a flow collection spans lines");
    if (text[index] === close)
      return {
        node: close === "]" ? { kind: "seq", items } : { kind: "map", entries },
        end: index + 1,
      };
    if (close === "]") items.push(element(/[,\]]/u));
    else {
      const key = element(/[:,}]/u);
      skip();
      if (text[index] !== ":" || key.kind !== "scalar") refuse("a flow mapping without a value");
      index += 1;
      const value = element(/[,}]/u);
      const name = key.kind === "scalar" ? key.text : "";
      if (entries.has(name)) refuse("a duplicate key");
      entries.set(name, value);
    }
    skip();
    if (text[index] === ",") index += 1;
    else if (text[index] !== close) refuse("a malformed flow collection");
  }
}

const isItem = (text: string): boolean => text === "-" || text.startsWith("- ");

/** `key: rest` of a mapping line, or null when the line holds no key. */
function splitKey(text: string): { key: string; rest: string } | null {
  if (text[0] === '"' || text[0] === "'") {
    const read = quoted(text, 0);
    const after = text.slice(read.end);
    const match = /^\s*:(?:\s+|$)/u.exec(after);
    return match ? { key: read.value, rest: after.slice(match[0].length) } : null;
  }
  const match = /:(?:\s|$)/u.exec(text);
  if (!match || INDICATOR.test(text)) return null;
  const key = text.slice(0, match.index).trimEnd();
  if (!key || key.includes(" #")) return null;
  return { key, rest: text.slice(match.index + 1).trimStart() };
}

class Reader {
  private readonly lines: string[];
  private pos = 0;

  constructor(text: string) {
    const normal = text.replace(/\r\n/gu, "\n");
    if (normal.includes("\r") || normal.charCodeAt(0) === 0xfeff)
      refuse("an odd line break or BOM");
    this.lines = normal.split("\n");
    // A leading `---` opens the one document; any later one is a second document.
    const first = this.lines.findIndex((line) => line.trim() && !line.trimStart().startsWith("#"));
    if (first >= 0 && /^---\s*(?:#.*)?$/u.test(this.lines[first] ?? "")) this.lines[first] = "";
  }

  /** The next line holding content (blank and comment lines skipped), not consumed. */
  private next(): Line | null {
    while (this.pos < this.lines.length) {
      const raw = this.lines[this.pos] ?? "";
      const text = raw.trimStart();
      if (text === "" || text.startsWith("#")) {
        this.pos += 1;
        continue;
      }
      const indent = raw.length - text.length;
      if (raw.slice(0, indent).includes("\t")) refuse("a tab indents a line");
      if (indent === 0 && /^(?:---|\.\.\.)(?:\s|$)|^%/u.test(text)) refuse("several documents");
      return { indent, text: text.trimEnd() };
    }
    return null;
  }

  document(): YamlNode {
    const root = this.block(0);
    if (this.next()) refuse("content after the document");
    return root;
  }

  private block(min: number): YamlNode {
    const line = this.next();
    if (!line || line.indent < min) return scalar("", false);
    return isItem(line.text) ? this.sequence(line.indent) : this.mapping(line.indent);
  }

  private mapping(indent: number): YamlNode {
    const entries = new Map<string, YamlNode>();
    for (let line = this.next(); line && line.indent >= indent; line = this.next()) {
      if (line.indent > indent || isItem(line.text)) refuse("bad indentation");
      const split = splitKey(line.text) ?? refuse("a line that is no mapping entry");
      if (entries.has(split.key)) refuse("a duplicate key");
      this.pos += 1;
      entries.set(split.key, this.value(split.rest, indent, true));
    }
    return { kind: "map", entries };
  }

  private sequence(indent: number): YamlNode {
    const items: YamlNode[] = [];
    for (
      let line = this.next();
      line && line.indent === indent && isItem(line.text);
      line = this.next()
    ) {
      const rest = line.text.slice(1).trimStart();
      const offset = indent + line.text.length - rest.length;
      if (isItem(rest)) refuse("a sequence inside a sequence item");
      if (rest && !/^[|>[{]/u.test(rest) && splitKey(rest)) {
        // A compact mapping (`- name: x`): read on as a mapping at its own column.
        this.lines[this.pos] = " ".repeat(offset) + rest;
        items.push(this.mapping(offset));
      } else {
        this.pos += 1;
        items.push(this.value(rest, indent, false));
      }
    }
    const line = this.next();
    if (line && line.indent > indent) refuse("bad indentation");
    return { kind: "seq", items };
  }

  /** The value after `key:` or `- ` on a line at `indent`. */
  private value(rest: string, indent: number, inMapping: boolean): YamlNode {
    if (rest === "" || rest.startsWith("#")) {
      const line = this.next();
      if (line && line.indent > indent) return this.block(line.indent);
      if (inMapping && line?.indent === indent && isItem(line.text)) return this.sequence(indent);
      return scalar("", false);
    }
    let node: YamlNode;
    if (rest[0] === "|" || rest[0] === ">") return this.blockScalar(rest, indent);
    if (rest[0] === '"' || rest[0] === "'") {
      const read = quoted(rest, 0);
      trailing(rest, read.end);
      node = scalar(read.value, true);
    } else if (rest[0] === "[" || rest[0] === "{") {
      const read = flow(rest, 0);
      trailing(rest, read.end);
      node = read.node;
    } else node = plain(rest);
    const line = this.next();
    if (line && line.indent > indent) refuse("a value continues on the next line");
    return node;
  }

  /** A `|` or `>` block scalar under a node at `indent`, with its chomping. */
  private blockScalar(header: string, indent: number): YamlNode {
    const match = /^([|>])(?:([-+])([1-9])?|([1-9])([-+])?)?\s*(?:#.*)?$/u.exec(header);
    if (!match) return refuse("a bad block scalar header");
    const chomp = match[2] ?? match[5] ?? "";
    const indicator = match[3] ?? match[4];
    let column = indicator ? indent + Number(indicator) : null;
    const body: string[] = [];
    while (this.pos < this.lines.length) {
      const raw = this.lines[this.pos] ?? "";
      if (raw.trim() === "") {
        body.push(column !== null && raw.length > column ? raw.slice(column) : "");
        this.pos += 1;
        continue;
      }
      const lead = raw.length - raw.trimStart().length;
      if (column === null) {
        if (lead <= indent) break;
        column = lead;
      }
      if (lead < column) {
        if (lead > indent) refuse("an under-indented block line");
        break;
      }
      if (raw.slice(0, column).includes("\t")) refuse("a tab indents a line");
      body.push(raw.slice(column));
      this.pos += 1;
    }
    let end = body.length;
    while (end > 0 && body[end - 1] === "") end -= 1;
    const content = body.slice(0, end).join("\n");
    const text =
      chomp === "+" ? `${body.join("\n")}\n` : chomp === "-" || !content ? content : `${content}\n`;
    return scalar(text, true, match[1] === ">");
  }
}

/** The parsed document, or null when this reader cannot parse it (fail closed). */
export function parseWorkflowYaml(text: string): YamlNode | null {
  try {
    return new Reader(text).document();
  } catch (error) {
    if (error instanceof Unparsed) return null;
    throw error;
  }
}

/** A GitHub Actions workflow file (the only CI definition the sub-rule softens). */
export const isWorkflowFile = (file: string): boolean =>
  /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(file);

export type WorkflowEdit = {
  additive: boolean;
  /** What changed when additive; otherwise why the file stays on full. */
  detail: string;
};

/** Keys whose change always keeps a workflow on full, named in the reason. */
const GUARDED = new Set(["permissions", "secrets", "on", "uses", "environment", "if"]);

type Change = { path: string[]; what: string };

const pathText = (keys: readonly string[]): string => keys.join(".").replaceAll(".[", "[");

/** Where a scalar may grow: a step's `run`, or a command-named input of a job-level reusable workflow call. */
type Room = "run" | "with" | null;

/** An argument: letters, digits and `_ . / : @ = + , -`; no quote, `$`, glob, redirect, `#` or `\`. */
const WORD = /[\w./:@=+,-]+/uy;
/** Double-quoted text that expands nothing: no `"`, `$`, backtick or backslash inside. */
const QUOTED = /"[^"$`\\]*"/uy;
/** A command name: a word with no `=` or `:` (no `VAR=x cmd` prefix) that starts with no `-` or `/`. */
const COMMAND = /^[\w.+][\w./+-]*$/u;
/** Shell words that change the shell itself or what runs after them: never a command name. */
const SHELL_STATE = new Set(
  ". alias bg bind break builtin call caller case cd command compgen complete compopt continue coproc declare dirs disown do done elif else enable esac eval exec exit export fc fg fi for function getopts goto hash help history if in jobs kill let local logout mapfile popd pushd read readarray readonly return select set shift shopt source suspend then time times trap type typeset ulimit umask unalias unset until wait while".split(
    " ",
  ),
);
/** What may follow `||` inside the group: it reports, it never runs a tool. */
const FALLBACK: ReadonlySet<string> = new Set(["echo", "true"]);
const FORM = 'more than && <command> or && (<command> || echo "<text>")';
const OUTSIDE = '(outside plain words and "double-quoted text")';
/** A reusable workflow's input that names a command (`lint_command`, `test-cmd`, `script`). */
const COMMAND_INPUT = /(?:^|[-_])(?:commands?|cmd|script)$/iu;

type Token = { op: string } | { word: string } | { quoted: string };

/** The appended text as operators, words and quoted texts, or why it is none of them. */
function tokens(text: string): Token[] | string {
  const out: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === " " || char === "\t") index += 1;
    else if (char === "(" || char === ")") {
      out.push({ op: char });
      index += 1;
    } else if ((char === "&" || char === "|") && text[index + 1] === char) {
      out.push({ op: char + char });
      index += 2;
    } else {
      const pattern = char === '"' ? QUOTED : WORD;
      pattern.lastIndex = index;
      const match = pattern.exec(text);
      if (!match)
        return char === '"'
          ? 'a "quoted text" left open or holding $, a backtick or a backslash'
          : `the character ${char} ${OUTSIDE}`;
      index += match[0].length;
      // A word or a text ends at a space or an operator: `ex"it"` would spell another command.
      const next = text[index] ?? " ";
      if (!" \t)&|".includes(next)) return `the character ${next} ${OUTSIDE}`;
      out.push(char === '"' ? { quoted: match[0] } : { word: match[0] });
    }
  }
  return out;
}

/**
 * Why text appended to `before` could hide a failure of what ran before it,
 * or null when it cannot. An allow-list, never a reading of shell syntax: the
 * text is one or more `&& <command>` or `&& (<command> || echo "<text>")`
 * (`|| true` too), on one line. A command is a name and its arguments, each
 * a plain word or a double-quoted text without `$`, a backtick or a
 * backslash; the name is no shell word that changes what runs after it
 * (`exit`, `set`, `trap`, `eval`, `exec`, `source`, `cd`, …). Every other
 * character (`;`, `|`, `&`, `'`, `$`, `#`, `>`, `<`, `\`, `*`, `{`, a
 * backtick) is refused wherever it stands, so no quoting form needs reading.
 */
function masking(before: string, appended: string): string | null {
  if (appended.includes("${{")) return "an expression";
  if (/[\n\r]/u.test(appended)) return "a new line";
  if (!before.trim()) return "a command where none ran before";
  // `cmd \` + `&& x` reads `\&` as a literal and `& x` as a background job.
  if (before.endsWith("\\")) return "a command after a trailing backslash";
  if (!appended.trimStart().startsWith("&&")) return "a command not chained with a leading &&";
  const list = tokens(appended);
  if (typeof list === "string") return list;
  let index = 0;
  const op = (text: string): boolean => {
    const token = list[index];
    if (!token || !("op" in token) || token.op !== text) return false;
    index += 1;
    return true;
  };
  /** `<name> <argument>…` read from `index`; why not, or null. */
  const command = (names?: ReadonlySet<string>): string | null => {
    const name = list[index];
    if (!name || !("word" in name) || !COMMAND.test(name.word)) return FORM;
    if (names ? !names.has(name.word) : SHELL_STATE.has(name.word.toLowerCase()))
      return names ? FORM : `the shell command ${name.word}`;
    index += 1;
    for (let token = list[index]; token && !("op" in token); token = list[index]) index += 1;
    return null;
  };
  while (index < list.length) {
    if (!op("&&")) return FORM;
    const group = op("(");
    const bad = command() ?? (group && op("||") ? command(FALLBACK) : null);
    if (bad) return bad;
    if (group && !op(")")) return FORM;
  }
  return null;
}

function compare(
  before: YamlNode,
  after: YamlNode,
  at: string[],
  room: Room,
  out: { allowed: string[]; refused: Change[] },
): void {
  if (before.kind === "scalar" && after.kind === "scalar") {
    if (before.text === after.text && before.string === after.string) return;
    const grown =
      room !== null &&
      before.string &&
      after.string &&
      before.folded === after.folded &&
      after.text.length > before.text.length &&
      after.text.startsWith(before.text);
    const masks = grown ? masking(before.text, after.text.slice(before.text.length)) : null;
    if (masks) out.refused.push({ path: at, what: `appends ${masks} to ${pathText(at)}` });
    else if (grown) out.allowed.push(`${pathText(at)} appended`);
    else out.refused.push({ path: at, what: `changes ${pathText(at)}` });
    return;
  }
  if (before.kind === "seq" && after.kind === "seq") {
    if (before.items.length !== after.items.length) {
      const fewer = after.items.length < before.items.length;
      const noun = at.at(-1) === "steps" ? "a step" : "an item";
      out.refused.push({
        path: at,
        what: `${fewer ? "removes" : "adds"} ${noun} ${fewer ? "from" : "to"} ${pathText(at)}`,
      });
      return;
    }
    before.items.forEach((item, index) =>
      compare(item, after.items[index], [...at, `[${index}]`], null, out),
    );
    return;
  }
  if (before.kind === "map" && after.kind === "map") {
    const step = at.at(-2) === "steps";
    // Only a reusable workflow call (`jobs.<id>.uses`) has inputs that may grow; an action's never do.
    const job = at.length === 2 && at[0] === "jobs";
    const usesBoth = before.entries.has("uses") && after.entries.has("uses");
    for (const [key, value] of before.entries) {
      const next = after.entries.get(key);
      if (!next) {
        out.refused.push({
          path: [...at, key],
          what:
            at.length === 1 && at[0] === "jobs"
              ? `removes the job ${key}`
              : `removes ${pathText([...at, key])}`,
        });
        continue;
      }
      if (key === "with" && job && usesBoth && value.kind === "map" && next.kind === "map")
        compareInputs(value, next, [...at, key], out);
      else compare(value, next, [...at, key], key === "run" && step ? "run" : null, out);
    }
    for (const [key] of after.entries)
      if (!before.entries.has(key))
        out.refused.push({ path: [...at, key], what: `adds ${pathText([...at, key])}` });
    return;
  }
  out.refused.push({ path: at, what: `changes the shape of ${pathText(at) || "the file"}` });
}

/** A `with:` mapping: each existing input may grow at its end; a new input is a change. */
function compareInputs(
  before: Extract<YamlNode, { kind: "map" }>,
  after: Extract<YamlNode, { kind: "map" }>,
  at: string[],
  out: { allowed: string[]; refused: Change[] },
): void {
  for (const [key, value] of before.entries) {
    const next = after.entries.get(key);
    if (next) compare(value, next, [...at, key], COMMAND_INPUT.test(key) ? "with" : null, out);
    else out.refused.push({ path: [...at, key], what: `removes ${pathText([...at, key])}` });
  }
  for (const [key] of after.entries)
    if (!before.entries.has(key))
      out.refused.push({ path: [...at, key], what: `adds the input ${pathText([...at, key])}` });
}

/** The reason a refused change names: a guarded key first, then a removal, then the first change. */
function decisive(refused: readonly Change[]): string {
  for (const change of refused) {
    const key = change.path.find((part) => GUARDED.has(part));
    if (key === "uses") return `moves a uses: ref (${pathText(change.path)})`;
    if (key) return `changes ${key}: (${pathText(change.path)})`;
  }
  return (
    (refused.find((change) => change.what.startsWith("removes")) ?? refused[0])?.what ??
    "changes it"
  );
}

/**
 * Whether the change from `before` to `after` of a workflow file is purely
 * additive (see the header), with what changed or why not.
 */
export function workflowEdit(before: string, after: string): WorkflowEdit {
  const old = parseWorkflowYaml(before);
  const now = parseWorkflowYaml(after);
  if (!old || !now) return { additive: false, detail: "does not parse as plain workflow YAML" };
  const out = { allowed: [] as string[], refused: [] as Change[] };
  compare(old, now, [], null, out);
  if (out.refused.length) return { additive: false, detail: decisive(out.refused) };
  // A comment can steer a tool (a linter directive, a pinned-version note): it is read as code.
  if (!out.allowed.length)
    return { additive: false, detail: "changes only comments or layout, read as code" };
  return {
    additive: true,
    detail: out.allowed.slice(0, 3).join(", ") + (out.allowed.length > 3 ? ", …" : ""),
  };
}
