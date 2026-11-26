// The read-only allowlists for Windows shells under strict confinement (#880):
// a PowerShell statement (a `pwsh -c` script or the PowerShell tool) or a
// `cmd /c` statement passes only when its command is a known read. Pure
// string checks over the statements `segmentsOf(…, "powershell")` splits.
import { segmentsOf, type Segment } from "./shell-words";

/** Cmdlets that only read, beyond the read-only verb families below. */
const READ_CMDLETS = new Set([
  "foreach-object",
  "out-string",
  "out-null",
  "out-host",
  "write-output",
  "write-host",
  "write-verbose",
  "write-warning",
  "write-error",
  "write-debug",
  "write-information",
  "test-path",
  "test-json",
  "resolve-path",
  "convert-path",
  "join-path",
  "split-path",
  "compare-object",
  "group-object",
  "set-location",
  "push-location",
  "pop-location",
  "help",
]);

/** Verb families that only read: `Get-*`, `Select-*`, `Where-*`, `Measure-*`, `Sort-*`, `Format-*`, `ConvertFrom-*`, `ConvertTo-*`. */
const READ_VERBS = /^(?:get|select|where|measure|sort|format|convertfrom|convertto)-/;

/**
 * PowerShell's default aliases and alias-like functions, by the cmdlet they
 * run: a read alias passes, any other names the cmdlet that counts.
 */
const ALIASES: Record<string, string> = {
  "?": "where-object",
  "%": "foreach-object",
  foreach: "foreach-object",
  where: "where-object",
  cat: "get-content",
  gc: "get-content",
  type: "get-content",
  cd: "set-location",
  chdir: "set-location",
  sl: "set-location",
  pushd: "push-location",
  popd: "pop-location",
  pwd: "get-location",
  gl: "get-location",
  dir: "get-childitem",
  ls: "get-childitem",
  gci: "get-childitem",
  gi: "get-item",
  gp: "get-itemproperty",
  gpv: "get-itempropertyvalue",
  gcm: "get-command",
  gm: "get-member",
  gal: "get-alias",
  gv: "get-variable",
  gmo: "get-module",
  gps: "get-process",
  ps: "get-process",
  gsv: "get-service",
  gdr: "get-psdrive",
  gcb: "get-clipboard",
  gin: "get-computerinfo",
  gtz: "get-timezone",
  gu: "get-unique",
  ghy: "get-history",
  h: "get-history",
  history: "get-history",
  gjb: "get-job",
  gerr: "get-error",
  select: "select-object",
  sls: "select-string",
  sort: "sort-object",
  measure: "measure-object",
  group: "group-object",
  compare: "compare-object",
  diff: "compare-object",
  fl: "format-list",
  ft: "format-table",
  fw: "format-wide",
  fc: "format-custom",
  fhx: "format-hex",
  echo: "write-output",
  write: "write-output",
  oh: "out-host",
  rvpa: "resolve-path",
  cvpa: "convert-path",
  man: "help",
  // Writers.
  ac: "add-content",
  sc: "set-content",
  clc: "clear-content",
  cli: "clear-item",
  clp: "clear-itemproperty",
  clv: "clear-variable",
  copy: "copy-item",
  cp: "copy-item",
  cpi: "copy-item",
  cpp: "copy-itemproperty",
  del: "remove-item",
  erase: "remove-item",
  rd: "remove-item",
  ri: "remove-item",
  rm: "remove-item",
  rmdir: "remove-item",
  rp: "remove-itemproperty",
  rv: "remove-variable",
  mi: "move-item",
  move: "move-item",
  mv: "move-item",
  mp: "move-itemproperty",
  ren: "rename-item",
  rni: "rename-item",
  rnp: "rename-itemproperty",
  ni: "new-item",
  md: "new-item",
  mkdir: "new-item",
  mount: "new-psdrive",
  ndr: "new-psdrive",
  nal: "new-alias",
  nv: "new-variable",
  nmo: "new-module",
  si: "set-item",
  sp: "set-itemproperty",
  sv: "set-variable",
  set: "set-variable",
  sal: "set-alias",
  scb: "set-clipboard",
  epal: "export-alias",
  epcsv: "export-csv",
  ipal: "import-alias",
  ipmo: "import-module",
  ipcsv: "import-csv",
  tee: "tee-object",
  start: "start-process",
  saps: "start-process",
  sajb: "start-job",
  sleep: "start-sleep",
  ii: "invoke-item",
  icm: "invoke-command",
  iex: "invoke-expression",
  ihy: "invoke-history",
  r: "invoke-history",
  irm: "invoke-restmethod",
  iwr: "invoke-webrequest",
  kill: "stop-process",
  spps: "stop-process",
  ogv: "out-gridview",
};

