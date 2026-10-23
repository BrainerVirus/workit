// A small shell tokenizer shared by the hooks: quoted words, operators,
// redirects, heredoc bodies, comments and `( … )` group markers. Pure string
// parsing, no I/O. Two dialects:
//   - posix (Bash, sh, zsh): `\` escapes, '…' is literal, "…" honors `\"`,
//     $'…' decodes C escapes, `\<newline>` continues the line, unquoted
//     `{a,b}` expands, `$( … )`, backticks and `<( … )` are substitutions
//     read apart, `(( … ))` is arithmetic, `#` starts a comment;
//   - powershell (Claude Code's PowerShell tool): `\` is a path separator,
//     the backtick escapes (and continues a line), '…' is literal with '' for
//     a quote, "…" honors `", `{ … }` script blocks run their commands, `#`
//     and `<# … #>` are comments.
export type Segment = {
  words: string[];
  redirects: string[];
  /** A `(`/`$(` group starts or ends here; the segment carries no words. */
  group?: "open" | "close";
  /** Its standard output feeds the next segment (`a | b`). */
  pipe?: true;
  /** Text it reads on standard input: heredoc bodies and here-strings. */
  stdin?: string[];
  /**
   * Indexes into `words` of the words the shell expands before the command
   * runs: an unquoted `$`, `*`, `?`, `[` or backtick, or a `$(…)`, `<(…)` or
   * double-quoted `$`/backtick. The text of such a word is not what runs.
   */
  expands?: number[];
  /** Command substitutions in its words (`$(…)`, `` `…` ``, `<(…)`), run with it. */
  subs?: string[];
  /** The command could not be analyzed (too deeply nested): why. The only segment then. */
  unanalyzable?: string;
};

export type ShellDialect = "posix" | "powershell";

/**
 * A command the tokenizer cannot analyze within its budget (nesting too
 * deep). The shell hook denies it with this reason instead of guessing.
 */
export class ShellAnalysisError extends Error {}

/** Substitutions and quotes nest at most this deep. */
const MAX_NESTING = 64;

// Unquoted brace characters, told apart from quoted ones until a word ends.
const OPEN = "\uE000";
const COMMA = "\uE001";
const CLOSE = "\uE002";
const MARKERS = /[\uE000-\uE002]/u;
const literal = (word: string) =>
  word.replaceAll(OPEN, "{").replaceAll(COMMA, ",").replaceAll(CLOSE, "}");
/** At most this many words come out of one brace expansion. */
const BRACE_LIMIT = 64;
/** At most this many words wait to expand, and braces nest this deep, per word. */
const BRACE_PENDING = 512;
const BRACE_DEPTH = 16;

/** The first brace group with a comma at its top level: its bounds and commas. */
const braceGroup = (word: string) => {
  for (let start = 0; start < word.length; start++) {
    if (word[start] !== OPEN) continue;
    let depth = 0;
    let end = start;
    const commas: number[] = [];
    for (; end < word.length; end++) {
      if (word[end] === OPEN) depth++;
      else if (word[end] === CLOSE && --depth === 0) break;
      else if (word[end] === COMMA && depth === 1) commas.push(end);
    }
    if (end < word.length && commas.length) return { start, end, commas };
  }
  return null;
};

/**
 * Bash brace expansion of one word (`a{b,c}d` → `abd acd`); no sequences.
 * Empty results are dropped (`{git,}` is `git`) and repeats collapse.
 * Iterative and budgeted: a word nested too deep or expanding past the
 * budget stays one literal word.
 */
