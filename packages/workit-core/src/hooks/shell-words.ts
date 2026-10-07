// A small shell tokenizer shared by the hooks: quoted words, operators,
// redirects and heredoc bodies. Pure string parsing, no I/O.
export type Segment = { words: string[]; redirects: string[] };

/** A small shell tokenizer: quoted words, operators, redirects and heredoc bodies. */
export const segmentsOf = (command: string): Segment[] => {
  const segments: Segment[] = [];
  let current: Segment = { words: [], redirects: [] };
  let word = "";
  let inWord = false;
  let pending: "redirect" | "input" | "heredoc" | null = null;
  const heredocs: string[] = [];
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
      const end = command.indexOf(char, index + 1);
      word += command.slice(index + 1, end < 0 ? undefined : end);
      inWord = true;
      index = end < 0 ? command.length : end;
    } else if (char === "\\" && index + 1 < command.length) {
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
    else if (";&|()".includes(char)) {
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
    } else if (char === "<") {
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