/** Statement keywords: their blocks are statements of their own. */
const KEYWORDS =
  /^(?:if|elseif|else|switch|while|do|until|for|foreach|try|catch|finally|return|break|continue|exit|throw|param|begin|process|end)$/;

/** Native programs that write on Windows (any `x.exe`, a script path or `x.bat` counts too). */
const WINDOWS_WRITERS =
  /^(?:xcopy|robocopy|attrib|icacls|cacls|takeown|compact|cipher|expand|extrac32|makecab|fsutil|reg|regedit|setx|schtasks|msiexec|certutil|bitsadmin|replace|subst|mountvol|format|diskpart|wsl|cscript|wscript|mshta|rundll32|regsvr32|call)$/;

/** Methods that only compute a value (a string's, a collection's): any other method call may write. */
const READ_METHODS =
  /^(?:trim(?:start|end)?|split|contains(?:key|value)?|startswith|endswith|substring|(?:last)?indexof(?:any)?|to(?:lower|upper)(?:invariant)?|tostring|tochararray|pad(?:left|right)|equals|compareto|gettype|gethashcode|normalize|where)$/i;

/** What `ForEach-Object <name>` may name: a read method or a common property. */
const READ_MEMBERS =
  /^(?:name|fullname|basename|extension|length|count|directory|directoryname|parent|root|exists|mode|lastwritetime(?:utc)?|creationtime(?:utc)?|lastaccesstime(?:utc)?|attributes|linktype|target|pspath|pschildname|path|line|linenumber|filename|matches|value|key|keys|values|id|processname|source|definition|version)$/i;

/**
 * Environment names that change what a program runs or loads: git's
 * (`GIT_PAGER`, `GIT_DIR`, `GIT_SSH_COMMAND`…), ssh's askpass, a pager or
 * editor, the search paths (`PATH`, `PATHEXT`, `PSModulePath`, `NODE_PATH`),
 * a dynamic loader's, an interpreter's or runtime's startup options (Node,
 * Bun, Python, Perl, Ruby, the JVM, .NET), cargo's and rustc's wrappers,
 * npm's config, a shell's startup file or prompt hook. Matched in any case on
 * every platform: Git Bash, PowerShell and cmd read Windows names that way.
 */
export const LOADER_ENV =
  /^(?:GIT_\w*|SSH_ASKPASS(?:_REQUIRE)?|PAGER|EDITOR|VISUAL|PATH|PATHEXT|PSModulePath|LD_\w*|DYLD_\w*|NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|npm_config_\w*|PYTHON\w*|BASH_ENV|ENV|PROMPT_COMMAND|PERL5(?:OPT|LIB)|RUBY(?:OPT|LIB)|RUSTC_(?:WORKSPACE_)?WRAPPER|CARGO_\w*|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|DOTNET_STARTUP_HOOKS|COMPLUS_\w*|CORECLR_\w*)$/i;

/**
 * Names that point git or its pager at config or code Workit does not read:
 * a home dir's `.gitconfig` (`HOME`, `USERPROFILE`, `HOMEDRIVE`/`HOMEPATH`),
 * git/config under an `XDG_*` dir, `LESSOPEN`. A judge's git is denied after one.
 */
export const GIT_CONFIG_ENV = /^(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|XDG_\w+|LESS\w*)$/i;

/** An assignment word whose loader value runs nothing: no pager, no lock (worktree-confine.ts judgeGit). */
export const EXEMPT_LOADER = /^(?:(?:GIT_)?PAGER=cat|GIT_OPTIONAL_LOCKS=0)$/;

/** A cmd variable reference: `%X%`, or `!X!` under delayed expansion. */
export const CMD_VAR = /%[^%\s]+%|![^!\s]+!/;

/** A redirect that writes nothing. */
const NULL_SINK = /^(?:\$null|nul|\/dev\/null)$/i;

/**
 * PowerShell code with its comments and string literals reduced to `S`, a
 * double-quoted string's `$(…)` kept: what runs, for the text checks.
 */
