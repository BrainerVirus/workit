// A small shell tokenizer shared by the hooks: quoted words, operators,
// redirects, heredoc bodies and `( … )` group markers. Pure string parsing,
// no I/O. Two dialects:
//   - posix (Bash, sh, zsh): `\` escapes, '…' is literal, "…" honors `\"`;
//   - powershell (Claude Code's PowerShell tool): `\` is a path separator,
//     the backtick escapes, '…' is literal with '' for a quote, "…" honors `".
export type Segment = {
  words: string[];
  redirects: string[];
  /** A `(`/`$(` group starts or ends here; the segment carries no words. */
  group?: "open" | "close";
};

export type ShellDialect = "posix" | "powershell";

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
  return dialect === "posix" ? body.replace(/\\(["\\$`])/g, "$1") : body.replace(/`(.)/g, "$1");
};

/** Tokenize `command` into simple-command segments. */
export const segmentsOf = (command: string, dialect: ShellDialect = "posix"): Segment[] => {
  const segments: Segment[] = [];
  let current: Segment = { words: [], redirects: [] };
  let word = "";
  let inWord = false;
  let pending: "redirect" | "input" | "heredoc" | null = null;
  const heredocs: string[] = [];
  const escape = dialect === "posix" ? "\\" : "`";
  const flushWord = () => {
    if (!inWord) return;
    if (pending === "redirect") {
      if (!word.startsWith("&")) current.redirects.push(word);
    } else if (pending === "heredoc") heredocs.push(word.replace(/^-/, ""));
    else if (pending !== "input") current.words.push(word);
    pending = null;
    word = "";
    inWord = false;
  };
  const flushSegment = () => {
    flushWord();
    if (current.words.length || current.redirects.length) segments.push(current);
    current = { words: [], redirects: [] };
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === "'" || char === '"') {
      const end = closingQuote(command, index, dialect);
      word += unquote(command.slice(index + 1, end < 0 ? undefined : end), char, dialect);
      inWord = true;
      index = end < 0 ? command.length : end;
    } else if (char === escape && index + 1 < command.length) {
      word += command[++index];
      inWord = true;
    } else if (char === "\n") {
      flushSegment();
      // Skip heredoc bodies up to each delimiter line.
      while (heredocs.length) {
        const delimiter = heredocs.shift()!;
        const lines = command.slice(index + 1).split("\n");
        const at = lines.findIndex((line) => line.trim() === delimiter);
        const skipped = (at < 0 ? lines : lines.slice(0, at + 1)).join("\n").length + 1;
        index += skipped;
      }
    } else if (/\s/.test(char)) flushWord();
    else if (char === "(" || char === ")") {
      // `$(` opens a command substitution: the `$` is not a word.
      if (char === "(" && inWord && word.endsWith("$")) {
        word = word.slice(0, -1);
        inWord = word !== "";
      }
      flushSegment();
      segments.push({ words: [], redirects: [], group: char === "(" ? "open" : "close" });
    } else if (";&|".includes(char)) {
      if (char === "&" && command[index + 1] === ">") continue;
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
    } else if (char === "<" && dialect === "posix") {
      flushWord();
      if (command[index + 1] === "<") {
        index++;
        if (command[index + 1] === "<") index++;
        pending = "heredoc";
      } else pending = "input";
    } else {
      word += char;
      inWord = true;
    }
  }
  flushSegment();
  return segments;
};
