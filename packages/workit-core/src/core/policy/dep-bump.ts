// Dependency manifests for the `dependency-bump` classification (#891): a
// diff limited to manifest version pins, lockfiles, a changelog and new
// package.json scripts is the Renovate/Dependabot case, which lands on the
// self lane with green CI on the head as its evidence (see lane.ts).
//
// Each manifest is read on both sides and fails closed: a change this cannot
// tell is a version move (a new or removed dependency, a git, path, URL or
// alias source, any other field, a file that does not parse) is no pin bump.
//
//   package.json   JSON: a version range of an existing dependency in
//                  dependencies, devDependencies, peerDependencies or
//                  optionalDependencies, and new `scripts` entries that are
//                  no lifecycle or pre/post hook
//   go.mod         the version of an existing `require`
//   Cargo.toml     line for line: a version in a dependency table
//   pyproject.toml line for line: a version in a dependency list or table

export type ManifestEdit = {
  /** Only version pins moved (and, in package.json, scripts were added). */
  pins: boolean;
  /** How many dependency versions moved. */
  bumped: number;
  /** New package.json scripts. */
  scripts: string[];
  /** Why it is no pin bump; empty when it is. */
  why: string;
};

const MANIFESTS = new Set(["package.json", "go.mod", "Cargo.toml", "pyproject.toml"]);

const basename = (file: string): string => file.slice(file.lastIndexOf("/") + 1);

export const isManifest = (file: string): boolean => MANIFESTS.has(basename(file));

const refused = (why: string): ManifestEdit => ({ pins: false, bumped: 0, scripts: [], why });
const pinned = (bumped: number, scripts: string[] = []): ManifestEdit => ({
  pins: true,
  bumped,
  scripts,
  why: "",
});

const DEP_FIELDS = new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]);
/** One comparator of an npm range (`^1.2.3`, `>=1.0.0`, `1.x`): no repetition to backtrack. */
const NPM_COMPARATOR =
  /^(?:[~^]|[<>]=?|=)?v?\d+(?:\.(?:\d+|x|\*)){0,2}(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/iu;

/**
 * An npm version or range: `||`-separated sets of whitespace-separated
 * comparators (an operator may stand apart from its version), or a hyphen
 * range. No tag, alias, path, git or URL source. Each piece is matched alone,
 * so a long or hostile string is read in linear time.
 */
function npmVersion(spec: string): boolean {
  if (spec.length > 256) return false;
  return spec.split("||").every((set) => {
    const tokens = set
      .trim()
      .replace(/([<>]=?|=|[~^])\s+/gu, "$1")
      .split(/\s+/u);
    if (tokens.length === 3 && tokens[1] === "-")
      return NPM_COMPARATOR.test(tokens[0] ?? "") && NPM_COMPARATOR.test(tokens[2] ?? "");
    return tokens.every((token) => NPM_COMPARATOR.test(token));
  });
}
/** Scripts npm runs on its own (lifecycle) or around another script (pre/post). */
const HOOK_SCRIPT =
  /^(?:pre|post)|^(?:install|uninstall|prepare|publish|pack|version|dependencies|start|stop|restart|test)$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function packageJson(before: string, after: string): ManifestEdit {
  let old: unknown;
  let now: unknown;
  try {
    old = JSON.parse(before);
    now = JSON.parse(after);
  } catch {
    return refused("does not parse");
  }
  if (!isRecord(old) || !isRecord(now)) return refused("is no JSON object");
  let bumped = 0;
  const scripts: string[] = [];
  for (const field of new Set([...Object.keys(old), ...Object.keys(now)])) {
    const a = old[field];
    const b = now[field];
    if (same(a, b)) continue;
    if (DEP_FIELDS.has(field)) {
      if (!isRecord(a) || !isRecord(b)) return refused(`changes ${field}`);
      for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (a[name] === b[name]) continue;
        if (!(name in a)) return refused(`adds the dependency ${name}`);
        if (!(name in b)) return refused(`removes the dependency ${name}`);
        const from = a[name];
        const to = b[name];
        if (typeof from !== "string" || typeof to !== "string")
          return refused(`changes ${field}.${name}`);
        if (!npmVersion(from.trim()) || !npmVersion(to.trim()))
          return refused(`changes the source of ${name}`);
        bumped += 1;
      }
    } else if (field === "scripts") {
      if (!isRecord(a) || !isRecord(b)) return refused("changes scripts");
      for (const name of Object.keys(a))
        if (a[name] !== b[name]) return refused(`changes the script ${name}`);
      for (const name of Object.keys(b)) {
        if (name in a) continue;
        if (HOOK_SCRIPT.test(name)) return refused(`adds the lifecycle script ${name}`);
        if (name.startsWith("pnpm:")) return refused(`adds the pnpm: script ${name}`);
        const runner = Object.entries(a).find(
          ([, command]) => typeof command === "string" && runsByGlob(command, name),
        );
        if (runner)
          return refused(`adds the script ${name}, which the script ${runner[0]} runs by glob`);
        scripts.push(name);
      }
    } else return refused(`changes ${field}`);
  }
  return pinned(bumped, scripts);
}

