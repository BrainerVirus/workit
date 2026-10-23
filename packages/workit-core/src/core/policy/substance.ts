// Is a changed file cosmetic (#333, review finding mvkcoxgb)? Each side of
// the file is reduced to its substance by a small lexer that knows the
// file's strings and comments: comments drop out, whitespace outside strings
// is normalized, strings stay verbatim. Equal substance on both sides is a
// cosmetic change. The lexer fails closed: a syntax it does not know keeps
// its comments, an indentation-sensitive or unknown type keeps all but
// trailing whitespace, and anything it cannot read (invalid UTF-8, a NUL
// byte, an unterminated string or comment, a regex across lines) is
// substantive.

type Syntax = {
  /** Line comment openers. */
  line: readonly string[];
  /** Block comment delimiters (not nested). */
  block: readonly (readonly [string, string])[];
  /** String quotes with backslash escapes. */
  quotes: string;
  /** String quotes without escapes (TOML literal strings). */
  literal?: string;
  /** `"""` and `'''` strings. */
  triple?: boolean;
  /** JavaScript template literals with `${}` and regex literals. */
  js?: boolean;
  /** Go raw strings in backticks. */
  rawBacktick?: boolean;
  /** Strings may span lines (SQL). */
  multiline?: boolean;
  /** Only trailing whitespace is cosmetic (indentation matters). */
  indented?: boolean;
};

