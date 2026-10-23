// `linguist-generated` from the `.gitattributes` files of one tree (#333,
// review finding mvkcoxgb). The review lane reads them from the base
// revision only: never `.git/info/attributes`, a global attributes file or
// the working tree, so a change cannot mark its own code generated. What this
// parser does not understand (quoted patterns, macros, directory patterns)
// marks nothing generated, which only raises a lane.

type Rule = { regex: RegExp; generated: boolean };

/** A gitattributes pattern relative to `dir` ("" for the root) as a regex over repo paths. */
function patternRegex(dir: string, pattern: string): RegExp | null {
  if (!pattern || pattern.endsWith("/") || pattern.startsWith('"') || pattern.startsWith("!"))
    return null;
  const anchored = pattern.includes("/");
  const body = pattern.replace(/^\//u, "");
  let source = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "*" && body[index + 1] === "*") {
      const slash = body[index + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      index += slash ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[") {
      const end = body.indexOf("]", index + 2);
      if (end < 0) return null;
      const set = body
        .slice(index + 1, end)
        .replace(/^!/u, "^")
        .replace(/\\/gu, "\\\\");
      source += `[${set}]`;
      index = end;
    } else if (char === "\\" && index + 1 < body.length) {
      source += body[index + 1].replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
      index += 1;
    } else source += char.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
  }
  const prefix = dir ? `${dir.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/` : "";
  try {
    return new RegExp(anchored ? `^${prefix}${source}$` : `^${prefix}(?:.*/)?${source}$`, "u");
  } catch {
    return null;
  }
}

/** The `linguist-generated` rules of one `.gitattributes` file in `dir`. */
function rulesOf(dir: string, text: string): Rule[] {
  const out: Rule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("[attr]")) continue;
    const [pattern, ...attributes] = line.split(/\s+/u);
    let generated: boolean | null = null;
    for (const attribute of attributes) {
      if (attribute === "linguist-generated" || attribute === "linguist-generated=true")
        generated = true;
      else if (
        attribute === "-linguist-generated" ||
        attribute === "!linguist-generated" ||
        attribute.startsWith("linguist-generated=")
      )
        generated = false;
    }
    if (generated === null) continue;
    const regex = patternRegex(dir, pattern);
    if (regex) out.push({ regex, generated });
  }
  return out;
}

/**
 * Of `paths`, those the `.gitattributes` files of one tree mark
 * `linguist-generated` (`files`: each file's repo path and text). A deeper
 * file overrides a shallower one, and a later line an earlier one.
 */
export function generatedByAttributes(
  files: ReadonlyMap<string, string>,
  paths: readonly string[],
): Set<string> {
  const rules = [...files]
    .map(([file, text]) => {
      const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
      return {
        depth: dir ? dir.split("/").length : 0,
        rules: rulesOf(dir, text),
      };
    })
    .toSorted((left, right) => left.depth - right.depth)
    .flatMap((entry) => entry.rules);
  const out = new Set<string>();
  for (const file of paths) {
    const last = rules.findLast((rule) => rule.regex.test(file));
    if (last?.generated) out.add(file);
  }
  return out;
}
