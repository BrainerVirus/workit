// Scope path containment with globs (#647). A scope path covers itself and
// everything under what it matches: `docs` covers `docs/x`, `packages/**`
// covers `packages/x/src/**`, `apps/*` covers `apps/web/app/**`. An inner
// glob counts as contained only when every path it can match is: `**` or a
// wildcard segment on the inside is matched by `**` or the same segment on
// the outside, never by a narrower pattern.

const GLOB = /[*?[\]{}]/u;

const segmentRegex = (pattern: string): RegExp => {
  let out = "";
  let braces = 0;
  for (const char of pattern) {
    if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else if (char === "{") {
      braces += 1;
      out += "(?:";
    } else if (char === "}" && braces > 0) {
      braces -= 1;
      out += ")";
    } else if (char === "," && braces > 0) out += "|";
    else out += char.replace(/[.+^$()|\\[\]{}]/u, "\\$&");
  }
  // An unclosed brace is a literal character elsewhere; here it never matches.
  if (braces > 0) return /$^/u;
  return new RegExp(`^${out}$`, "u");
};

const segmentCovers = (outer: string, inner: string): boolean => {
  if (outer === inner) return true;
  // A wildcard inside is wider than any outer pattern other than itself.
  if (GLOB.test(inner) || !GLOB.test(outer)) return false;
  return segmentRegex(outer).test(inner);
};

const prefixCovers = (outer: readonly string[], inner: readonly string[]): boolean => {
  if (outer.length === 0) return true;
  if (outer[0] === "**") {
    for (let skip = 0; skip <= inner.length; skip += 1)
      if (prefixCovers(outer.slice(1), inner.slice(skip))) return true;
    return false;
  }
  if (inner.length === 0) return false;
  return segmentCovers(outer[0], inner[0]) && prefixCovers(outer.slice(1), inner.slice(1));
};

/** Whether scope path `outer` (a path or glob) covers `inner` and everything under it. */
export function scopePathCovers(outer: string, inner: string): boolean {
  if (outer === "." || outer === inner || inner.startsWith(`${outer}/`)) return true;
  if (!GLOB.test(outer)) return false;
  const split = (value: string) => value.split("/").filter((part) => part !== "" && part !== ".");
  return prefixCovers(split(outer), split(inner));
}
