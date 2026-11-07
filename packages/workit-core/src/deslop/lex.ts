export type CommentStyle = "slash" | "hash" | "dash";

export type LexedComment = {
  line: number;
  endLine: number;
  /** The comment body without its delimiters. */
  text: string;
  block: boolean;
  /** `/**`, `///` or `//!`: a doc comment. */
  doc: boolean;
  /** Code precedes the comment on its first line. */
  trailing: boolean;
};

export type Lexed = {
  comments: LexedComment[];
  /** Each line's code with comments removed and string bodies blanked, 1-based. */
  code: string[];
};

const SLASH = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "scala",
  "dart",
  "php",
  "scss",
  "less",
  "css",
  "jsonc",
]);
const HASH = new Set([
  "py",
  "sh",
  "bash",
  "zsh",
  "fish",
  "yaml",
  "yml",
  "toml",
  "rb",
  "pl",
  "r",
  "ps1",
  "nix",
  "tf",
  "hcl",
]);
const DASH = new Set(["sql", "lua", "hs"]);
const HASH_NAMES = new Set(["dockerfile", "makefile", "containerfile", "justfile"]);
const REGEX_LANGUAGES = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]);
const TEMPLATE_LANGUAGES = new Set([...REGEX_LANGUAGES, "go"]);

export function commentStyle(file: string): CommentStyle | null {
  const base = file.split("/").at(-1)?.toLowerCase() ?? "";
  if (HASH_NAMES.has(base) || base.startsWith("dockerfile.")) return "hash";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  if (SLASH.has(ext)) return "slash";
  if (HASH.has(ext)) return "hash";
  if (DASH.has(ext)) return "dash";
  return null;
}

const extension = (file: string): string => {
  const base = file.split("/").at(-1)?.toLowerCase() ?? "";
  return base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
};

const REGEX_PRECEDERS = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_KEYWORDS = /\b(?:return|typeof|case|do|else|in|of|void|yield|await)$/;

/**
 * The comments of `source`, found without a parser per language. Strings,
 * template literals, regex literals and Python triple quotes are skipped, so
 * a `//` in a URL or a fixture string is never read as a comment. Null when
 * the file's language has no known comment syntax.
 */
export function lexComments(file: string, source: string): Lexed | null {
  const style = commentStyle(file);
  if (!style) return null;
  const ext = extension(file);
  const regexes = REGEX_LANGUAGES.has(ext);
  const templates = TEMPLATE_LANGUAGES.has(ext);
  const blocks = style === "slash";
  const python = ext === "py";
  const wordStartHash = style === "hash" && !python;
  const comments: LexedComment[] = [];
  const code: string[] = [""];
  let line = 1;
  let lineCode = "";
  let lastSignificant = "";
  const braces: number[] = [];
  let index = 0;

  const newline = () => {
    code[line] = lineCode;
    line += 1;
    lineCode = "";
  };
  const advanceOver = (text: string) => {
    for (const char of text) if (char === "\n") newline();
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1] ?? "";
    if (char === "\n") {
      newline();
      index += 1;
      continue;
    }
    const trailing = lineCode.trim() !== "";
    if (blocks && char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      const raw = source.slice(index + 2, stop);
      const doc = raw.startsWith("/") || raw.startsWith("!");
      comments.push({
        line,
        endLine: line,
        text: doc ? raw.slice(1) : raw,
        block: false,
        doc,
        trailing,
      });
      index = stop;
      continue;
    }
    if (blocks && char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      const raw = source.slice(index + 2, end === -1 ? source.length : end);
      const start = line;
      advanceOver(source.slice(index, stop));
      const doc = raw.startsWith("*") && !raw.startsWith("**");
      comments.push({
        line: start,
        endLine: line,
        text: raw
          .replace(/^\*/, "")
          .split("\n")
          .map((part) => part.replace(/^\s*\*?/, ""))
          .join("\n"),
        block: true,
        doc,
        trailing,
      });
      index = stop;
      continue;
    }
    const hashStart =
      style === "hash" &&
      char === "#" &&
      !(line === 1 && index === 0 && next === "!") &&
      (!wordStartHash || index === 0 || /\s/.test(source[index - 1]));
    if (hashStart || (style === "dash" && char === "-" && next === "-")) {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      comments.push({
        line,
        endLine: line,
        text: source.slice(index + (hashStart ? 1 : 2), stop),
        block: false,
        doc: false,
        trailing,
      });
      index = stop;
      continue;
    }
    if (python && (source.startsWith('"""', index) || source.startsWith("'''", index))) {
      const quote = source.slice(index, index + 3);
      const end = source.indexOf(quote, index + 3);
      const stop = end === -1 ? source.length : end + 3;
      advanceOver(source.slice(index, stop));
      lineCode += '""';
      lastSignificant = '"';
      index = stop;
      continue;
    }
    if (char === '"' || char === "'" || (char === "`" && templates)) {
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== char) {
        if (source[cursor] === "\\") cursor += 1;
        else if (char !== "`" && source[cursor] === "\n") break;
        else if (char === "`" && source[cursor] === "$" && source[cursor + 1] === "{") break;
        cursor += 1;
      }
      const opensExpression = char === "`" && source.startsWith("${", cursor);
      const stop = opensExpression ? cursor + 2 : Math.min(cursor + 1, source.length);
      advanceOver(source.slice(index, stop));
      lineCode += `${char}${char}`;
      lastSignificant = char;
      if (opensExpression) braces.push(0);
      index = stop;
      continue;
    }
    if (braces.length > 0 && (char === "{" || char === "}")) {
      if (char === "{") braces[braces.length - 1] += 1;
      else if (braces.at(-1) === 0) {
        braces.pop();
        index = resumeTemplate(index + 1);
        continue;
      } else braces[braces.length - 1] -= 1;
    }
    if (
      regexes &&
      char === "/" &&
      (lastSignificant === "" ||
        REGEX_PRECEDERS.has(lastSignificant) ||
        REGEX_KEYWORDS.test(lineCode.trimEnd()))
    ) {
      let cursor = index + 1;
      let inClass = false;
      while (cursor < source.length && source[cursor] !== "\n") {
        const current = source[cursor];
        if (current === "\\") cursor += 1;
        else if (current === "[") inClass = true;
        else if (current === "]") inClass = false;
        else if (current === "/" && !inClass) break;
        cursor += 1;
      }
      if (source[cursor] === "/") {
        lineCode += "/regex/";
        lastSignificant = "/";
        index = cursor + 1;
        continue;
      }
    }
    lineCode += char;
    if (!/\s/.test(char)) lastSignificant = char;
    index += 1;
  }
  code[line] = lineCode;
  return { comments, code };

  function resumeTemplate(from: number): number {
    let cursor = from;
    while (cursor < source.length && source[cursor] !== "`") {
      if (source[cursor] === "\\") cursor += 1;
      else if (source[cursor] === "$" && source[cursor + 1] === "{") {
        advanceOver(source.slice(from, cursor + 2));
        braces.push(0);
        return cursor + 2;
      }
      cursor += 1;
    }
    const stop = Math.min(cursor + 1, source.length);
    advanceOver(source.slice(from, stop));
    lineCode += "``";
    lastSignificant = "`";
    return stop;
  }
}