const expandBraces = (word: string): string[] => {
  let depth = 0;
  for (const char of word) {
    if (char === OPEN && ++depth > BRACE_DEPTH) return [literal(word)];
    if (char === CLOSE && depth > 0) depth--;
  }
  const done = new Set<string>();
  const queue = [word];
  const queued = new Set(queue);
  for (let at = 0; at < queue.length; at++) {
    const current = queue[at];
    const group = braceGroup(current);
    if (!group) {
      const text = literal(current);
      if (text) done.add(text);
      if (done.size > BRACE_LIMIT) return [literal(word)];
      continue;
    }
    const pre = current.slice(0, group.start);
    const post = current.slice(group.end + 1);
    let from = group.start + 1;
    for (const comma of [...group.commas, group.end]) {
      const next = pre + current.slice(from, comma) + post;
      from = comma + 1;
      if (queued.has(next)) continue;
      queued.add(next);
      queue.push(next);
    }
    // A comma group leaves more words waiting than it takes: bounding them bounds the work.
    if (queue.length - at > BRACE_PENDING) return [literal(word)];
  }
  return [...done];
};

/** The index of the quote closing the one at `start`, or -1. */
const closingQuote = (
  command: string,
  start: number,
  dialect: ShellDialect,
  nesting = 0,
): number => {
  const quote = command[start];
  for (let index = start + 1; index < command.length; index++) {
    const char = command[index];
    if (quote === "'") {
      if (char !== "'") continue;
      // PowerShell: '' inside single quotes is one quote.
      if (dialect === "powershell" && command[index + 1] === "'") {
        index++;
        continue;
      }
      return index;
    }
    if ((dialect === "posix" && char === "\\") || (dialect === "powershell" && char === "`")) {
      index++;
      continue;
    }
    // posix: a `$( … )` inside double quotes is parsed on its own (its own quotes and heredocs).
    if (dialect === "posix" && char === "$" && command[index + 1] === "(") {
      index = substitutionEnd(command, index + 1, nesting + 1);
      continue;
    }
    if (dialect === "posix" && char === "`") {
      index = backtickEnd(command, index);
      continue;
    }
    if (char === '"') return index;
  }
  return -1;
};

/** The index of the backtick closing the one at `start`, or the end. */
const backtickEnd = (command: string, start: number): number => {
  for (let index = start + 1; index < command.length; index++) {
    if (command[index] === "\\") index++;
    else if (command[index] === "`") return index;
  }
  return command.length;
};

/** A heredoc operator's delimiter at `start` (just past `<<`): the word and where it ends. */
const heredocDelimiter = (command: string, start: number) => {
  let index = start;
  if (command[index] === "-") index++;
  while (command[index] === " " || command[index] === "\t") index++;
  let delimiter = "";
  for (; index < command.length && !/[\s;&|<>()]/.test(command[index]); index++) {
    const char = command[index];
    if (char === "'" || char === '"') {
      const end = command.indexOf(char, index + 1);
      if (end < 0) break;
      delimiter += command.slice(index + 1, end);
      index = end;
    } else if (char === "\\") delimiter += command[++index] ?? "";
    else delimiter += char;
  }
  return { delimiter, end: index - 1 };
};

/** Past the heredoc bodies that start after the newline at `newline`: the index of the last line's end. */
const skipHeredocs = (command: string, newline: number, delimiters: string[]): number => {
  let index = newline;
  while (delimiters.length) {
    const delimiter = delimiters.shift()!;
    for (;;) {
      const lineEnd = command.indexOf("\n", index + 1);
      const line = command.slice(index + 1, lineEnd < 0 ? undefined : lineEnd);
      index = lineEnd < 0 ? command.length : lineEnd;
      if (line.trim() === delimiter || lineEnd < 0) break;
    }
  }
  return index;
};

/**
 * The index of the `)` closing the `$(` whose `(` is at `start`, read as
 * bash reads it: quotes, nested substitutions, backticks, comments and
 * heredoc bodies (`$(cat <<'EOF' … 1) … EOF)`) do not count.
 */