/**
 * Whether `command` may run a new script `name` by pattern: any `*` token
 * that matches it (`run-s "lint:*"`, `concurrently npm:lint:*`, `yarn run
 * lint:*`; a leading `npm:`, `pnpm:`, `yarn:` or `bun:` is dropped), or a
 * pnpm `/regex/` (not evaluated here, so any new script counts). A token that
 * is no script pattern (`'src/**\/*.ts'`) matches no script name.
 */
function runsByGlob(command: string, name: string): boolean {
  const tokens = command.split(/\s+/u).map((token) =>
    token
      .replace(/^--filter=/u, "")
      .replaceAll(/^["']|["']$/gu, "")
      .replace(/^(?:npm|pnpm|yarn|bun):/u, ""),
  );
  if (/\bpnpm\b/u.test(command) && tokens.some((token) => /^\/.+\/$/u.test(token))) return true;
  return tokens.filter((token) => token.includes("*")).some((glob) => globMatches(glob, name));
}

/**
 * Whether `name` matches `glob`, where only `*` is special. Each literal part
 * between stars takes its leftmost place after the one before (#918): no
 * backtracking, so a many-star glob stays cheap.
 */
function globMatches(glob: string, name: string): boolean {
  const parts = glob.split("*");
  const first = parts[0];
  const last = parts.at(-1) ?? "";
  const end = name.length - last.length;
  if (end < first.length || !name.startsWith(first) || !name.endsWith(last)) return false;
  let at = first.length;
  for (const part of parts.slice(1, -1)) {
    const found = name.indexOf(part, at);
    if (found < 0 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

type GoDirective = { verb: string; args: string; indirect: boolean };

/** go.mod directives, a block's entries flattened under its verb; null when unreadable. */
function goDirectives(text: string): GoDirective[] | null {
  const out: GoDirective[] = [];
  let block: string | null = null;
  for (const raw of text.split("\n")) {
    const indirect = /\/\/\s*indirect\s*$/u.test(raw);
    const line = raw.replace(/\/\/.*$/u, "").trim();
    if (!line) continue;
    if (block !== null) {
      if (line === ")") block = null;
      else out.push({ verb: block, args: line.replace(/\s+/gu, " "), indirect });
      continue;
    }
    const match = /^(\S+)\s*(.*)$/u.exec(line);
    if (!match) return null;
    const [, verb = "", rest = ""] = match;
    if (rest === "(") block = verb;
    else out.push({ verb, args: rest.replace(/\s+/gu, " "), indirect });
  }
  return block === null ? out : null;
}

const GO_VERSION = /^v\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+incompatible)?$/u;

function goMod(before: string, after: string): ManifestEdit {
  const old = goDirectives(before);
  const now = goDirectives(after);
  if (!old || !now) return refused("does not parse");
  if (old.length !== now.length) return refused("adds or removes a directive");
  let bumped = 0;
  for (const [index, a] of old.entries()) {
    const b = now[index];
    if (a.verb === b.verb && a.args === b.args && a.indirect === b.indirect) continue;
    if (a.verb !== "require" || b.verb !== "require" || a.indirect !== b.indirect)
      return refused(`changes ${a.verb}`);
    const [module, from, extra] = a.args.split(" ");
    const [moduleAfter, to, extraAfter] = b.args.split(" ");
    if (module !== moduleAfter || extra !== undefined || extraAfter !== undefined)
      return refused(`changes require ${module ?? ""}`);
    if (!GO_VERSION.test(from ?? "") || !GO_VERSION.test(to ?? ""))
      return refused(`changes the source of ${module ?? ""}`);
    bumped += 1;
  }
  return pinned(bumped);
}

/** A TOML table that lists dependencies, by manifest. */
const CARGO_TABLE = /^(?:workspace\.)?(?:target\..+\.)?(?:dev-|build-)?dependencies(?:\.[^.]+)?$/u;
const PYPROJECT_TABLE =
  /^(?:project\.optional-dependencies|dependency-groups|tool\.poetry\.(?:dev-)?dependencies|tool\.poetry\.group\.[^.]+\.dependencies)$/u;
/** A source other than a registry version: never a pin bump. */
const OTHER_SOURCE = /\b(?:git|rev|branch|tag|path|url|registry|package)\s*=|@|:\/\//u;
/** A version number where one starts: after a quote, an operator, `=`, a comma or a space. */
const VERSION_TOKEN = /(?<=[\s"'=<>~^!,*v])\d+(?:\.\d+)*(?:[a-z]+\d*)?(?:\.(?:post|dev)\d+)?/giu;

/**
 * Cargo.toml or pyproject.toml, line for line: the same lines, and each
 * changed one sits in a dependency table (or pyproject's `dependencies`
 * array) and differs only in its version numbers.
 */
function tomlPins(before: string, after: string, cargo: boolean): ManifestEdit {
  const old = before.split("\n");
  const now = after.split("\n");
  if (old.length !== now.length) return refused("adds or removes lines");
  let table = "";
  let inArray = false;
  let bumped = 0;
  for (const [index, a] of old.entries()) {
    const b = now[index] ?? "";
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/u.exec(a);
    if (header) {
      table = (header[1] ?? "").replace(/\s+/gu, "");
      inArray = false;
    } else if (!cargo && table === "project" && /^\s*dependencies\s*=\s*\[\s*(?:#.*)?$/u.test(a))
      inArray = true;
    else if (inArray && /^\s*\]/u.test(a)) inArray = false;
    if (a === b) continue;
    const listed = cargo
      ? CARGO_TABLE.test(table)
      : PYPROJECT_TABLE.test(table) ||
        inArray ||
        (table === "project" && /^\s*dependencies\s*=/u.test(a));
    if (header || !listed) return refused(`changes line ${index + 1} outside a dependency table`);
    if (OTHER_SOURCE.test(a) || OTHER_SOURCE.test(b))
      return refused(`changes a dependency source on line ${index + 1}`);
    const key = (line: string) => /^\s*("?[\w.[\],-]+"?)/u.exec(line)?.[1] ?? "";
    const versionless = (line: string) => line.replace(VERSION_TOKEN, "V");
    // pyproject: the requirement names in a line's strings (`"rich==13.7"` reads `rich`).
    const names = (line: string) =>
      cargo ? "" : [...line.matchAll(/"([A-Za-z_][\w.-]*)/gu)].map((match) => match[1]).join(",");
    if (key(a) !== key(b) || names(a) !== names(b) || versionless(a) !== versionless(b))
      return refused(`changes more than a version on line ${index + 1}`);
    bumped += 1;
  }
  return pinned(bumped);
}

/** How `file` (a manifest, see isManifest) changed from `before` to `after`. */
export function manifestEdit(file: string, before: string, after: string): ManifestEdit {
  const name = basename(file);
  if (name === "package.json") return packageJson(before, after);
  if (name === "go.mod") return goMod(before, after);
  return tomlPins(before, after, name === "Cargo.toml");
}