const SLASH_BLOCK = [["/*", "*/"]] as const;
const C_LIKE: Syntax = { line: ["//"], block: SLASH_BLOCK, quotes: `"'` };
const SYNTAXES: Record<string, Syntax> = Object.fromEntries([
  // Not jsx or tsx: JSX text (`don't`, `</a>`) is no lexable string or regex.
  ...["ts", "mts", "cts", "js", "mjs", "cjs"].map((ext) => [ext, { ...C_LIKE, js: true }]),
  ...["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "m", "mm", "cs"].map((ext) => [ext, C_LIKE]),
  ...["java", "kt", "kts", "scala", "swift", "dart", "groovy"].map((ext) => [
    ext,
    { ...C_LIKE, triple: true },
  ]),
  ["go", { ...C_LIKE, rawBacktick: true }],
  ["rs", { ...C_LIKE, quotes: `"` }],
  ...["css", "scss", "less"].map((ext) => [ext, { line: [], block: SLASH_BLOCK, quotes: `"'` }]),
  ...["py", "pyi"].map((ext) => [
    ext,
    { line: ["#"], block: [], quotes: `"'`, triple: true, indented: true },
  ]),
  ["toml", { line: ["#"], block: [], quotes: `"`, literal: "'", triple: true }],
  ["sql", { line: ["--"], block: SLASH_BLOCK, quotes: `'"`, multiline: true }],
  ...["html", "htm", "xml", "svg", "xhtml"].map((ext) => [
    ext,
    // Text and <pre> whitespace can matter: only trailing whitespace is cosmetic.
    { line: [], block: [["<!--", "-->"]], quotes: "", indented: true },
  ]),
]);

/** Comments that steer a compiler, linter, bundler or runtime are code. */
const DIRECTIVE =
  /@ts-|eslint|prettier|biome|oxlint|istanbul|\bc8\b|\bv8\b|@jsx|@flow|@vite|webpack|__PURE__|__NO_SIDE_EFFECTS__|source(?:Mapping)?URL|^\/\s*<|go:|\+build|nolint|noqa|type:|pyright|mypy|pylint|pragma|coding[:=]|fmt:|NOSONAR|@license|@preserve|@refresh|environment|language=|cython|ruff|isort|deno-|@vitest|@jest|swiftlint|ktlint|checkstyle|suppress|nullable|#(?:end)?region/iu;

const extensionOf = (file: string): string => {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** CI and workflow definitions are read as written: their comments are never stripped. */
const CI_PATH =
  /^\.github\/|(?:^|\/)(?:\.gitlab-ci\.ya?ml|Jenkinsfile|azure-pipelines\.ya?ml|\.pre-commit-config\.ya?ml|\.circleci\/.*)$/u;

/** The syntax `file` is lexed with; null keeps comments and all but trailing whitespace. */
const syntaxOf = (file: string): Syntax | null =>
  CI_PATH.test(file) ? null : (SYNTAXES[extensionOf(file)] ?? null);

const SPACE = /[ \t\r\f\v]/u;
const WORD = /[\w$]/u;
const NO_SPACE_AFTER = "([{,;";
const NO_SPACE_BEFORE = ")]},;";
const REGEX_AFTER = "(,=:[!&|?{};+-*%<>~^";
const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);

type Frame = { kind: "code"; braces: number } | { kind: "template" };

/**
 * The substance of `text` for `file`: what stays after comments and
 * insignificant whitespace are removed. Null when it cannot be read with
 * certainty (the caller then counts the file as a behavior change).
 */
export function substanceOf(file: string, text: string): string | null {
  const syntax = syntaxOf(file);
  if (!syntax) return plainSubstance(text);
  const markup = syntax.block.some(([open]) => open === "<!--");
  // Markup with scripts, styles, CDATA or processing instructions holds
  // other languages; a comment opener after anything but a tag end may sit
  // in an attribute value.
  if (
    markup &&
    (/<(?:script|style)\b|<!\[CDATA\[|<\?/iu.test(text) || /[^>\s][ \t]*<!--/u.test(text))
  )
    return plainSubstance(text);
  return lex(syntax, text);
}

/** No lexer: only trailing whitespace and blank lines are cosmetic. */
function plainSubstance(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+$/u, ""))
    .filter(Boolean)
    .join("\n");
}

function lex(syntax: Syntax, text: string): string | null {
  const collapse = !syntax.indented;
  let out = "";
  let lineStart = 0;
  /** Output before this index is string content: trailing-space trimming stops there. */
  let kept = 0;
  let pendingSpace = false;
  const frames: Frame[] = [{ kind: "code", braces: 0 }];
  let index = 0;

  // A shebang line is code, read as written.
  if (text.startsWith("#!")) {
    const end = text.indexOf("\n");
    out = end < 0 ? text : text.slice(0, end);
    kept = out.length;
    index = end < 0 ? text.length : end;
  }

  const emitCode = (chunk: string) => {
    if (collapse && pendingSpace && out.length > lineStart) {
      const before = out[out.length - 1];
      if (!NO_SPACE_AFTER.includes(before) && !NO_SPACE_BEFORE.includes(chunk[0])) out += " ";
    }
    pendingSpace = false;
    out += chunk;
  };
  const emitVerbatim = (chunk: string) => {
    emitCode(chunk);
    kept = out.length;
  };
  const newline = () => {
    if (!collapse) {
      let end = out.length;
      while (end > Math.max(lineStart, kept) && SPACE.test(out[end - 1])) end -= 1;
      out = out.slice(0, end);
    }
    pendingSpace = false;
    if (out.length > lineStart) {
      out += "\n";
      lineStart = out.length;
    }
  };
  /** Can a `/` start a regex here? After an operator or a keyword, not after a value. */
  const regexAllowed = (): boolean => {
    let end = out.length;
    while (end > 0 && /\s/u.test(out[end - 1])) end -= 1;
    if (end === 0 || REGEX_AFTER.includes(out[end - 1])) return true;
    let start = end;
    while (start > 0 && WORD.test(out[start - 1])) start -= 1;
    return REGEX_KEYWORDS.has(out.slice(start, end));
  };
  /** Scan a quoted string from `index`; returns false when it does not close. */
  const scanString = (quote: string, escapes: boolean, multiline: boolean): boolean => {
    let end = index + quote.length;
    while (end < text.length) {
      const char = text[end];
      if (escapes && char === "\\") {
        end += 2;
        continue;
      }
      if (text.startsWith(quote, end)) {
        emitVerbatim(text.slice(index, end + quote.length));
        index = end + quote.length;
        return true;
      }
      if (char === "\n" && !multiline) return false;
      end += 1;
    }
    return false;
  };

  while (index < text.length) {
    const frame = frames[frames.length - 1];
    const char = text[index];
    if (frame.kind === "template") {
      if (char === "\\") {
        emitVerbatim(text.slice(index, index + 2));
        index += 2;
      } else if (char === "`") {
        emitVerbatim(char);
        frames.pop();
        index += 1;
      } else if (text.startsWith("${", index)) {
        emitVerbatim("${");
        frames.push({ kind: "code", braces: 0 });
        index += 2;
      } else {
        // Template text, newlines included, is the string's value.
        out += char;
        kept = out.length;
        index += 1;
      }
      continue;
    }
    if (char === "\n") {
      newline();
      index += 1;
      continue;
    }
    if (SPACE.test(char)) {
      if (collapse) pendingSpace = true;
      else out += char;
      index += 1;
      continue;
    }
    const lineOpener = syntax.line.find((opener) => text.startsWith(opener, index));
    if (lineOpener) {
      const end = text.indexOf("\n", index);
      const comment = text.slice(index, end < 0 ? text.length : end);
      if (DIRECTIVE.test(comment.slice(lineOpener.length))) emitVerbatim(comment);
      else pendingSpace = true;
      index = end < 0 ? text.length : end;
      continue;
    }
    const block = syntax.block.find(([open]) => text.startsWith(open, index));
    if (block) {
      const end = text.indexOf(block[1], index + block[0].length);
      if (end < 0) return null;
      const comment = text.slice(index, end + block[1].length);
      if (DIRECTIVE.test(comment.slice(block[0].length, -block[1].length))) emitVerbatim(comment);
      else pendingSpace = true;
      // A newline inside the comment still ends the code line before it.
      if (comment.includes("\n")) newline();
      index = end + block[1].length;
      continue;
    }
    if (syntax.triple && (char === '"' || char === "'") && text.startsWith(char.repeat(3), index)) {
      if (!scanString(char.repeat(3), !syntax.literal?.includes(char), true)) return null;
      continue;
    }
    if (syntax.quotes.includes(char)) {
      if (!scanString(char, true, Boolean(syntax.multiline))) return null;
      continue;
    }
    if (syntax.literal?.includes(char)) {
      if (!scanString(char, false, false)) return null;
      continue;
    }
    if (syntax.rawBacktick && char === "`") {
      if (!scanString("`", false, true)) return null;
      continue;
    }
    if (syntax.js && char === "`") {
      emitVerbatim(char);
      frames.push({ kind: "template" });
      index += 1;
      continue;
    }
    if (syntax.js && char === "/" && regexAllowed()) {
      let end = index + 1;
      let inClass = false;
      while (end < text.length && (inClass || text[end] !== "/")) {
        if (text[end] === "\n") return null;
        if (text[end] === "\\") end += 1;
        else if (text[end] === "[") inClass = true;
        else if (text[end] === "]") inClass = false;
        end += 1;
      }
      if (end >= text.length) return null;
      emitVerbatim(text.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    if (frames.length > 1 && frame.kind === "code") {
      if (char === "{") frame.braces += 1;
      else if (char === "}") {
        if (frame.braces === 0) {
          emitVerbatim(char);
          frames.pop();
          index += 1;
          continue;
        }
        frame.braces -= 1;
      }
    }
    emitCode(char);
    index += 1;
  }
  if (frames.length !== 1) return null;
  newline();
  return out;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The UTF-8 text of `bytes`, or null for binary (a NUL byte) or invalid UTF-8. */
export function textOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** Is the change from `before` to `after` of `file` cosmetic (equal substance)? */
export function cosmeticChange(file: string, before: Uint8Array, after: Uint8Array): boolean {
  const left = textOf(before);
  const right = textOf(after);
  if (left === null || right === null) return false;
  const a = substanceOf(file, left);
  return a !== null && a === substanceOf(file, right);
}