const substitutionEnd = (command: string, start: number, nesting = 0): number => {
  if (nesting > MAX_NESTING) throw new ShellAnalysisError("substitutions nest too deep");
  let depth = 0;
  let wordStart = true;
  const heredocs: string[] = [];
  for (let index = start; index < command.length; index++) {
    const char = command[index];
    const atWordStart = wordStart;
    wordStart = /[\s;&|()]/.test(char);
    if (char === "\\") index++;
    else if (char === "\n" && heredocs.length) {
      index = skipHeredocs(command, index, heredocs);
      wordStart = true;
    } else if (char === "'" || char === '"') {
      const end = closingQuote(command, index, "posix", nesting);
      if (end < 0) return command.length;
      index = end;
    } else if (char === "`") index = backtickEnd(command, index);
    else if (char === "#" && atWordStart) {
      const newline = command.indexOf("\n", index);
      index = newline < 0 ? command.length : newline - 1;
    } else if (char === "<" && command[index + 1] === "<" && command[index + 2] !== "<") {
      const { delimiter, end } = heredocDelimiter(command, index + 2);
      if (delimiter) heredocs.push(delimiter);
      index = end;
    } else if (char === "<" && command[index + 1] === "<") index += 2;
    else if (char === "$" && command[index + 1] === "(")
      index = substitutionEnd(command, index + 1, nesting + 1);
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return index;
  }
  return command.length;
};

