// A small shell tokenizer shared by the hooks: quoted words, operators,
// redirects, heredoc bodies and `( … )` group markers. Pure string parsing,
// no I/O. Two dialects:
//   - posix (Bash, sh, zsh): `\` escapes, '…' is literal, "…" honors `\"`,
//     $'…' decodes C escapes, `\<newline>` continues the line, unquoted
//     `{a,b}` expands, backticks and `$( … )` are groups;
//   - powershell (Claude Code's PowerShell tool): `\` is a path separator,
//     the backtick escapes, '…' is literal with '' for a quote, "…" honors `".
export type Segment = {
  words: string[];
  redirects: string[];
  /** A `(`/`$(` group starts or ends here; the segment carries no words. */
  group?: "open" | "close";
  /** Its standard output feeds the next segment (`a | b`). */
  pipe?: true;
  /** Text it reads on standard input: heredoc bodies and here-strings. */
  stdin?: string[];
  /** Command substitutions inside double quotes (`"$(…)"`), run before it. */
  subs?: string[];
};

export type ShellDialect = "posix" | "powershell";

// Unquoted brace characters, told apart from quoted ones until a word ends.
const OPEN = "\uE000";
const COMMA = "\uE001";
const CLOSE = "\uE002";
const MARKERS = /[\uE000-\uE002]/u;
const literal = (word: string) =>
  word.replaceAll(OPEN, "{").replaceAll(COMMA, ",").replaceAll(CLOSE, "}");
/** At most this many words come out of one brace expansion. */
const BRACE_LIMIT = 64;

/** Bash brace expansion of one word (`a{b,c}d` → `abd acd`); no sequences. */
const expandBraces = (word: string): string[] => {
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
    if (end >= word.length || commas.length === 0) continue;
    const parts: string[] = [];
    let from = start + 1;
    for (const at of [...commas, end]) {
      parts.push(word.slice(from, at));
      from = at + 1;
    }
    const pre = word.slice(0, start);
    const post = word.slice(end + 1);
    return parts.flatMap((part) => expandBraces(pre + part + post)).slice(0, BRACE_LIMIT);
  }
  return [literal(word)];
};

/** The index of the quote closing the one at `start`, or -1. */
const closingQuote = (command: string, start: number, dialect: ShellDialect): number => {
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
    if (char === '"') return index;
  }
  return -1;
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
      const end = body.indexOf("`", index + 1);
      if (end < 0) break;
      found.push(body.slice(index + 1, end).replace(/\\(.)/g, "$1"));
      index = end;
    } else if (char === "$" && body[index + 1] === "(") {
      let depth = 0;
      let end = index + 1;
      for (; end < body.length; end++) {
        if (body[end] === "(") depth++;
        else if (body[end] === ")" && --depth === 0) break;
      }
      found.push(body.slice(index + 2, end));
      index = end;
    }
  }
  return found;
};

/** Characters that are only ever part of a word, per dialect. */
const PLAIN_POSIX = /[^\s'"\\`$(){},<>|;&]+/uy;
const PLAIN_POWERSHELL = /[^\s'"`()<>|;&]+/uy;

/** Tokenize `command` into simple-command segments. */
export const segmentsOf = (command: string, dialect: ShellDialect = "posix"): Segment[] => {
  const posix = dialect === "posix";
  const segments: Segment[] = [];
  let current: Segment = { words: [], redirects: [] };
  let word = "";
  let inWord = false;
  let pending: "redirect" | "input" | "heredoc" | "herestring" | null = null;
  let backtick = false;
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
    else if (pending !== "input")
      current.words.push(...(MARKERS.test(word) ? expandBraces(word) : [word]));
    pending = null;
    word = "";
    inWord = false;
  };
  const flushSegment = () => {
    flushWord();
    if (current.words.length || current.redirects.length || current.stdin || current.subs)
      segments.push(current);
    current = { words: [], redirects: [] };
  };
  const group = (kind: "open" | "close") => {
    flushSegment();
    // `<(…)`, `>(…)`: the process substitution is not a file operand.
    pending = null;
    segments.push({ words: [], redirects: [], group: kind });
  };
  const plain = posix ? PLAIN_POSIX : PLAIN_POWERSHELL;
  for (let index = 0; index < command.length; index++) {
    // A run of characters no rule treats specially joins the word at once.
    plain.lastIndex = index;
    const run = plain.exec(command);
    if (run) {
      word += run[0];
      inWord = true;
      index += run[0].length - 1;
      continue;
    }
    const char = command[index];
    const next = command[index + 1];
    if (posix && char === "\\" && next === "\n") index++;
    else if (posix && char === "$" && next === "'") {
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
      word += unquote(body, char, dialect);
      inWord = true;
      index = end < 0 ? command.length : end;
    } else if (posix && char === "`") {
      group(backtick ? "close" : "open");
      backtick = !backtick;
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
    else if (char === "(" || char === ")") {
      // `$(` opens a command substitution: the `$` is not a word.
      if (char === "(" && inWord && word.endsWith("$")) {
        word = word.slice(0, -1);
        inWord = word !== "";
      }
      group(char === "(" ? "open" : "close");
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
      word += char;
      inWord = true;
    }
  }
  flushSegment();
  return segments;
};