const pwshCode = (text: string): string => {
  let out = "";
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    const here = char === "@" && /['"]/.test(text[at + 1] ?? "") ? text[at + 1] : null;
    if (char === "<" && text[at + 1] === "#") {
      const end = text.indexOf("#>", at + 2);
      at = end < 0 ? text.length : end + 1;
    } else if (char === "#" && (at === 0 || /[\s;|{(]/.test(text[at - 1])))
      for (; at < text.length && text[at] !== "\n"; at++);
    else if (here !== null || char === "'" || char === '"') {
      const quote = here ?? char;
      const close = here === null ? quote : `\n${quote}@`;
      let end = at + (here === null ? 1 : 2);
      const kept: string[] = [];
      while (end < text.length && !text.startsWith(close, end)) {
        if (quote === '"' && text[end] === "`") end++;
        else if (quote === "'" && here === null && text.startsWith("''", end)) end++;
        else if (quote === '"' && text.startsWith("$(", end)) {
          let depth = 0;
          const start = end;
          for (; end < text.length; end++)
            if (text[end] === "(") depth++;
            else if (text[end] === ")" && --depth === 0) break;
          kept.push(text.slice(start, end + 1));
        }
        end++;
      }
      out += `S${kept.join(" ")}`;
      at = end + close.length - 1;
    } else out += char;
  }
  return out;
};

/**
 * Why PowerShell code is a writer whatever its commands, computed once per
 * script: the call operator, a .NET static call, a method call outside the
 * reads, a member set, a `function:` or `alias:` drive.
 */
export const powershellTextWriter = (text: string): string | null => {
  const code = pwshCode(text);
  // `&` runs a command, a script or a script block; `&&` chains and `2>&1` merges.
  if (/(?<![&>])&(?![&>])/.test(code)) return "&";
  // A static member on any receiver: a type literal, or a type held in `$t` or `$_`.
  const statics = /([^\s;|{(]*)\s*::\s*(\w*)/.exec(code);
  if (statics) return `${statics[1]}::${statics[2]}`;
  // An environment that changes what a later program runs or loads.
  for (const [, name] of code.matchAll(/\$\{?env:(\w+)\}?\s*[-+]?=/gi))
    if (LOADER_ENV.test(name) || GIT_CONFIG_ENV.test(name)) return `$env:${name} =`;
  for (const [, name] of code.matchAll(/\.([A-Za-z_]\w*)\(/g))
    if (!READ_METHODS.test(name)) return `.${name}()`;
  const member = /\.([A-Za-z_]\w*)\s*[-+*/%]?=/.exec(code);
  if (member) return `.${member[1]} =`;
  // `$function:f = '…'` defines a command from text.
  const drive = /\$\{?(function|alias):/i.exec(code);
  return drive ? `$${drive[1]}:` : null;
};

/** The `$(…)` subexpressions inside one word (a double-quoted string). */
const subexpressions = (word: string): string[] => {
  const found: string[] = [];
  for (let at = word.indexOf("$("); at >= 0; at = word.indexOf("$(", at + 1)) {
    let depth = 0;
    let end = at + 1;
    for (; end < word.length; end++)
      if (word[end] === "(") depth++;
      else if (word[end] === ")" && --depth === 0) break;
    found.push(word.slice(at + 2, end));
  }
  return found;
};

/** The cmdlet a PowerShell command word names, an alias resolved; null for a native program or an expression. */
const cmdletOf = (name: string): string | null => {
  // PowerShell reads an en or em dash as `-`.
  const lower = name.toLowerCase().replace(/[\u2013-\u2015]/g, "-");
  if (ALIASES[lower] !== undefined) return ALIASES[lower];
  return /^[a-z]+-[a-z0-9]+$/.test(lower) ? lower : null;
};

/** Whether a cmdlet only reads. */
const readCmdlet = (cmdlet: string): boolean => READ_VERBS.test(cmdlet) || READ_CMDLETS.has(cmdlet);

/**
 * Why one PowerShell statement may write, naming its command; null when it
 * is a known read: a read cmdlet or alias, an expression, a keyword, a nested
 * `pwsh`/`cmd` (judged on its own) or a native program the shell analysis
 * judges. A script path, a dot-source, a redirection, a writer cmdlet or
 * alias, a function definition and a `ForEach-Object` member outside the
 * reads count.
 */
const pwshStatementWriter = (
  segment: Segment,
  depth: number,
  prev?: Segment,
  next?: Segment,
): string | null => {
  if (segment.redirects.some((file) => !NULL_SINK.test(file))) return ">";
  let words = segment.words;
  // `$x = <command>`, `$x=<command>`, `[int]$x += …`: the command after the assignment.
  const glued = /^((?:\[[^\]]*\])*\$[^=\s]+)[-+*/%?]?=(.+)$/s.exec(words[0] ?? "");
  if (glued) words = [glued[2], ...words.slice(1)];
  else if (/^(?:\[[^\]]*\])*\$/.test(words[0] ?? "") && /^[-+*/%?]?=$/.test(words[1] ?? ""))
    words = words.slice(2);
  for (const word of words)
    for (const inner of depth < 4 ? subexpressions(word) : [])
      if (/\S/.test(inner)) {
        const why = pwshScriptWriter(inner, depth + 1);
        if (why) return why;
      }
  const first = words[0];
  if (first === undefined) return null;
  if (first === ".") return ". (dot-source)";
  // `%COMSPEC% /c …`: a command named by a variable.
  if (CMD_VAR.test(first)) return first;
  // A variable, an array, a cast, a number, a string, a parameter after a group, a member.
  if (/^[$@(['"\d-]/.test(first) || /^\.[A-Za-z_]/.test(first)) return null;
  // A path (`./x.ps1`, `C:\x.exe`, `function:f`) or a file name (`x.bat`, `git.exe`).
  if (/[\\/:.]/.test(first)) return first;
  const lower = first.toLowerCase();
  // `foreach (…) {…}` is the loop; piped into, `foreach` is ForEach-Object.
  if (KEYWORDS.test(lower) && (lower !== "foreach" || (words.length === 1 && !prev?.pipe)))
    return null;
  if (/^(?:function|filter|class|enum|workflow|configuration)$/.test(lower)) return first;
  if (/^(?:pwsh|powershell|cmd)$/.test(lower)) return null;
  const cmdlet = cmdletOf(first);
  if (cmdlet === null) return WINDOWS_WRITERS.test(lower) ? first : null;
  if (!readCmdlet(cmdlet)) return first;
  // `ForEach-Object Delete`, `% -MemberName MoveTo`: a member call by name.
  if (cmdlet === "foreach-object") {
    // `% ("De" + "lete")`: a member named by an expression.
    if (next?.group === "open") return `${first} (…)`;
    for (const arg of words.slice(1))
      if (
        !arg.startsWith("-") &&
        !/^\d+$/.test(arg) &&
        !READ_MEMBERS.test(arg) &&
        !READ_METHODS.test(arg)
      )
        return `${first} ${arg}`;
  }
  return null;
};

/** Why a PowerShell script may write (its first writer), else null. */
const pwshScriptWriter = (script: string, depth = 0): string | null => {
  const why = powershellTextWriter(script);
  if (why) return why;
  const segments = segmentsOf(script, "powershell");
  for (const [at, segment] of segments.entries()) {
    const statement = pwshStatementWriter(segment, depth, segments[at - 1], segments[at + 1]);
    if (statement) return statement;
  }
  return null;
};

/** cmd builtins and programs that only read (`set` only displays, `echo` only prints). */
const CMD_READS = /^(?:dir|type|echo|cd|chdir|set|where|findstr|find|ver|vol|tree|more|rem)$/;

/** Why one `cmd /c` statement may write, naming its command; null for a read-only builtin. */
const cmdStatementWriter = (segment: Segment): string | null => {
  if (segment.redirects.some((file) => !NULL_SINK.test(file))) return ">";
  const [first, ...args] = segment.words;
  if (first === undefined) return null;
  // `@echo off`, `echo.`, `echo:`: the builtin before its punctuation.
  const name = first
    .replace(/^@/, "")
    .toLowerCase()
    .replace(/^(echo)[.:(/\\].*$/, "$1");
  if (!CMD_READS.test(name)) return first;
  // `set X=1`, `set /a`, `set /p` change a variable; `set` and `set PREFIX` print.
  if (name === "set" && args.some((arg) => arg.includes("=") || /^\/[ap]$/i.test(arg)))
    return first;
  return null;
};

/**
 * Per statement of a Windows script under strict confinement: why it may
 * write, naming its command, else null. `cmd` reads a `cmd /c` script, else
 * PowerShell; `text` is the whole script, whose call operator, .NET static
 * call, method call or member set makes every statement a writer; `prev`
 * and `next` are the statements around it.
 */
export const windowsStatementWriter = (
  segment: Segment,
  cmd: boolean,
  text: string | null,
  prev?: Segment,
  next?: Segment,
): string | null =>
  cmd ? cmdStatementWriter(segment) : (text ?? pwshStatementWriter(segment, 0, prev, next));