/** The text of a quoted span without its quotes, escapes resolved. */
const unquote = (body: string, quote: string, dialect: ShellDialect): string => {
  if (quote === "'") return dialect === "powershell" ? body.replaceAll("''", "'") : body;
  return dialect === "posix"
    ? body.replace(/\\\n/g, "").replace(/\\(["\\$`])/g, "$1")
    : body.replace(/`(.)/g, "$1");
};

const C_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  v: "\v",
};

/** A posix `$'…'` span starting at its quote: the decoded text and the closing index. */
const ansiC = (command: string, start: number): { text: string; end: number } => {
  let text = "";
  let index = start + 1;
  for (; index < command.length && command[index] !== "'"; index++) {
    const char = command[index];
    if (char !== "\\" || index + 1 >= command.length) {
      text += char;
      continue;
    }
    const rest = command.slice(++index);
    const hex = /^x([0-9a-fA-F]{1,2})/.exec(rest);
    const octal = /^[0-7]{1,3}/.exec(rest);
    if (hex) {
      text += String.fromCharCode(Number.parseInt(hex[1], 16));
      index += hex[0].length - 1;
    } else if (octal) {
      text += String.fromCharCode(Number.parseInt(octal[0], 8));
      index += octal[0].length - 1;
    } else text += C_ESCAPES[rest[0]] ?? rest[0];
  }
  return { text, end: index };
};

/** The command substitutions (`$( … )`, `` `…` ``) inside a double-quoted body. */
const substitutions = (body: string): string[] => {
  const found: string[] = [];
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === "\\") index++;
    else if (char === "`") {
      const end = backtickEnd(body, index);
      found.push(body.slice(index + 1, end).replace(/\\(.)/g, "$1"));
      index = end;
    } else if (char === "$" && body[index + 1] === "(") {
      const end = substitutionEnd(body, index + 1);
      found.push(body.slice(index + 2, end));
      index = end;
    }
  }
  return found;
};

/** Characters that are only ever part of a word, per dialect. */
const PLAIN_POSIX = /[^\s'"\\`$(){},<>|;&#]+/uy;
const PLAIN_POWERSHELL = /[^\s'"`(){}<>|;&#]+/uy;

/** Does a double-quoted body hold an expansion (`$x`, `$(…)`, a backtick)? */
const expandsInQuotes = (body: string, dialect: ShellDialect): boolean => {
  const escape = dialect === "posix" ? "\\" : "`";
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === escape) index++;
    else if (char === "$" || (dialect === "posix" && char === "`")) return true;
  }
  return false;
};

/** An unquoted glob or variable character in a plain run. */
const EXPANDING_RUN = /[*?[]/u;

/** The `)` of a `(( … ))` arithmetic command starting at `start`, or 0 for a subshell (`((a) )`). */
const arithmeticEnd = (command: string, start: number): number => {
  const end = substitutionEnd(command, start);
  return command[end - 1] === ")" && end > start + 2 ? end : 0;
};

/**
 * Tokenize `command` into simple-command segments. Never throws: a command
 * it cannot analyze comes back as one segment that says why.
 */
export const segmentsOf = (command: string, dialect: ShellDialect = "posix"): Segment[] => {
  try {
    return tokenize(command, dialect);
  } catch (error) {
    const why = error instanceof ShellAnalysisError ? error.message : String(error);
    return [{ words: [], redirects: [], unanalyzable: why }];
  }
};

const tokenize = (command: string, dialect: ShellDialect): Segment[] => {
  const posix = dialect === "posix";
  const segments: Segment[] = [];
  let current: Segment = { words: [], redirects: [] };
  let word = "";
  let inWord = false;
  let expanding = false;
  let pending: "redirect" | "input" | "heredoc" | "herestring" | null = null;
  const heredocs: Array<{ delimiter: string; owner: Segment }> = [];
  const escape = posix ? "\\" : "`";
  const flushWord = () => {
    if (!inWord) return;
    const text = MARKERS.test(word) ? literal(word) : word;
    if (pending === "redirect") {
      if (!text.startsWith("&")) current.redirects.push(text);
    } else if (pending === "heredoc")
      heredocs.push({ delimiter: text.replace(/^-/, ""), owner: current });
    else if (pending === "herestring") (current.stdin ??= []).push(text);
    else if (pending !== "input") {
      const at = current.words.length;
      current.words.push(...(MARKERS.test(word) ? expandBraces(word) : [word]));
      if (expanding || (!posix && word.startsWith("@")))
        (current.expands ??= []).push(...current.words.slice(at).map((_, i) => at + i));
    }
    pending = null;
    word = "";
    inWord = false;
    expanding = false;
  };
  const flushSegment = () => {
    flushWord();
    if (current.words.length || current.redirects.length || current.stdin || current.subs)
      segments.push(current);
    current = { words: [], redirects: [] };
  };
  const group = (kind: "open" | "close") => {
    flushSegment();
    pending = null;
    segments.push({ words: [], redirects: [], group: kind });
  };
  /** A substitution read apart: its command runs, its text stays in the word. */
  const substitution = (inner: string, text: string) => {
    (current.subs ??= []).push(inner);
    expanding = true;
    word += text;
    inWord = true;
  };
  const plain = posix ? PLAIN_POSIX : PLAIN_POWERSHELL;
  for (let index = 0; index < command.length; index++) {
    // A run of characters no rule treats specially joins the word at once.
    plain.lastIndex = index;
    const run = plain.exec(command);
    if (run) {
      word += run[0];
      inWord = true;
      if (EXPANDING_RUN.test(run[0])) expanding = true;
      index += run[0].length - 1;
      continue;
    }
    const char = command[index];
    const next = command[index + 1];
    if (char === escape && (next === "\n" || (next === "\r" && command[index + 2] === "\n")))
      index += next === "\r" ? 2 : 1;
    else if (char === "#" && !inWord) {
      // A comment runs to the end of the line; its quotes are not quotes.
      const newline = command.indexOf("\n", index);
      index = (newline < 0 ? command.length : newline) - 1;
    } else if (!posix && char === "<" && next === "#") {
      const end = command.indexOf("#>", index + 2);
      index = end < 0 ? command.length : end + 1;
    } else if (posix && char === "$" && next === "'") {
      const { text, end } = ansiC(command, index + 1);
      word += text;
      inWord = true;
      index = end;
    } else if (posix && char === "$" && next === '"') continue;
    else if (char === "'" || char === '"') {
      const end = closingQuote(command, index, dialect);
      const body = command.slice(index + 1, end < 0 ? undefined : end);
      if (posix && char === '"' && /\$\(|`/.test(body))
        (current.subs ??= []).push(...substitutions(body));
      if (char === '"' && expandsInQuotes(body, dialect)) expanding = true;
      word += unquote(body, char, dialect);
      inWord = true;
      index = end < 0 ? command.length : end;
    } else if (posix && char === "`") {
      const end = backtickEnd(command, index);
      const inner = command.slice(index + 1, end);
      substitution(inner.replace(/\\(.)/g, "$1"), `\`${inner}\``);
      index = end;
    } else if (char === escape && index + 1 < command.length) {
      word += command[++index];
      inWord = true;
    } else if (char === "\n") {
      flushSegment();
      // Each heredoc body, up to its delimiter line, is its command's stdin.
      while (heredocs.length) {
        const { delimiter, owner } = heredocs.shift()!;
        const lines = command.slice(index + 1).split("\n");
        const at = lines.findIndex((line) => line.trim() === delimiter);
        (owner.stdin ??= []).push((at < 0 ? lines : lines.slice(0, at)).join("\n"));
        index += (at < 0 ? lines : lines.slice(0, at + 1)).join("\n").length + 1;
      }
    } else if (/\s/.test(char)) flushWord();
    else if (posix && char === "(" && inWord && word.endsWith("$")) {
      // `$( … )` stays part of its word (`"$(…)"`, `x$(…)y`); its command is read apart.
      const end = substitutionEnd(command, index);
      const inner = command.slice(index + 1, end);
      substitution(inner, `(${inner})`);
      index = end;
    } else if (posix && char === "(" && (pending === "input" || pending === "redirect")) {
      // `<( … )`, `>( … )`: a process substitution is an operand whose command runs.
      const sign = pending === "input" ? "<" : ">";
      pending = null;
      const end = substitutionEnd(command, index);
      const inner = command.slice(index + 1, end);
      substitution(inner, `${sign}(${inner})`);
      index = end;
    } else if (posix && char === "(" && next === "(" && !inWord && arithmeticEnd(command, index)) {
      // `(( … ))` is arithmetic: `<<` there is a shift, not a heredoc.
      flushSegment();
      index = arithmeticEnd(command, index);
    } else if (char === "(" || char === ")") {
      // PowerShell `$(`: the `$` is not a word.
      if (char === "(" && inWord && word.endsWith("$")) {
        word = word.slice(0, -1);
        inWord = word !== "";
        if (!inWord) expanding = false;
      }
      group(char === "(" ? "open" : "close");
    } else if (!posix && (char === "{" || char === "}")) {
      // A script block's commands run (`& { … }`, `Invoke-Command { … }`, `% { … }`).
      if (char === "{" && inWord && word.endsWith("@")) {
        word += char;
        continue;
      }
      flushSegment();
    } else if (";&|".includes(char)) {
      if (char === "&" && next === ">") continue;
      if (char === "|" && next === "|") index++;
      else if (char === "|") {
        flushWord();
        if (current.words.length) current.pipe = true;
        if (next === "&") index++;
      }
      flushSegment();
    } else if (char === ">") {
      // `2>`, `&>`: the fd digit is not a word.
      if (inWord && /^\d$/.test(word)) {
        word = "";
        inWord = false;
      } else flushWord();
      if (command[index + 1] === ">") index++;
      if (command[index + 1] === "&") {
        index++;
        word = "&";
        inWord = true;
      }
      pending = "redirect";
    } else if (char === "<" && posix) {
      flushWord();
      if (next === "<" && command[index + 2] === "<") {
        index += 2;
        pending = "herestring";
      } else if (next === "<") {
        index++;
        pending = "heredoc";
      } else pending = "input";
    } else if (posix && char === "{" && !word.endsWith("$")) {
      word += OPEN;
      inWord = true;
    } else if (posix && char === "," && word.includes(OPEN)) word += COMMA;
    else if (posix && char === "}" && word.includes(OPEN)) word += CLOSE;
    else {
      if (char === "$") expanding = true;
      word += char;
      inWord = true;
    }
  }
  flushSegment();
  return segments;
};
